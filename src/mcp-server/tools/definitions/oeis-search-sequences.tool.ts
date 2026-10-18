/**
 * @fileoverview oeis_search_sequences — searches the OEIS with its own query syntax (words, quoted
 * phrases, term lists, prefixes) and returns one page of sequence summaries.
 * @module mcp-server/tools/definitions/oeis-search-sequences
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DATA_LINE_SENTENCE, likelyPastDataLine } from '@/mcp-server/shared/data-line-limit.js';
import { codeSpan, summaryLines } from '@/mcp-server/shared/markdown.js';
import {
  blankAsUnset,
  MAX_START,
  PAGE_SIZE,
  pagedListEnrichment,
  pageStartSchema,
  SequenceSummarySchema,
} from '@/mcp-server/shared/oeis-schemas.js';
import { getOeisService } from '@/services/oeis/oeis-service.js';
import type { SearchSort } from '@/services/oeis/types.js';

const SORT_ORDERS = [
  'relevance',
  'number',
  'created',
  'modified',
] as const satisfies readonly SearchSort[];

/** Search prefixes OEIS recognizes (oeis.org/hints.html, verified 2026-09-29). */
const KNOWN_PREFIXES = new Set([
  'id',
  'seq',
  'signed',
  'subseq',
  'signedsubseq',
  'name',
  'offset',
  'comment',
  'ref',
  'link',
  'formula',
  'example',
  'maple',
  'mathematica',
  'program',
  'xref',
  'keyword',
  'author',
  'extension',
]);

/** One token of the `Search:` echo: a quoted phrase, other non-space text, or a lone `"`. */
const ECHO_TOKEN = /"[^"]*"|[^\s"]+|"/g;
/**
 * An echo token that holds terms: `seq:` or `signed:` and terms (integers or `_`) joined by commas,
 * or a bare integer. OEIS echoes bare numbers separated by commas as one `seq:` run; with spaces
 * alone, a negative term after the first starts a new run and a run of fewer than three numbers is
 * left unjoined (`14 42` → `14 42`, `1 2 -5 14 42 132` → `1 2 seq:-5,14,42,132`).
 */
const TERM_TOKEN = /^(?:(seq|signed):((?:-?\d+|_)(?:,(?:-?\d+|_))*)|-?\d+)$/;

/** What OEIS's `Search:` echo shows about the numbers in a query. */
export interface EchoReading {
  /** Set when that one token is a bare integer, which OEIS matches in an entry's text as well. */
  bare?: true;
  /** The terms, when the whole echo is one token holding terms: OEIS matched them as one run. */
  run?: string[];
  /** Guidance, when two tokens holding terms are adjacent: OEIS searched them as separate runs. */
  splitNotice?: string;
}

/**
 * Reads the echo token by token, a quoted phrase counting as one: a single token holding terms is
 * the run OEIS matched; two adjacent ones are numbers OEIS split apart. The split notice gives the
 * echo's terms joined by commas, `signed:` first when the first token is, as the one-run query to
 * send instead, unless the echo holds another token (a word, a phrase, another prefix).
 */
export function readEcho(effectiveQuery: string): EchoReading {
  const tokens = (effectiveQuery.match(ECHO_TOKEN) ?? []).map((token) => {
    const [whole, prefix, terms] = TERM_TOKEN.exec(token) ?? [];
    return whole === undefined
      ? undefined
      : {
          bare: prefix === undefined,
          signed: prefix === 'signed',
          terms: terms?.split(',') ?? [whole],
        };
  });
  const [first] = tokens;
  if (tokens.length === 1 && first) return { run: first.terms, ...(first.bare && { bare: true }) };
  if (!tokens.some((token, i) => token && tokens[i + 1])) return {};
  const run = tokens.every((token) => token !== undefined)
    ? `: "${first?.signed ? 'signed:' : ''}${tokens.flatMap((token) => token.terms).join(',')}"`
    : '';
  return {
    splitNotice: `OEIS split these numbers into separate searches (see effectiveQuery): with spaces alone, a negative term starts a new run and fewer than three numbers are not joined. To search them as one run, separate them with commas${run}.`,
  };
}

/** `word:` prefixes in the query that OEIS does not recognize; quoted phrases are skipped. */
function unknownPrefixes(query: string): string[] {
  const unknown = new Set<string>();
  for (const token of query.replace(/"[^"]*"/g, ' ').split(/[\s|]+/)) {
    const prefix = /^-?([A-Za-z]+):/.exec(token)?.[1]?.toLowerCase();
    if (prefix && !KNOWN_PREFIXES.has(prefix)) unknown.add(prefix);
  }
  return [...unknown];
}

/**
 * Composes the zero-hit guidance from the conditions that hold for the query. The requested start
 * plays no part: OEIS serves the last page for a start past the end, so "No results." at any
 * start means the query matches nothing. A query OEIS echoes as one run of terms is matched as
 * `oeis_identify_sequence` matches its terms, so it is held to the same data-line limit, except a
 * lone bare integer, which OEIS also matches in an entry's text; numbers OEIS split apart get the
 * split notice in place of that advice, which would still split.
 */
function zeroHitNotice(query: string, echo: EchoReading): string {
  const parts: string[] = [];
  const unknown = unknownPrefixes(query);
  if (unknown.length) {
    const quoted = unknown.map((p) => `"${p}:"`).join(', ');
    parts.push(
      unknown.length === 1
        ? `${quoted} is not an OEIS prefix, so OEIS searched it as plain words.`
        : `${quoted} are not OEIS prefixes, so OEIS searched them as plain words.`,
      'oeis_list_reference topic search_syntax lists the valid prefixes.',
    );
  }
  if (echo.splitNotice) parts.push(echo.splitNotice);
  else if (echo.run) {
    if (!echo.bare && likelyPastDataLine(echo.run)) parts.push(DATA_LINE_SENTENCE);
    parts.push(
      'Drop the first term or two and retry, since sources disagree on where a sequence starts; or put subseq: before the terms to match them with other terms in between.',
    );
  }
  if (!parts.length) {
    parts.push(
      'Loosen the query: drop a prefix filter or a quoted phrase, or use | between alternatives.',
    );
  }
  return parts.join(' ');
}

export const oeisSearchSequences = tool('oeis_search_sequences', {
  title: 'Search OEIS Sequences',
  description:
    'Search the OEIS using its query syntax: plain words, "quoted phrases", comma-separated terms, prefixes (keyword:, author:, name:, comment:, formula:, program:, xref:, id:), | for OR, and a leading - to exclude. Returns up to 10 summaries per page. For identifying a sequence from its terms, oeis_identify_sequence is the direct route.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'OEIS query, sent as written. Examples: keyword:core fibonacci; author:Sloane; "Catalan numbers" (a quoted phrase); 1,2,5,14,42 (separate terms with commas: with spaces alone, a negative term after the first starts a new run and fewer than three numbers are not joined). oeis_list_reference topic search_syntax lists the prefixes and operators.',
      ),
    sort: blankAsUnset(z.enum(SORT_ORDERS).default('relevance')).describe(
      'Result order: relevance (default), number (ascending A-number), created (newest entry first), or modified (most recently edited first).',
    ),
    start: pageStartSchema.describe(
      'Result offset: 0, 10, … 100 (OEIS shows at most 110 results per query). Pass nextStart from the previous page.',
    ),
  }),
  output: z.object({
    results: z
      .array(SequenceSummarySchema.describe('One matching sequence.'))
      .describe('Matching sequences on this page, in the applied order.'),
    start: z
      .number()
      .describe(
        'The result offset of this page as OEIS served it; below the requested start when that start was past the last result (OEIS then serves the last page).',
      ),
    nextStart: z
      .number()
      .optional()
      .describe('Pass as start for the next page; absent on the last reachable page.'),
    sort: z.enum(SORT_ORDERS).describe('The result order applied.'),
  }),
  enrichment: {
    ...pagedListEnrichment,
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance: why nothing matched; that OEIS split the numbers into separate searches, and how to join them with commas into one run; how to narrow the query; or how to reach the next page.',
      ),
  },
  errors: [
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The oeis.org request queue would exceed its wait budget.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org requests are paced to one every 10 seconds and the queue is backed up; wait the retryAfter seconds in the error data (30 seconds if none is shown), then call oeis_search_sequences again.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'oeis.org answered HTTP 429 Too Many Requests and retries within the call did not clear it.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org answered 429 Too Many Requests; wait as long as the retryAfter in the error data says (seconds, or an HTTP date), or 30 seconds if none is shown, then call oeis_search_sequences again.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: PAGE_SIZE });
    const page = await getOeisService().search(
      { q: input.query, sort: input.sort, start: input.start },
      ctx,
    );
    ctx.enrich.echo(page.effectiveQuery);
    if (page.total !== undefined) ctx.enrich.total(page.total);
    ctx.enrich({ shown: page.rows.length });
    const start = page.start ?? input.start;
    const echo = readEcho(page.effectiveQuery);

    const notices: string[] = [];
    if (start < input.start) {
      notices.push(
        `Start ${input.start} is past the last of ${page.total} results; this is the last page, from start ${start}.`,
      );
    }
    if (page.status === 'none') notices.push(zeroHitNotice(input.query, echo));
    else if (echo.splitNotice) notices.push(echo.splitNotice);
    if (page.status === 'too_many') {
      notices.push(
        'OEIS matched too many entries to list. Add a word, a quoted phrase, or a prefix such as keyword:nice or author:<name>.',
      );
    }

    const hasMore = page.total !== undefined && start + page.rows.length < page.total;
    const nextStart = hasMore && start + PAGE_SIZE <= MAX_START ? start + PAGE_SIZE : undefined;
    if (hasMore) {
      notices.push(
        nextStart === undefined
          ? `OEIS lists only the first ${MAX_START + PAGE_SIZE} of ${page.total} matches without an account; add a word, a quoted phrase, or a prefix to narrow the query.`
          : `Showing ${start + 1}-${start + page.rows.length} of ${page.total}; call again with start ${nextStart} for the next page.`,
      );
      ctx.enrich.truncated({
        shown: page.rows.length,
        cap: PAGE_SIZE,
        guidance: notices.join(' '),
      });
    } else if (notices.length) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      results: page.rows,
      start,
      ...(nextStart !== undefined && { nextStart }),
      sort: input.sort,
    };
  },

  format: (result) => {
    const lines = [`# OEIS search results (start ${result.start}, sort ${result.sort})`];
    if (!result.results.length) lines.push('', 'No sequences on this page.');
    result.results.forEach((row, i) => {
      lines.push('', `## ${result.start + i + 1}. ${row.aNumber}: ${codeSpan(row.name)}`);
      lines.push(...summaryLines(row));
    });
    if (result.nextStart !== undefined) {
      lines.push('', `**Next page:** call again with start ${result.nextStart}.`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
