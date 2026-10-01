/**
 * @fileoverview oeis_get_cross_refs — lists sequences related to an OEIS entry: the A-numbers its
 * cross-reference lines name (outgoing, resolved to names and terms one page at a time), or the
 * entries that mention it (incoming).
 * @module mcp-server/tools/definitions/oeis-get-cross-refs
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { blockquote, inline } from '@/mcp-server/shared/markdown.js';
import {
  ANumberSchema,
  blankAsUnset,
  MAX_START,
  PAGE_SIZE,
  pagedListEnrichment,
  pageStartSchema,
} from '@/mcp-server/shared/oeis-schemas.js';
import { DEFAULT_DEADLINE_MS, getOeisService } from '@/services/oeis/oeis-service.js';
import type { SequenceSummary } from '@/services/oeis/types.js';

const A_NUMBER = /\bA\d{6,7}(?!\d)/g;

/** Batch-lookup failures that degrade the page to unresolved rows instead of failing the call. */
const DEGRADING_CODES: ReadonlySet<JsonRpcErrorCode> = new Set([
  JsonRpcErrorCode.RateLimited,
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
]);

const DEFAULT_RETRY_AFTER_SECONDS = 10;

/** One distinct A-number named in an entry's cross-reference lines. */
interface OutgoingRef {
  aNumber: string;
  /** Index into the cross-reference lines of the first line naming it. */
  lineIndex: number;
  note?: string;
}

/** Outcome of resolving one page of A-numbers to summary rows. */
type NameResolution =
  | { kind: 'resolved'; rows: Map<string, SequenceSummary> }
  | { kind: 'degraded'; failure: string; retryAfterSeconds: number };

/** The parenthetical immediately after position `at` (spaces skipped, nesting balanced), if any. */
function noteAt(line: string, at: number): string | undefined {
  let open = at;
  while (line[open] === ' ') open++;
  if (line[open] !== '(') return;
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(open + 1, i).trim() || undefined;
  }
  return;
}

/**
 * The distinct A-numbers named in the cross-reference lines, in order of first appearance, without
 * the entry itself. A note is the first parenthetical written beside any mention of the A-number.
 */
function outgoingRefs(aNumber: string, lines: readonly string[]): OutgoingRef[] {
  const refs = new Map<string, OutgoingRef>();
  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(A_NUMBER)) {
      const ref = match[0];
      if (ref === aNumber) continue;
      const note = noteAt(line, match.index + ref.length);
      const known = refs.get(ref);
      if (!known) refs.set(ref, { aNumber: ref, lineIndex, ...(note && { note }) });
      else if (note && !known.note) known.note = note;
    }
  });
  return [...refs.values()];
}

/** Seconds a failure asks the caller to wait, from `data.retryAfter` (delta-seconds) when present. */
function retryAfterSeconds(err: McpError): number {
  const value = Number(err.data?.retryAfter);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Resolves one page of A-numbers to names and terms with a single `id:…|id:…` search. Once the
 * service's retries are spent, a rate limit, outage, or timeout degrades to unresolved rows; a
 * cancelled request and any other failure rethrow.
 */
async function resolveNames(
  refs: readonly OutgoingRef[],
  ctx: Context,
  deadlineMs: number,
): Promise<NameResolution> {
  try {
    const page = await getOeisService().search(
      { q: refs.map((ref) => `id:${ref.aNumber}`).join('|'), sort: 'relevance', start: 0 },
      ctx,
      { deadlineMs },
    );
    return { kind: 'resolved', rows: new Map(page.rows.map((row) => [row.aNumber, row])) };
  } catch (err) {
    if (ctx.signal.aborted || !(err instanceof McpError) || !DEGRADING_CODES.has(err.code)) {
      throw err;
    }
    const reason = typeof err.data?.reason === 'string' ? err.data.reason : err.message;
    ctx.log.warning('Cross-reference name lookup failed; returning unresolved rows', {
      code: err.code,
      reason,
    });
    return { kind: 'degraded', failure: reason, retryAfterSeconds: retryAfterSeconds(err) };
  }
}

const RelatedSchema = z
  .object({
    aNumber: z
      .string()
      .describe('Related A-number; pass it to oeis_get_sequence for the full entry.'),
    resolved: z
      .boolean()
      .describe(
        'True when name and terms were fetched. False when OEIS returned no record for this A-number or the lookup could not be made (see notice); name, terms, offset, firstIndex, and keywords are then absent.',
      ),
    name: z
      .string()
      .optional()
      .describe('Sequence name, written by OEIS contributors; absent when not resolved.'),
    terms: z
      .array(z.string())
      .optional()
      .describe('Data-line terms as exact decimal strings, signs kept; absent when not resolved.'),
    offset: z
      .string()
      .optional()
      .describe(
        'Offset "i,p": i is the index n of the first term, p the 1-based position of the first term with |a(n)| > 1. Absent when not resolved, and on a reserved or recycled A-number (keyword allocated or recycled).',
      ),
    firstIndex: z
      .number()
      .optional()
      .describe('The index n of the first term; absent with offset.'),
    keywords: z
      .array(z.string())
      .optional()
      .describe(
        'Keyword flags such as nonn, core, tabl (oeis_list_reference topic keywords decodes them); absent when not resolved.',
      ),
    url: z.string().describe('Sequence page on oeis.org; cite it wherever the entry is reused.'),
    note: z
      .string()
      .optional()
      .describe(
        'Outgoing only: the parenthetical written beside the A-number in a cross-reference line, e.g. "phi"; written by OEIS contributors.',
      ),
    lineIndex: z
      .number()
      .optional()
      .describe(
        'Outgoing only: 0-based index into lines of the first cross-reference line naming this A-number.',
      ),
  })
  .describe('One related sequence.');

export const oeisGetCrossRefs = tool('oeis_get_cross_refs', {
  title: 'Get OEIS Cross-References',
  description:
    "List sequences related to an OEIS entry. direction outgoing returns the A-numbers named in the entry's cross-reference (Cf.) lines, with any parenthetical note beside each; direction incoming returns entries that mention this A-number anywhere. Each row carries the related sequence's name and first terms. 10 rows per page.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aNumber: ANumberSchema,
    direction: blankAsUnset(z.enum(['outgoing', 'incoming']).default('outgoing')).describe(
      'outgoing (default): the A-numbers this entry cross-references. incoming: the entries that mention this A-number.',
    ),
    start: pageStartSchema.describe(
      'Row offset: 0, 10, … 100 (at most 110 rows are reachable per entry and direction). Pass nextStart from the previous page.',
    ),
  }),
  output: z.object({
    aNumber: z.string().describe('The entry whose relations are listed, e.g. "A000045".'),
    direction: z.enum(['outgoing', 'incoming']).describe('The direction listed.'),
    related: z
      .array(RelatedSchema)
      .describe(
        'Related sequences on this page: outgoing in order of first mention, incoming in OEIS relevance order.',
      ),
    lines: z
      .array(z.string())
      .optional()
      .describe(
        "Outgoing only: the entry's cross-reference lines verbatim, written by OEIS contributors; lineIndex points into this list.",
      ),
    start: z
      .number()
      .describe(
        'The row offset of this page. For incoming, as OEIS served it: below the requested start when that start was past the last entry (OEIS then serves the last page).',
      ),
    nextStart: z
      .number()
      .optional()
      .describe('Pass as start for the next page; absent on the last reachable page.'),
  }),
  enrichment: pagedListEnrichment,
  errors: [
    {
      reason: 'sequence_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No OEIS entry exists for the requested A-number. Raised for direction outgoing only; direction incoming reports that no entry mentions it.',
      recovery:
        'No OEIS entry has this A-number; find the right one with oeis_search_sequences or oeis_identify_sequence.',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The oeis.org request queue would exceed its wait budget on the record fetch or the incoming search.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org requests are paced to one every 10 seconds and the queue is backed up; wait the retryAfter seconds in the error data (30 seconds if none is shown), then call oeis_get_cross_refs again.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'oeis.org answered HTTP 429 Too Many Requests on the record fetch or the incoming search, and retries within the call did not clear it.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org answered 429 Too Many Requests; wait as long as the retryAfter in the error data says (seconds, or an HTTP date), or 30 seconds if none is shown, then call oeis_get_cross_refs again.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: PAGE_SIZE });
    const { aNumber, direction } = input;
    const service = getOeisService();
    const notices: string[] = [];
    let start = input.start;
    let related: z.infer<typeof RelatedSchema>[];
    let total: number | undefined;
    let lines: string[] | undefined;

    if (direction === 'incoming') {
      const page = await service.search(
        { q: `${aNumber} -id:${aNumber}`, sort: 'relevance', start },
        ctx,
      );
      ctx.enrich.echo(page.effectiveQuery);
      total = page.total;
      start = page.start ?? start;
      related = page.rows.map((row) => ({ ...row, resolved: true }));
      if (start < input.start) {
        notices.push(
          `Start ${input.start} is past the last of ${total} entries; this is the last page, from start ${start}.`,
        );
      }
      if (page.status === 'none') notices.push('No other OEIS entry mentions this A-number.');
      if (page.status === 'too_many') {
        notices.push(
          `OEIS reports too many entries mentioning ${aNumber} to list; narrow with oeis_search_sequences, e.g. "${aNumber} keyword:core".`,
        );
      }
    } else {
      const startedAt = Date.now();
      const record = await service.getRecord(aNumber, ctx);
      if (!record) {
        throw ctx.fail('sequence_not_found', `OEIS has no entry ${aNumber}.`, { aNumber });
      }
      lines = record.crossReferences;
      const refs = outgoingRefs(aNumber, lines);
      total = refs.length;
      const pageRefs = refs.slice(start, start + PAGE_SIZE);
      const resolution: NameResolution = pageRefs.length
        ? await resolveNames(
            pageRefs,
            ctx,
            Math.max(0, DEFAULT_DEADLINE_MS - (Date.now() - startedAt)),
          )
        : { kind: 'resolved', rows: new Map() };

      related = pageRefs.map((ref) => {
        const row = resolution.kind === 'resolved' ? resolution.rows.get(ref.aNumber) : undefined;
        return {
          ...(row ?? { aNumber: ref.aNumber, url: `https://oeis.org/${ref.aNumber}` }),
          resolved: row !== undefined,
          ...(ref.note && { note: ref.note }),
          lineIndex: ref.lineIndex,
        };
      });
      if (!refs.length) {
        notices.push(
          'This entry names no other A-numbers in its cross-reference lines; try direction incoming.',
        );
      } else if (!pageRefs.length) {
        const lastPageStart = Math.floor((refs.length - 1) / PAGE_SIZE) * PAGE_SIZE;
        notices.push(
          `This entry names ${refs.length} other A-numbers; start ${start} is past the last of them. Call again with start ${Math.min(lastPageStart, MAX_START)}.`,
        );
      }
      if (resolution.kind === 'degraded') {
        notices.push(
          `Names and terms for these A-numbers could not be fetched (${resolution.failure}); call oeis_get_cross_refs again with the same start after about ${resolution.retryAfterSeconds} seconds, or pass an A-number to oeis_get_sequence.`,
        );
      }
    }

    if (total !== undefined) ctx.enrich.total(total);
    ctx.enrich({ shown: related.length });
    const hasMore = total !== undefined && start + related.length < total;
    const nextStart = hasMore && start + PAGE_SIZE <= MAX_START ? start + PAGE_SIZE : undefined;
    if (hasMore) {
      if (nextStart !== undefined) {
        notices.push(
          `Showing ${start + 1}-${start + related.length} of ${total}; call again with start ${nextStart} for the next page.`,
        );
      } else {
        notices.push(
          direction === 'outgoing'
            ? `Only the first ${MAX_START + PAGE_SIZE} of ${total} related A-numbers can be paged here; lines names the rest.`
            : `OEIS lists only the first ${MAX_START + PAGE_SIZE} of ${total} entries that mention ${aNumber} without an account; narrow with oeis_search_sequences, e.g. "${aNumber} keyword:core".`,
        );
      }
      ctx.enrich.truncated({ shown: related.length, cap: PAGE_SIZE, guidance: notices.join(' ') });
    } else if (notices.length) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      aNumber,
      direction,
      related,
      ...(lines && { lines }),
      start,
      ...(nextStart !== undefined && { nextStart }),
    };
  },

  format: (result) => {
    const out = [
      result.direction === 'outgoing'
        ? `# Sequences ${result.aNumber} cross-references (start ${result.start})`
        : `# Entries that mention ${result.aNumber} (start ${result.start})`,
      '',
      `**Direction:** ${result.direction}`,
    ];
    if (!result.related.length) out.push('', 'No related sequences on this page.');
    result.related.forEach((row, i) => {
      out.push(
        '',
        `## ${result.start + i + 1}. ${row.aNumber}${row.name === undefined ? '' : `: ${inline(row.name)}`}`,
        `**Resolved:** ${row.resolved ? 'yes' : 'no (name and terms not fetched)'}`,
      );
      if (row.note !== undefined) out.push(`**Note:** ${inline(row.note)}`);
      if (row.lineIndex !== undefined) out.push(`**Cross-reference line:** ${row.lineIndex}`);
      if (row.terms) {
        out.push(`**Terms:** ${row.terms.length ? inline(row.terms.join(', ')) : 'none listed'}`);
      }
      if (row.offset !== undefined) out.push(`**Offset:** ${inline(row.offset)}`);
      if (row.firstIndex !== undefined) out.push(`**First term:** a(${row.firstIndex})`);
      if (row.keywords) {
        out.push(`**Keywords:** ${row.keywords.length ? inline(row.keywords.join(', ')) : 'none'}`);
      }
      out.push(`**URL:** ${row.url}`);
    });
    if (result.lines) {
      out.push('', '## Cross-reference lines');
      result.lines.forEach((line, i) => {
        out.push('', `Line ${i}:`, blockquote(line));
      });
      if (!result.lines.length) out.push('', 'None.');
    }
    if (result.nextStart !== undefined) {
      out.push('', `**Next page:** call again with start ${result.nextStart}.`);
    }
    return [{ type: 'text', text: out.join('\n') }];
  },
});
