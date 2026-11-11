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

/** Most terms one call returns; a larger `limit` is served at this. */
const MAX_TERMS = 1000;
export const oeisGetTerms = tool('oeis_get_terms', {
  title: 'Get OEIS Sequence Terms',
  description:
    "List terms a(n) of a sequence with their indices n. Reads the entry's b-file when it has one — often thousands of terms beyond the data line — and otherwise the data line itself. Values are exact decimal strings of any size. A slice returns up to limit terms (at most 1000 per call) and may read the next b-file part to fill it. Pass nextFromIndex to continue.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aNumber: ANumberSchema,
    fromIndex: blankAsUnset(z.number().int().optional()).describe(
      'First index n to return; defaults to the first available index. Pass nextFromIndex from the previous call to continue.',
    ),
    limit: blankAsUnset(z.number().int().min(1).default(100)).describe(
      'Maximum number of terms to return (default 100). One call returns at most 1000, so a larger limit is served as 1000. A slice can end early when fewer terms are available to this call. Pass nextFromIndex to continue.',
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
        'Highest index n read so far for this entry; when bFileCut is true the b-file may contain terms beyond it. Absent when no terms were read.',
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
        'True when the b-file may contain terms beyond lastAvailableIndex. Follow nextFromIndex or the notice to check, or consult bFileUrl.',
      ),
    url: z.string().describe('Sequence page on oeis.org; cite it wherever the terms are reused.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when nextFromIndex is set.'),
    shown: z.number().describe('Terms in this slice.'),
    cap: z.number().describe('The limit that was applied: limit, or 1000 when limit is larger.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on continuing the slice, a short or empty slice, skipped b-file lines, the b-file read bounds, or data-line-only terms.',
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
    {
      reason: 'upstream_unparseable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'oeis.org answered with a body that is not a b-file or a sequence record (an HTML maintenance page, a b-file with no n a(n) line, or a record in an unknown shape) and retries within the call did not clear it.',
      thrownBy: 'service',
      recovery:
        'oeis.org returned a page this server cannot read, often during site maintenance; wait a minute, then call oeis_get_terms again, or read the data-line terms with oeis_get_sequence.',
    },
  ],

  async handler(input, ctx) {
    const limit = Math.min(input.limit, MAX_TERMS);
    ctx.enrich({ truncated: false, shown: 0, cap: limit });
    const { aNumber, fromIndex } = input;
    const service = getOeisService();
    const startedAt = Date.now();
    /** Time left on the deadline shared by all upstream reads. */
    const remainingMs = () => Math.max(0, DEFAULT_DEADLINE_MS - (Date.now() - startedAt));

    const cached = service.getCachedRecord(aNumber);
    const knownWithoutBFile = cached !== undefined && !cached.bFileUrl;
    const bFile = knownWithoutBFile
      ? undefined
      : await service.getBFile(aNumber, ctx, { fromIndex, limit, deadlineMs: remainingMs() });

    let read = bFile?.status === 'ok' ? bFile : undefined;
    let dataLine: BFileTerm[] = [];
    if (!read) {
      const record = await service.getRecord(aNumber, ctx, { deadlineMs: remainingMs() });
      if (!record) {
        throw ctx.fail('sequence_not_found', `OEIS has no entry ${aNumber}.`, { aNumber });
      }
      // A record that lists the b-file outranks the miss just read; getRecord dropped a cached one.
      if (bFile?.status === 'missing' && record.bFileUrl) {
        const again = await service.getBFile(aNumber, ctx, {
          fromIndex,
          limit,
          deadlineMs: remainingMs(),
        });
        if (again.status === 'ok') read = again;
      }
      // A reserved or recycled A-number has no offset, so its data line has no indices.
      const { firstIndex } = record;
      if (!read && firstIndex !== undefined) {
        dataLine = record.terms.map((value, i) => ({ n: firstIndex + i, value }));
      }
    }
    const terms = read?.terms ?? dataLine;
    const first = read ? read.firstIndex : dataLine[0]?.n;
    const last = read ? read.lastIndex : dataLine.at(-1)?.n;
    const source: 'bfile' | 'data' = read ? 'bfile' : 'data';
    const bFileCut = read?.cut === true;

    const found = fromIndex === undefined ? 0 : terms.findIndex((term) => term.n >= fromIndex);
    const begin = found === -1 ? terms.length : found;
    const slice = terms.slice(begin, begin + limit);
    const nextTerm = terms[begin + slice.length];
    // A slice that reaches the end of a b-file page continues in the next page.
    const next = nextTerm?.n ?? (slice.length > 0 ? read?.nextIndex : undefined);
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
    if (read?.malformedLines) {
      notices.push(
        read.malformedLines === 1
          ? `The part of the b-file this slice comes from has 1 line that is not an n a(n) pair; it was skipped, so a term may be missing. The file is at ${bFileUrl(aNumber)}.`
          : `The part of the b-file this slice comes from has ${read.malformedLines} lines that are not n a(n) pairs; they were skipped, so terms may be missing. The file is at ${bFileUrl(aNumber)}.`,
      );
    }
    if (source === 'data') {
      notices.push('This entry has no b-file; these are the data-line terms only.');
    }
    if (read?.nextPartMalformedLines) {
      const count = read.nextPartMalformedLines;
      notices.push(
        count === 1
          ? `The next b-file part has 1 line that is not an n a(n) pair. It was skipped; the file is at ${bFileUrl(aNumber)}.`
          : `The next b-file part has ${count} lines that are not n a(n) pairs. They were skipped; the file is at ${bFileUrl(aNumber)}.`,
      );
    }
    if (read?.nextPartSkippedLine) {
      notices.push(
        `A b-file line at the next part boundary is longer than the 4 KiB overlap and could not be read whole. The file is at ${bFileUrl(aNumber)}.`,
      );
    }
    if (next !== undefined) {
      let continuation = `More terms follow; call again with fromIndex ${next}.`;
      if (read?.nextPartUnavailable) {
        continuation = `The next b-file part could not extend this slice; call again with fromIndex ${next}.`;
      } else if (input.limit > limit && nextTerm !== undefined) {
        // The per-call cap, not the caller's limit, ended a slice whose page goes on.
        continuation = `Stopped after ${limit} terms, the most one call returns (limit was ${input.limit}); call again with fromIndex ${next}.`;
      }
      notices.push(continuation);
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
      `**b-file may contain later terms:** ${result.bFileCut ? 'yes, see the b-file URL' : 'no'}`,
      `**URL:** ${result.url}`,
      '',
      '## Terms',
      '',
      result.terms.length
        ? result.terms.map(({ n, value }) => `a(${n}) = ${inline(value)}`).join('\n')
        : 'None in this slice.',
    );
    if (result.nextFromIndex !== undefined) {
      lines.push('', `**Next slice:** call again with fromIndex ${result.nextFromIndex}.`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
