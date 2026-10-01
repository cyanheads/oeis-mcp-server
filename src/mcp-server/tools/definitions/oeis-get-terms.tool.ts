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

export const oeisGetTerms = tool('oeis_get_terms', {
  title: 'Get OEIS Sequence Terms',
  description:
    "List terms a(n) of a sequence with their indices n. Reads the entry's b-file when it has one — often thousands of terms beyond the data line — and otherwise the data line itself. Values are exact decimal strings of any size.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aNumber: ANumberSchema,
    fromIndex: blankAsUnset(z.number().int().optional()).describe(
      'First index n to return; defaults to the first available index. Pass nextFromIndex from the previous call to continue.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(1000).default(100)).describe(
      'Maximum number of terms to return, 1–1000 (default 100).',
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
      .describe('Terms in index order, starting at fromIndex (or the first available index).'),
    firstAvailableIndex: z
      .number()
      .optional()
      .describe('Lowest index n read for this entry; absent when OEIS publishes no terms.'),
    lastAvailableIndex: z
      .number()
      .optional()
      .describe(
        'Highest index n read for this entry (within the first 1 MiB of a b-file); absent when OEIS publishes no terms.',
      ),
    nextFromIndex: z
      .number()
      .optional()
      .describe(
        'Pass as fromIndex for the next slice; absent when no further terms were read past this one.',
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
        'True when the b-file is larger than the 1 MiB this server reads, so terms past lastAvailableIndex exist at bFileUrl.',
      ),
    url: z.string().describe('Sequence page on oeis.org; cite it wherever the terms are reused.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more terms were read than this slice shows.'),
    shown: z.number().describe('Terms in this slice.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance: where the next slice starts, why no terms came back, or that the terms are data-line only or cut at 1 MiB.',
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
    const bFile = knownWithoutBFile ? undefined : await service.getBFile(aNumber, ctx);

    let terms: BFileTerm[];
    if (bFile?.status === 'ok') {
      terms = bFile.terms;
    } else {
      const record =
        cached ??
        (await service.getRecord(aNumber, ctx, {
          deadlineMs: Math.max(0, DEFAULT_DEADLINE_MS - (Date.now() - startedAt)),
        }));
      if (!record) {
        throw ctx.fail('sequence_not_found', `OEIS has no entry ${aNumber}.`, { aNumber });
      }
      terms = record.terms.map((value, i) => ({ n: record.firstIndex + i, value }));
    }
    const source: 'bfile' | 'data' = bFile?.status === 'ok' ? 'bfile' : 'data';
    const bFileCut = bFile?.status === 'ok' && bFile.cut;

    const found = fromIndex === undefined ? 0 : terms.findIndex((term) => term.n >= fromIndex);
    const begin = found === -1 ? terms.length : found;
    const slice = terms.slice(begin, begin + limit);
    const next = terms[begin + limit];
    const first = terms[0];
    const last = terms.at(-1);
    ctx.enrich({ shown: slice.length });

    const notices: string[] = [];
    if (!last) notices.push('OEIS publishes no terms for this entry.');
    if (last && fromIndex !== undefined && fromIndex > last.n) {
      notices.push(
        `No terms at n ≥ ${fromIndex} in what OEIS publishes for this entry; the last available index is ${last.n}.`,
      );
    }
    if (bFileCut && last) {
      notices.push(
        `Only the first 1 MiB of the b-file was read; terms past n = ${last.n} are at ${bFileUrl(aNumber)}.`,
      );
    }
    if (source === 'data') {
      notices.push('This entry has no b-file; these are the data-line terms only.');
    }
    if (next) {
      notices.push(`More terms follow; call again with fromIndex ${next.n}.`);
      ctx.enrich.truncated({ shown: slice.length, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      aNumber,
      source,
      terms: slice,
      ...(first && { firstAvailableIndex: first.n }),
      ...(last && { lastAvailableIndex: last.n }),
      ...(next && { nextFromIndex: next.n }),
      ...(source === 'bfile' && { bFileUrl: bFileUrl(aNumber) }),
      ...(bFile?.status === 'ok' &&
        bFile.sizeInBytes !== undefined && { bFileSizeInBytes: bFile.sizeInBytes }),
      bFileCut,
      url: `https://oeis.org/${aNumber}`,
    };
  },

  format: (result) => {
    const lines = [
      `# ${result.aNumber} terms`,
      '',
      `**Source:** ${result.source === 'bfile' ? 'bfile (the b-file of extended terms)' : 'data (the data line; this entry has no b-file)'}`,
      result.firstAvailableIndex === undefined
        ? '**First available index:** none (OEIS publishes no terms)'
        : `**First available index:** ${result.firstAvailableIndex}`,
    ];
    if (result.lastAvailableIndex !== undefined) {
      lines.push(`**Last available index:** ${result.lastAvailableIndex}`);
    }
    if (result.bFileUrl) lines.push(`**b-file:** ${result.bFileUrl}`);
    if (result.bFileSizeInBytes !== undefined) {
      lines.push(`**b-file size:** ${result.bFileSizeInBytes} bytes`);
    }
    lines.push(
      `**b-file cut at 1 MiB:** ${result.bFileCut ? 'yes, later terms exist at the b-file URL' : 'no'}`,
      `**URL:** ${result.url}`,
      '',
      '## Terms',
      '',
      result.terms.length
        ? result.terms.map((term) => `a(${term.n}) = ${inline(term.value)}`).join('\n')
        : 'None in this slice.',
    );
    if (result.nextFromIndex !== undefined) {
      lines.push('', `**Next slice:** call again with fromIndex ${result.nextFromIndex}.`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
