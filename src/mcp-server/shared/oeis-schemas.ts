/**
 * @fileoverview Input and output schemas shared across the OEIS tools and resource: the A-number
 * input, the blank-as-unset wrapper for form clients, the paging `start` field, the summary row,
 * and the paged-list enrichment block.
 * @module mcp-server/shared/oeis-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Rows per `/search` page; fixed by OEIS. */
export const PAGE_SIZE = 10;

/** Highest `start` an anonymous `/search` call can page to (results 101–110). */
export const MAX_START = 100;

/** Reads a blank string from a form client as "unset" so the default or absence applies. */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

/**
 * Normalizes A-number input to the zero-padded form: trims, decodes `%XX` escapes (a URL inside a
 * resource URI arrives percent-encoded, and template variables are not decoded), strips an oeis.org
 * URL prefix, cuts at the first `/`, `?`, or `#` after the A-number, uppercases a leading `a`, and
 * pads `A?\d{1,7}` to six digits (`A45` → `A000045`, `A0000045` → `A000045`). Anything else passes
 * through to fail validation. Every step is linear in the input length, whatever the input holds.
 */
export function normalizeANumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const unprefixed = value
    .trim()
    .replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?oeis\.org\//i, '');
  const end = unprefixed.search(/[/?#]/);
  const stripped = (end === -1 ? unprefixed : unprefixed.slice(0, end)).replace(/^a/, 'A');
  const match = /^A?(\d{1,7})$/.exec(stripped);
  return match ? `A${String(Number(match[1])).padStart(6, '0')}` : value;
}

/**
 * The A-number input every tool and the resource take. The shape is checked after normalization
 * rather than advertised as a `pattern`, which would reject the short forms the description accepts.
 */
export const ANumberSchema = z
  .preprocess(
    normalizeANumber,
    z.string().superRefine((aNumber, ctx) => {
      if (/^A\d{6,7}$/.test(aNumber)) return;
      ctx.addIssue({
        code: 'custom',
        message: /^\s*[MN]\d{1,4}\s*$/i.test(aNumber)
          ? 'a legacy M/N book number is not an A-number; search it as a word with oeis_search_sequences to find the entry.'
          : 'expected an OEIS A-number such as A000045 (A45, 45, and an oeis.org sequence URL are also accepted).',
      });
    }),
  )
  .describe(
    'OEIS A-number, e.g. "A000045"; oeis_identify_sequence and oeis_search_sequences return them. Also accepts "a000045", "A45", "45", and an oeis.org sequence URL; all normalize to the zero-padded form. Legacy M/N book numbers (e.g. "M1459") are not A-numbers: find them with oeis_search_sequences.',
  );

/** Paging offset for `/search`-backed lists; each tool adds its own `.describe()`. */
export const pageStartSchema = blankAsUnset(
  z.number().int().min(0).max(MAX_START).multipleOf(PAGE_SIZE).default(0),
);

/** One summary row from search, identify, and cross-reference results. */
export const SequenceSummarySchema = z.object({
  aNumber: z
    .string()
    .describe('A-number, e.g. "A000108"; pass it to oeis_get_sequence for the full entry.'),
  name: z.string().describe('Sequence name, written by OEIS contributors.'),
  terms: z.array(z.string()).describe('Data-line terms as exact decimal strings, signs kept.'),
  offset: z
    .string()
    .optional()
    .describe(
      'Offset "i,p": i is the index n of the first term, p the 1-based position of the first term with |a(n)| > 1. Absent on a reserved or recycled A-number (keyword allocated or recycled).',
    ),
  firstIndex: z
    .number()
    .optional()
    .describe('The index n of the first term (the first number of offset); absent with offset.'),
  keywords: z
    .array(z.string())
    .describe(
      'Keyword flags such as nonn, core, tabl; oeis_list_reference topic keywords decodes them.',
    ),
  url: z.string().describe('Sequence page on oeis.org; cite it wherever the entry is reused.'),
});

/** Enrichment block for `/search`-backed paged lists (search, identify, cross-references). */
export const pagedListEnrichment = {
  truncated: z.boolean().describe('True when more rows exist than this page shows.'),
  shown: z.number().describe('Rows on this page.'),
  cap: z.number().describe('Page size: 10, fixed by OEIS.'),
  totalCount: z
    .number()
    .optional()
    .describe(
      'Total rows: the match count OEIS reported, or for outgoing cross-references the number of distinct A-numbers the entry names.',
    ),
  effectiveQuery: z
    .string()
    .optional()
    .describe('The query as OEIS parsed it (lowercased upstream), e.g. seq:1,2,5,14,42.'),
  notice: z
    .string()
    .optional()
    .describe(
      'Guidance: why nothing matched, how to narrow the query, or how to reach the next page.',
    ),
};
