/**
 * @fileoverview oeis_get_terms — lists terms a(n) with their indices from an entry's b-file, or
 * from its data line when the entry has no b-file.
 * @module mcp-server/tools/definitions/oeis-get-terms
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inline } from '@/mcp-server/shared/markdown.js';
import { ANumberSchema, blankAsUnset } from '@/mcp-server/shared/oeis-schemas.js';
import { bFileUrl, DEFAULT_DEADLINE_MS, getOeisService } from '@/services/oeis/oeis-service.js';
import type { BFileTerm } from '@/services/oeis/types.js';

/** Most bytes one response carries: the `format()` text plus the structured JSON. */
const RESPONSE_BUDGET_BYTES = 100_000;
/** Held back from the budget for everything in a response except the term lines and objects. */
const FIXED_RESERVE_BYTES = 4_000;
const encoder = new TextEncoder();

/** One term as `format()` renders it. */
function termLine(term: BFileTerm): string {
  return `a(${term.n}) = ${inline(term.value)}`;
}

/**
 * A term's share of a response: its rendered line and its JSON object, plus 3 for their separators
 * on the wire (the line's newline, 2 bytes once JSON-escaped, and the array comma).
 */
function termBytes(term: BFileTerm): number {
  return encoder.encode(termLine(term)).length + encoder.encode(JSON.stringify(term)).length + 3;
}

/** The leading terms of `window` that fit the response budget; always at least one. */
function fitToBudget(window: BFileTerm[]): BFileTerm[] {
  let spent = FIXED_RESERVE_BYTES;
  let count = 0;
  for (const term of window) {
    spent += termBytes(term);
    if (count > 0 && spent > RESPONSE_BUDGET_BYTES) break;
    count++;
  }
  return window.slice(0, count);
}

export const oeisGetTerms = tool('oeis_get_terms', {
  title: 'Get OEIS Sequence Terms',
  description:
    "List terms a(n) of a sequence with their indices n. Reads the entry's b-file when it has one — often thousands of terms beyond the data line — and otherwise the data line itself. Values are exact decimal strings of any size. A slice stops at limit terms, at about 100,000 bytes, or at the end of one 1 MiB part of a larger b-file, whichever comes first; nextFromIndex continues it.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aNumber: ANumberSchema,
    fromIndex: blankAsUnset(z.number().int().optional()).describe(
      'First index n to return; defaults to the first available index. Pass nextFromIndex from the previous call to continue.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(1000).default(100)).describe(
      'Maximum number of terms to return, 1–1000 (default 100). A slice stops sooner at about 100,000 bytes of large terms or at the end of one 1 MiB part of a larger b-file; continue with nextFromIndex.',
    ),
  }),
  output: z.object({
    aNumber: z.string().describe('A-number, e.g. "A000045".'),
    source: z
      .enum(['bfile', 'data'])
      .describe(
        "bfile: read from the entry's b-file of extended terms. data: the entry has no b-file, so these are its data-line terms.",
      ),
    terms: z
      .array(
        z
          .object({
            n: z.number().describe('The index n.'),
            value: z.string().describe('a(n) as an exact decimal string, sign kept.'),
          })
          .describe('One term.'),
      )
      .describe(
        'Terms in index order, from the first index at or after fromIndex (or the first available index).',
      ),
    firstAvailableIndex: z
      .number()
      .optional()
      .describe('Lowest index n read for this entry; absent when no terms were read.'),
    lastAvailableIndex: z
      .number()
      .optional()
      .describe(
        'Highest index n read so far for this entry; when bFileCut is true the b-file goes on past it. Absent when no terms were read.',
      ),
    nextFromIndex: z
      .number()
      .optional()
      .describe(
        'Pass as fromIndex for the next slice. Absent when no slice follows this one: the terms ended, or the notice says how to reach the rest.',
      ),
    bFileUrl: z
      .string()
      .optional()
      .describe('URL of the b-file the terms came from; absent when source is data.'),
    bFileSizeInBytes: z
      .number()
      .optional()
      .describe('Full size of the b-file as OEIS reported it; absent when not reported.'),
    bFileCut: z
      .boolean()
      .describe(
        'True while the b-file goes on past lastAvailableIndex. Its later terms are at bFileUrl; nextFromIndex or a larger fromIndex reaches them unless the notice says only the first 1 MiB was read.',
      ),
    url: z.string().describe('Sequence page on oeis.org; cite it wherever the terms are reused.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when nextFromIndex is set.'),
    shown: z.number().describe('Terms in this slice.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance: where the next slice starts and whether the byte budget ended this one, why no terms came back (past the last index, or not yet reached in a large b-file), that a b-file line too long to read was skipped, that only the first 1 MiB of the b-file could be read, or that the terms are data-line only.',
      ),
  },
  errors: [
    {
      reason: 'sequence_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No OEIS entry exists for the requested A-number.',
      recovery:
        'No OEIS entry has this A-number; find the right one with oeis_search_sequences or oeis_identify_sequence.',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The oeis.org request queue would exceed its wait budget.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org requests are paced to one every 10 seconds and the queue is backed up; wait the retryAfter seconds in the error data (30 seconds if none is shown), then call oeis_get_terms again.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'oeis.org answered HTTP 429 Too Many Requests on the b-file or the record and retries within the call did not clear it.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org answered 429 Too Many Requests; wait as long as the retryAfter in the error data says (seconds, or an HTTP date), or 30 seconds if none is shown, then call oeis_get_terms again.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });
    const { aNumber, fromIndex, limit } = input;
    const service = getOeisService();
    const startedAt = Date.now();

    const cached = service.getCachedRecord(aNumber);
    const knownWithoutBFile = cached !== undefined && !cached.bFileUrl;
    const bFile = knownWithoutBFile
      ? undefined
      : await service.getBFile(aNumber, ctx, { fromIndex });

    const read = bFile?.status === 'ok' ? bFile : undefined;
    let terms: BFileTerm[];
    let first: number | undefined;
    let last: number | undefined;
    if (read) {
      ({ terms, firstIndex: first, lastIndex: last } = read);
    } else {
      const record = await service.getRecord(aNumber, ctx, {
        deadlineMs: Math.max(0, DEFAULT_DEADLINE_MS - (Date.now() - startedAt)),
      });
      if (!record) {
        throw ctx.fail('sequence_not_found', `OEIS has no entry ${aNumber}.`, { aNumber });
      }
      // A reserved or recycled A-number has no offset, so its data line has no indices.
      const { firstIndex } = record;
      terms =
        firstIndex === undefined
          ? []
          : record.terms.map((value, i) => ({ n: firstIndex + i, value }));
      first = terms[0]?.n;
      last = terms.at(-1)?.n;
    }
    const source: 'bfile' | 'data' = read ? 'bfile' : 'data';
    const bFileCut = read?.cut === true;

    const found = fromIndex === undefined ? 0 : terms.findIndex((term) => term.n >= fromIndex);
    const begin = found === -1 ? terms.length : found;
    const window = terms.slice(begin, begin + limit);
    const slice = fitToBudget(window);
    // A slice that reaches the end of a b-file page continues in the next page.
    const next = terms[begin + slice.length]?.n ?? (slice.length > 0 ? read?.nextIndex : undefined);
    ctx.enrich({ shown: slice.length });

    const notices: string[] = [];
    if (last === undefined) {
      notices.push(
        bFileCut
          ? `Only the first 1 MiB of the b-file was read, and it holds no terms; the rest of the file is at ${bFileUrl(aNumber)}.`
          : 'OEIS publishes no terms for this entry.',
      );
    }
    if (last !== undefined && fromIndex !== undefined && fromIndex > last && !bFileCut) {
      notices.push(
        `No terms at n ≥ ${fromIndex} in what OEIS publishes for this entry; the last available index is ${last}.`,
      );
    }
    if (read?.unreached) {
      notices.push(
        `n = ${fromIndex} lies outside the parts of the b-file read so far; call again with fromIndex ${fromIndex} to read further, or read the whole file at ${bFileUrl(aNumber)}.`,
      );
    }
    if (read?.firstMibOnly && last !== undefined) {
      notices.push(
        `Only the first 1 MiB of the b-file was read; terms past n = ${last} are at ${bFileUrl(aNumber)}.`,
      );
    }
    if (read?.skippedLine && terms[0]) {
      notices.push(
        `The b-file line just before n = ${terms[0].n} is longer than 4 KiB and spans two of the 1 MiB parts the file is read in, so it was skipped; it is at ${bFileUrl(aNumber)}.`,
      );
    }
    if (source === 'data') {
      notices.push('This entry has no b-file; these are the data-line terms only.');
    }
    if (next !== undefined) {
      notices.push(
        slice.length < window.length
          ? `Stopped after ${slice.length} ${slice.length === 1 ? 'term' : 'terms'} to stay within the 100,000-byte response budget; call again with fromIndex ${next}.`
          : `More terms follow; call again with fromIndex ${next}.`,
      );
      ctx.enrich.truncated({ shown: slice.length, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      aNumber,
      source,
      terms: slice,
      ...(first !== undefined && { firstAvailableIndex: first }),
      ...(last !== undefined && { lastAvailableIndex: last }),
      ...(next !== undefined && { nextFromIndex: next }),
      ...(source === 'bfile' && { bFileUrl: bFileUrl(aNumber) }),
      ...(read?.sizeInBytes !== undefined && { bFileSizeInBytes: read.sizeInBytes }),
      bFileCut,
      url: `https://oeis.org/${aNumber}`,
    };
  },

  format: (result) => {
    const lines = [
      `# ${result.aNumber} terms`,
      '',
      `**Source:** ${result.source === 'bfile' ? 'bfile (the b-file of extended terms)' : 'data (the data line; this entry has no b-file)'}`,
      `**First available index:** ${
        result.firstAvailableIndex ??
        (result.bFileCut
          ? 'none in the first 1 MiB of the b-file'
          : 'none (OEIS publishes no terms)')
      }`,
    ];
    if (result.lastAvailableIndex !== undefined) {
      lines.push(`**Last available index:** ${result.lastAvailableIndex}`);
    }
    if (result.bFileUrl) lines.push(`**b-file:** ${result.bFileUrl}`);
    if (result.bFileSizeInBytes !== undefined) {
      lines.push(`**b-file size:** ${result.bFileSizeInBytes} bytes`);
    }
    lines.push(
      `**b-file continues past the last available index:** ${result.bFileCut ? 'yes, later terms exist at the b-file URL' : 'no'}`,
      `**URL:** ${result.url}`,
      '',
      '## Terms',
      '',
      result.terms.length ? result.terms.map(termLine).join('\n') : 'None in this slice.',
    );
    if (result.nextFromIndex !== undefined) {
      lines.push('', `**Next slice:** call again with fromIndex ${result.nextFromIndex}.`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
