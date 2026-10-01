/**
 * @fileoverview Tests for the shared tool schemas: blank-as-unset, A-number normalization and
 * validation, the paging `start` field, and the enrichment block.
 * @module tests/shared/oeis-schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  ANumberSchema,
  blankAsUnset,
  MAX_START,
  normalizeANumber,
  PAGE_SIZE,
  pagedListEnrichment,
  pageStartSchema,
  SequenceSummarySchema,
} from '@/mcp-server/shared/oeis-schemas.js';

describe('constants', () => {
  it('fixes the page size at 10 and the reachable start at 100', () => {
    expect(PAGE_SIZE).toBe(10);
    expect(MAX_START).toBe(100);
  });
});

describe('blankAsUnset', () => {
  const sort = blankAsUnset(z.enum(['relevance', 'number']).default('relevance'));
  const limit = blankAsUnset(z.number().int().min(1).max(50).default(10));
  const optionalText = blankAsUnset(z.string().optional());

  it('reads an empty or whitespace-only string as unset so the default applies', () => {
    expect(sort.parse('')).toBe('relevance');
    expect(sort.parse('   ')).toBe('relevance');
    expect(sort.parse('\t\n')).toBe('relevance');
    expect(limit.parse('')).toBe(10);
  });

  it('applies the default for undefined and passes real values through', () => {
    expect(sort.parse(undefined)).toBe('relevance');
    expect(sort.parse('number')).toBe('number');
    expect(limit.parse(25)).toBe(25);
  });

  it('leaves an optional field undefined when blank', () => {
    expect(optionalText.parse('')).toBeUndefined();
    expect(optionalText.parse('x')).toBe('x');
  });

  it('does not treat a non-string as blank: 0 stays 0 and null stays invalid', () => {
    expect(blankAsUnset(z.number().default(5)).parse(0)).toBe(0);
    expect(limit.safeParse(null).success).toBe(false);
  });

  it('still validates a non-blank value against the inner schema', () => {
    expect(sort.safeParse('bogus').success).toBe(false);
    expect(limit.safeParse(0).success).toBe(false);
    expect(limit.safeParse(' 5 ').success).toBe(false);
  });

  it('works inside an object with several blank fields, as a form client sends them', () => {
    const schema = z.object({ sort, start: pageStartSchema, note: optionalText });
    expect(schema.parse({ sort: '', start: '', note: '' })).toEqual({
      sort: 'relevance',
      start: 0,
      note: undefined,
    });
  });
});

describe('normalizeANumber', () => {
  it.each([
    ['A000045', 'A000045'],
    ['a000045', 'A000045'],
    ['A45', 'A000045'],
    ['a45', 'A000045'],
    ['45', 'A000045'],
    ['  A45  ', 'A000045'],
    ['A0000045', 'A000045'],
    ['0000045', 'A000045'],
    ['A1234567', 'A1234567'],
    ['1234567', 'A1234567'],
    ['A0', 'A000000'],
    ['https://oeis.org/A000045', 'A000045'],
    ['http://oeis.org/A000045', 'A000045'],
    ['HTTPS://OEIS.ORG/A45', 'A000045'],
    ['https://www.oeis.org/a45', 'A000045'],
    ['oeis.org/A000045', 'A000045'],
    ['www.oeis.org/A000045', 'A000045'],
    ['oeis.org/A000045/b000045.txt', 'A000045'],
    ['https://oeis.org/A000045?fmt=json', 'A000045'],
    ['https://oeis.org/A000045#comments', 'A000045'],
    ['https://oeis.org/A000045/', 'A000045'],
  ])('maps %j to %j', (input, expected) => {
    expect(normalizeANumber(input)).toBe(expected);
  });

  it.each([
    'M1459',
    'N0577',
    '',
    'A',
    'abc',
    '12345678',
    'A12345678',
    'A-45',
    'https://oeis.org/search?q=1,2,3',
    'https://example.org/A000045',
  ])('passes %j through unchanged so the pattern rejects it', (input) => {
    expect(normalizeANumber(input)).toBe(input);
  });

  it('passes a non-string through unchanged', () => {
    expect(normalizeANumber(45)).toBe(45);
    expect(normalizeANumber(null)).toBeNull();
    expect(normalizeANumber(undefined)).toBeUndefined();
  });
});

describe('ANumberSchema', () => {
  it.each(['A000045', 'a000045', 'A45', '45', 'https://oeis.org/A000045/b000045.txt', 'A1234567'])(
    'accepts %j',
    (input) => {
      expect(ANumberSchema.safeParse(input).success).toBe(true);
    },
  );

  it('returns the zero-padded canonical form', () => {
    expect(ANumberSchema.parse('a45')).toBe('A000045');
    expect(ANumberSchema.parse('0000045')).toBe('A000045');
  });

  it.each(['M1459', 'A12345678', 'abc', '', 'A', 45, null, undefined, {}])(
    'rejects %j',
    (input) => {
      expect(ANumberSchema.safeParse(input).success).toBe(false);
    },
  );

  it('carries a description for the advertised schema', () => {
    expect(ANumberSchema.description).toContain('A000045');
    expect(ANumberSchema.description).toContain('M1459');
  });
});

describe('pageStartSchema', () => {
  it('defaults to 0 when omitted or blank', () => {
    expect(pageStartSchema.parse(undefined)).toBe(0);
    expect(pageStartSchema.parse('')).toBe(0);
    expect(pageStartSchema.parse('  ')).toBe(0);
  });

  it.each([0, 10, 50, 100])('accepts %i', (start) => {
    expect(pageStartSchema.parse(start)).toBe(start);
  });

  it.each([5, 15, 110, 200, -10, 1.5, Number.NaN, '20', null])('rejects %j', (start) => {
    expect(pageStartSchema.safeParse(start).success).toBe(false);
  });
});

describe('SequenceSummarySchema', () => {
  const row = {
    aNumber: 'A000108',
    name: 'Catalan numbers',
    terms: ['1', '1', '2'],
    offset: '0,3',
    firstIndex: 0,
    keywords: ['core', 'nonn'],
    url: 'https://oeis.org/A000108',
  };

  it('accepts a complete row', () => {
    expect(SequenceSummarySchema.parse(row)).toEqual(row);
  });

  it.each(Object.keys(row))('requires %s', (field) => {
    expect(SequenceSummarySchema.safeParse({ ...row, [field]: undefined }).success).toBe(false);
  });

  it('keeps terms as strings: a numeric term is rejected', () => {
    expect(SequenceSummarySchema.safeParse({ ...row, terms: [1, 1, 2] }).success).toBe(false);
  });
});

describe('pagedListEnrichment', () => {
  const schema = z.object(pagedListEnrichment);

  it('requires truncated, shown and cap', () => {
    expect(schema.safeParse({ truncated: false, shown: 0, cap: 10 }).success).toBe(true);
    for (const missing of ['truncated', 'shown', 'cap']) {
      const base: Record<string, unknown> = { truncated: false, shown: 0, cap: 10 };
      delete base[missing];
      expect(schema.safeParse(base).success).toBe(false);
    }
  });

  it('treats totalCount, effectiveQuery and notice as optional', () => {
    const parsed = schema.parse({
      truncated: true,
      shown: 10,
      cap: 10,
      totalCount: 26,
      effectiveQuery: 'seq:1,2,5',
      notice: 'Narrow the query.',
    });
    expect(parsed.totalCount).toBe(26);
  });
});
