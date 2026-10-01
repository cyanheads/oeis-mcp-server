/**
 * @fileoverview oeis_identify_sequence — identifies OEIS entries whose data line contains a run of
 * consecutive terms, ranked by OEIS relevance, with the index where the run begins in each.
 * @module mcp-server/tools/definitions/oeis-identify-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inline, summaryLines } from '@/mcp-server/shared/markdown.js';
import {
  blankAsUnset,
  MAX_START,
  PAGE_SIZE,
  pagedListEnrichment,
  pageStartSchema,
  SequenceSummarySchema,
} from '@/mcp-server/shared/oeis-schemas.js';
import { getOeisService } from '@/services/oeis/oeis-service.js';
import type { SequenceSummary } from '@/services/oeis/types.js';

const MINUS_SIGN = String.fromCodePoint(0x2212);
const ELLIPSIS = String.fromCodePoint(0x2026);
const BRACKET_PAIRS: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
const INTEGER = /^-?\d+$/;
const MAX_TERMS = 60;
const MAX_DIGITS = 200;
/** OEIS takes a query of up to 1024 characters; this leaves room for the `signed:` prefix. */
const MAX_QUERY_CHARS = 1000;

/**
 * Normalizes a pasted run of terms to `t1,t2,…`: trims, strips one surrounding bracket pair and a
 * trailing ellipsis, maps U+2212 MINUS SIGN to `-`, and collapses comma/whitespace runs to one comma.
 */
function normalizeTerms(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let terms = value.trim();
  const first = terms.charAt(0);
  if (terms.length >= 2 && BRACKET_PAIRS[first] === terms.at(-1)) terms = terms.slice(1, -1).trim();
  for (const tail of ['...', ELLIPSIS]) {
    if (terms.endsWith(tail)) {
      terms = terms.slice(0, -tail.length);
      break;
    }
  }
  return terms
    .replaceAll(MINUS_SIGN, '-')
    .replace(/[\s,]+/g, ',')
    .replace(/^,+|,+$/g, '');
}

/** The first rule a normalized run breaks, as a message for the caller; `undefined` when valid. */
function brokenTermsRule(terms: string): string | undefined {
  if (!terms) return 'no terms given; supply at least one integer, or _ for one unknown term.';
  const tokens = terms.split(',');
  if (tokens.length > MAX_TERMS) {
    return `${tokens.length} terms given; at most ${MAX_TERMS} are accepted, and about 6 consecutive terms identify a sequence best.`;
  }
  for (const [i, token] of tokens.entries()) {
    if (token !== '_' && !INTEGER.test(token)) {
      const shown = token.length > 20 ? `${token.slice(0, 20)}${ELLIPSIS}` : token;
      return `term ${i + 1} (${JSON.stringify(shown)}) is not an integer or _; give integers separated by commas or spaces.`;
    }
    const digits = token.replace('-', '').length;
    if (digits > MAX_DIGITS) {
      return `term ${i + 1} has ${digits} digits; each term may have at most ${MAX_DIGITS}.`;
    }
  }
  if (terms.length > MAX_QUERY_CHARS) {
    return `${terms.length} characters after normalizing; OEIS takes at most ${MAX_QUERY_CHARS}, so give fewer or shorter terms.`;
  }
  return;
}

/** A term as the matcher compares it: its absolute value unless signs must match. */
function comparable(term: string, matchSigns: boolean): bigint {
  const value = BigInt(term);
  return matchSigns || value >= 0n ? value : -value;
}

/**
 * The index n at which the supplied run first occurs in a row's data line (absolute values unless
 * `matchSigns`; `_` matches any term), or `undefined` when the run is not in the data line.
 */
function findMatchStartIndex(
  row: SequenceSummary,
  supplied: readonly string[],
  matchSigns: boolean,
): number | undefined {
  if (row.firstIndex === undefined) return;
  const pattern = supplied.map((term) => (term === '_' ? undefined : comparable(term, matchSigns)));
  const data = row.terms.map((term) => (INTEGER.test(term) ? comparable(term, matchSigns) : null));
  for (let p = 0; p + pattern.length <= data.length; p++) {
    if (pattern.every((want, i) => want === undefined || data[p + i] === want)) {
      return row.firstIndex + p;
    }
  }
  return;
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a, b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Composes the zero-hit guidance from the conditions that hold for the supplied run. */
function zeroHitNotice(supplied: readonly string[], matchSigns: boolean): string {
  const parts = ['No OEIS entry contains these terms consecutively in its data line.'];
  if (supplied.length >= 5) {
    parts.push('Drop the first term or two and retry; sequences often start at a different index.');
  }
  if (matchSigns) parts.push('Retry with matchSigns false to ignore sign conventions.');
  if (['0', '1', '-1'].includes(supplied[0] ?? '')) {
    parts.push('Leading 0s and 1s are often omitted or differ between sources; drop them.');
  }
  const nonzero = supplied
    .filter((term) => term !== '_')
    .map((term) => comparable(term, false))
    .filter((value) => value !== 0n);
  if (nonzero.length >= 2) {
    const g = nonzero.reduce(gcd);
    if (g > 1n) {
      parts.push(`The terms share a common factor of ${g}; try the terms divided by ${g}.`);
    }
  }
  parts.push(
    'For words, formulas, or prefixes call oeis_search_sequences; oeis_list_reference topic search_syntax lists the syntax.',
  );
  return parts.join(' ');
}

export const oeisIdentifySequence = tool('oeis_identify_sequence', {
  title: 'Identify OEIS Sequence',
  description:
    'Identify integer sequences that contain a run of consecutive terms, e.g. "1, 2, 5, 14, 42". Returns up to 10 matches per page in OEIS relevance order, each with the index n at which the supplied run begins. For the best hit rate supply about 6 terms and leave off the first one or two, since sources disagree on where a sequence starts. Takes up to 60 terms, each an integer of at most 200 digits or the wildcard _ for one unknown term.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    terms: z
      .preprocess(
        normalizeTerms,
        z.string().superRefine((terms, ctx) => {
          const message = brokenTermsRule(terms);
          if (message) ctx.addIssue({ code: 'custom', message });
        }),
      )
      .describe(
        'Up to 60 consecutive terms separated by commas or spaces, e.g. "1, 2, 5, 14, 42" (a bracketed list or a trailing ... is accepted). Each term is an integer of at most 200 digits, or _ for a single unknown term.',
      ),
    matchSigns: blankAsUnset(z.boolean().default(false)).describe(
      'false (default) matches ignoring signs, so a sign-convention difference does not hide the sequence; true requires the signs to match.',
    ),
    start: pageStartSchema.describe(
      'Result offset: 0, 10, … 100 (OEIS shows at most 110 results per query). Pass nextStart from the previous page.',
    ),
  }),
  output: z.object({
    results: z
      .array(
        SequenceSummarySchema.extend({
          matchStartIndex: z
            .number()
            .optional()
            .describe(
              "The index n where the supplied run begins in this entry's data line; absent when the run is not in the data line (OEIS matched it another way).",
            ),
        }).describe('One candidate sequence.'),
      )
      .describe('Candidate sequences on this page, in OEIS relevance order.'),
    start: z
      .number()
      .describe(
        'The result offset of this page as OEIS served it; below the requested start when that start was past the last result (OEIS then serves the last page).',
      ),
    nextStart: z
      .number()
      .optional()
      .describe('Pass as start for the next page; absent on the last reachable page.'),
  }),
  enrichment: pagedListEnrichment,
  errors: [
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The oeis.org request queue would exceed its wait budget.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org requests are paced to one every 10 seconds and the queue is backed up; wait the retryAfter seconds in the error data (30 seconds if none is shown), then call oeis_identify_sequence again.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'oeis.org answered HTTP 429 Too Many Requests and retries within the call did not clear it.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org answered 429 Too Many Requests; wait as long as the retryAfter in the error data says (seconds, or an HTTP date), or 30 seconds if none is shown, then call oeis_identify_sequence again.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: PAGE_SIZE });
    const prefix = input.matchSigns ? 'signed:' : 'seq:';
    const page = await getOeisService().search(
      { q: `${prefix}${input.terms}`, sort: 'relevance', start: input.start },
      ctx,
    );
    ctx.enrich.echo(page.effectiveQuery);
    if (page.total !== undefined) ctx.enrich.total(page.total);
    const start = page.start ?? input.start;

    const supplied = input.terms.split(',');
    const results = page.rows.map((row) => {
      const matchStartIndex = findMatchStartIndex(row, supplied, input.matchSigns);
      return matchStartIndex === undefined ? row : { ...row, matchStartIndex };
    });
    ctx.enrich({ shown: results.length });

    const notices: string[] = [];
    if (start < input.start) {
      notices.push(
        `Start ${input.start} is past the last of ${page.total} results; this is the last page, from start ${start}.`,
      );
    }
    if (page.status === 'none') notices.push(zeroHitNotice(supplied, input.matchSigns));
    if (page.status === 'too_many') {
      notices.push(
        'OEIS matched too many entries to list for these terms. Add more consecutive terms.',
      );
    }
    if (supplied.filter((term) => term !== '_').length < 4) {
      notices.push('Few terms match many sequences; about 6 consecutive terms narrow the result.');
    }

    const hasMore = page.total !== undefined && start + results.length < page.total;
    const nextStart = hasMore && start + PAGE_SIZE <= MAX_START ? start + PAGE_SIZE : undefined;
    if (hasMore) {
      notices.push(
        nextStart === undefined
          ? `OEIS lists only the first ${MAX_START + PAGE_SIZE} of ${page.total} matches without an account; add more consecutive terms to narrow the query.`
          : `Showing ${start + 1}-${start + results.length} of ${page.total}; call again with start ${nextStart} for the next page.`,
      );
      ctx.enrich.truncated({ shown: results.length, cap: PAGE_SIZE, guidance: notices.join(' ') });
    } else if (notices.length) {
      ctx.enrich.notice(notices.join(' '));
    }

    return { results, start, ...(nextStart !== undefined && { nextStart }) };
  },

  format: (result) => {
    const lines = [`# Sequence candidates (start ${result.start})`];
    if (!result.results.length) lines.push('', 'No matching sequences on this page.');
    result.results.forEach((row, i) => {
      lines.push(
        '',
        `## ${result.start + i + 1}. ${row.aNumber}: ${inline(row.name)}`,
        row.matchStartIndex === undefined
          ? '**Run starts at:** not located in the data line'
          : `**Run starts at:** n = ${row.matchStartIndex}`,
        ...summaryLines(row),
      );
    });
    if (result.nextStart !== undefined) {
      lines.push('', `**Next page:** call again with start ${result.nextStart}.`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
