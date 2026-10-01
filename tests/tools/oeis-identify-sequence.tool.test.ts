/**
 * @fileoverview Tests for oeis_identify_sequence through the tool contract over a real OeisService
 * with a scripted fetch: the `terms` preprocess and limits, blank optional inputs, the query sent
 * upstream, matchStartIndex (signs, wildcards, terms past 2^53), paging and nextStart, zero-hit,
 * too-many, and few-term notices, required enrichment on the zero-result and under-cap pages,
 * upstream failure classes, and `format()` parity with `structuredContent`.
 * @module tests/tools/oeis-identify-sequence.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oeisIdentifySequence } from '@/mcp-server/tools/definitions/oeis-identify-sequence.tool.js';
import { OeisService } from '@/services/oeis/oeis-service.js';
import {
  clampedSearchPage,
  fibonacciSearchRecord,
  htmlMaintenanceBody,
  moebiusSearchRecord,
  noResultsSearchPage,
  resultsSearchPage,
  type SearchFixtureRecord,
  searchPageText,
  signInRefusalBody,
  tooManySearchPage,
} from '../fixtures/oeis-upstream.js';
import { res, scriptedFetch } from '../fixtures/scripted-fetch.js';
import { blocksText, queryOf, serviceOver, withBackoff } from '../fixtures/tool-service.js';

const holder = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock('@/services/oeis/oeis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/oeis/oeis-service.js')>()),
  getOeisService: () => holder.service,
}));

type Result = Awaited<ReturnType<typeof runToolContract>>;
type Row = { aNumber: string; matchStartIndex?: number; name: string; terms: string[] };

const page = (body: string) => res(body, { status: 200 });

/** A page of `count` synthetic rows with a `Showing` status line for `total` matches. */
function pageOf(count: number, total: number, firstRow = 1, query = 'seq:1,2,3'): string {
  const records: SearchFixtureRecord[] = Array.from({ length: count }, (_, i) => ({
    ...fibonacciSearchRecord,
    aNumber: `A${String(100_000 + i).padStart(6, '0')}`,
    name: `Synthetic ${i}.`,
  }));
  return searchPageText({
    query,
    records,
    status: `Showing ${firstRow}-${firstRow + count - 1} of ${total}`,
  });
}

/** One row with the given terms and offset, as a one-record page. */
function rowPage(overrides: Partial<SearchFixtureRecord>): string {
  return searchPageText({
    query: 'seq:1,2,3',
    status: 'Showing 1-1 of 1',
    records: [{ ...fibonacciSearchRecord, ...overrides }],
  });
}

async function identify(
  input: Record<string, unknown>,
  ...steps: ReturnType<typeof res>[]
): Promise<{ calls: ReturnType<typeof serviceOver>['calls']; result: Result }> {
  const { calls, service } = serviceOver(...steps);
  holder.service = service;
  return { calls, result: await runToolContract(oeisIdentifySequence, input as never) };
}

const structured = (result: Result) => result.structuredContent as Record<string, unknown>;
const rows = (result: Result) => structured(result).results as Row[];
const textOf = (result: Result) =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
const errorOf = (result: Result) =>
  structured(result).error as { code: number; data: Record<string, unknown>; message: string };
const parsedTerms = (terms: string) => oeisIdentifySequence.input.parse({ terms }).terms;

afterEach(() => {
  holder.service = undefined;
});

describe('oeis_identify_sequence', () => {
  describe('terms preprocess', () => {
    it.each([
      ['1, 2, 5, 14, 42', '1,2,5,14,42'],
      ['1,2,5,14,42', '1,2,5,14,42'],
      ['1 2 5 14 42', '1,2,5,14,42'],
      ['  1 ,  2,\t5\n14 ,\r\n42  ', '1,2,5,14,42'],
      ['[1, 2, 5, 14, 42]', '1,2,5,14,42'],
      ['(1, 2, 5)', '1,2,5'],
      ['{1, 2, 5}', '1,2,5'],
      ['[ 1, 2, 5 ]', '1,2,5'],
      ['1, 2, 5, 14, 42, ...', '1,2,5,14,42'],
      ['1, 2, 5, 14, 42...', '1,2,5,14,42'],
      ['1, 2, 5, 14, 42, …', '1,2,5,14,42'],
      ['1, 2, 5, 14, 42…', '1,2,5,14,42'],
      ['[1, 2, 5, 14, 42, ...]', '1,2,5,14,42'],
      ['(1 2 5 ...)', '1,2,5'],
      [',1,2,3,', '1,2,3'],
      [',,1,,,2 3,,', '1,2,3'],
      ['−1, 2, −3', '-1,2,-3'],
      ['-1,-2,3', '-1,-2,3'],
      ['0, 0, 0', '0,0,0'],
      ['007, 1', '007,1'],
      ['1, _, 5', '1,_,5'],
      ['_', '_'],
      ['_, _, 3', '_,_,3'],
      ['[1, 2, _, 14]', '1,2,_,14'],
    ])('reads %j as %j', (given, expected) => {
      expect(parsedTerms(given)).toBe(expected);
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', ' \t\n '],
      ['commas only', ',,,'],
      ['an empty bracket pair', '[]'],
      ['an ellipsis alone', '...'],
      ['letters', 'a, b, c'],
      ['a mixed token', '1, 2x, 3'],
      ['a decimal', '1.5, 2'],
      ['an exponent', '1e5, 2'],
      ['an explicit plus sign', '+1, 2'],
      ['a double minus', '--1, 2'],
      ['a minus between digits', '1-2, 3'],
      ['a lone minus', '1, -, 3'],
      ['a thousands separator split into two terms and a stray dot', '1.000, 2'],
      ['a doubled wildcard', '1, __, 3'],
      ['a wildcard glued to digits', '1, _2, 3'],
      ['a semicolon separator', '1; 2; 3'],
      ['mismatched brackets', '[1, 2, 3)'],
      ['nested brackets', '[[1, 2, 3]]'],
      ['an ellipsis outside the closing bracket', '[1, 2, 3]...'],
      ['an ellipsis in the middle', '1, ..., 5'],
      ['four dots', '1, 2, 3....'],
      ['an unbalanced bracket', '[1, 2, 3'],
      ['a search prefix', 'seq:1,2,3'],
    ])('rejects %s', (_label, terms) => {
      expect(oeisIdentifySequence.input.safeParse({ terms }).success).toBe(false);
    });

    it('rejects a missing terms and a non-string one', () => {
      expect(oeisIdentifySequence.input.safeParse({}).success).toBe(false);
      expect(oeisIdentifySequence.input.safeParse({ terms: 5 }).success).toBe(false);
      expect(oeisIdentifySequence.input.safeParse({ terms: [1, 2, 3] }).success).toBe(false);
      expect(oeisIdentifySequence.input.safeParse({ terms: null }).success).toBe(false);
    });

    it('accepts 60 terms and rejects 61', () => {
      const sixty = Array.from({ length: 60 }, (_, i) => String(i + 1)).join(',');
      expect(parsedTerms(sixty)).toBe(sixty);
      expect(oeisIdentifySequence.input.safeParse({ terms: `${sixty},61` }).success).toBe(false);
      const wild = Array.from({ length: 60 }, () => '_').join(',');
      expect(parsedTerms(wild)).toBe(wild);
      expect(oeisIdentifySequence.input.safeParse({ terms: `${wild},_` }).success).toBe(false);
    });

    it('accepts a 200-digit term (signed too) and rejects 201 digits', () => {
      const d200 = '9'.repeat(200);
      expect(parsedTerms(d200)).toBe(d200);
      expect(parsedTerms(`-${d200}`)).toBe(`-${d200}`);
      expect(parsedTerms(`1, ${d200}, 3`)).toBe(`1,${d200},3`);
      expect(oeisIdentifySequence.input.safeParse({ terms: '9'.repeat(201) }).success).toBe(false);
      expect(oeisIdentifySequence.input.safeParse({ terms: `-${'9'.repeat(201)}` }).success).toBe(
        false,
      );
    });

    it('caps the normalized string at 1000 characters', () => {
      const fourLong = Array.from({ length: 4 }, () => '9'.repeat(200)).join(',');
      expect(fourLong.length).toBeLessThanOrEqual(1000);
      expect(parsedTerms(fourLong)).toBe(fourLong);
      const sixLong = Array.from({ length: 6 }, () => '9'.repeat(200)).join(',');
      expect(sixLong.length).toBeGreaterThan(1000);
      expect(oeisIdentifySequence.input.safeParse({ terms: sixLong }).success).toBe(false);
    });

    it('measures the 60-term limit on the normalized run, not on the pasted text', () => {
      const padded = Array.from({ length: 60 }, (_, i) => String(i + 1)).join(' ,  ');
      expect(parsedTerms(`[ ${padded} , ... ]`).split(',')).toHaveLength(60);
    });

    it('measures the 1000-character limit on the normalized run, not on the pasted text', () => {
      const fourLong = Array.from({ length: 4 }, () => '9'.repeat(200)).join(' ,   \n ');
      expect(fourLong.length).toBeLessThan(1000);
      const spaced = `[ ${fourLong} , ${' '.repeat(300)}... ]`;
      expect(spaced.length).toBeGreaterThan(1000);
      expect(parsedTerms(spaced).split(',')).toHaveLength(4);
    });

    it('advertises terms as a plain string, so the example in its description is valid', () => {
      const terms = z.toJSONSchema(oeisIdentifySequence.input, {
        io: 'input',
        unrepresentable: 'any',
      }).properties?.terms;
      expect(terms).toMatchObject({ type: 'string' });
      expect(terms).not.toHaveProperty('pattern');
      expect(terms).not.toHaveProperty('maxLength');
      expect(oeisIdentifySequence.input.shape.terms.description).toContain('60');
    });

    const messagesFor = (terms: string) =>
      oeisIdentifySequence.input.safeParse({ terms }).error?.issues.map((issue) => issue.message);
    const sixtyOne = Array.from({ length: 61 }, (_, i) => String(i + 1)).join(', ');
    const sixLong = Array.from({ length: 6 }, () => '9'.repeat(200)).join(',');

    it.each([
      [
        'an empty run',
        ',,,',
        'no terms given; supply at least one integer, or _ for one unknown term.',
      ],
      [
        '61 terms',
        sixtyOne,
        '61 terms given; at most 60 are accepted, and about 6 consecutive terms identify a sequence best.',
      ],
      [
        'a decimal',
        '1, 1.5, 2',
        'term 2 ("1.5") is not an integer or _; give integers separated by commas or spaces.',
      ],
      [
        'a semicolon separator',
        '1; 2; 3',
        'term 1 ("1;") is not an integer or _; give integers separated by commas or spaces.',
      ],
      [
        'a long non-integer token, cut in the message',
        `1, ${'x'.repeat(50)}`,
        `term 2 ("${'x'.repeat(20)}…") is not an integer or _; give integers separated by commas or spaces.`,
      ],
      [
        'a 201-digit term',
        `1, -${'9'.repeat(201)}`,
        'term 2 has 201 digits; each term may have at most 200.',
      ],
      [
        'a run over 1000 characters',
        sixLong,
        '1205 characters after normalizing; OEIS takes at most 1000, so give fewer or shorter terms.',
      ],
    ])('rejects %s with one message naming the rule', (_label, terms, message) => {
      expect(messagesFor(terms)).toEqual([message]);
    });

    it('answers a rejected terms with invalid_arguments and no request', async () => {
      const { calls, result } = await identify({ terms: 'a, b' }, page(resultsSearchPage));
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(calls).toHaveLength(0);
    });

    it('carries the rule broken into content[]', async () => {
      const { result } = await identify({ terms: sixtyOne }, page(resultsSearchPage));
      expect(textOf(result)).toContain('terms: 61 terms given; at most 60 are accepted');
    });
  });

  describe('blank and optional inputs', () => {
    it('reads blank matchSigns and start (form clients send "") as the defaults', () => {
      for (const blank of ['', '   ']) {
        expect(
          oeisIdentifySequence.input.parse({ terms: '1,2,3', matchSigns: blank, start: blank }),
        ).toEqual({ terms: '1,2,3', matchSigns: false, start: 0 });
      }
    });

    it('applies the defaults when both are omitted', () => {
      expect(oeisIdentifySequence.input.parse({ terms: '1,2,3' })).toEqual({
        terms: '1,2,3',
        matchSigns: false,
        start: 0,
      });
    });

    it('sends a form-client payload as an unsigned, first-page query', async () => {
      const { calls, result } = await identify(
        { terms: '1, 2, 5, 14', matchSigns: '', start: '' },
        page(resultsSearchPage),
      );
      expect(result.isError).toBeUndefined();
      expect(queryOf(calls[0]).get('q')).toBe('seq:1,2,5,14');
      expect(queryOf(calls[0]).has('start')).toBe(false);
    });

    it.each([0, 10, 50, 100])('accepts start %i', (start) => {
      expect(oeisIdentifySequence.input.parse({ terms: '1,2,3', start }).start).toBe(start);
    });

    it.each([
      ['not a multiple of ten', 5],
      ['past the anonymous window', 110],
      ['negative', -10],
      ['fractional', 10.5],
      ['a numeric string', '20'],
      ['null', null],
      ['a word', 'next'],
    ])('rejects start that is %s', (_label, start) => {
      expect(oeisIdentifySequence.input.safeParse({ terms: '1,2,3', start }).success).toBe(false);
    });

    it.each([
      ['a numeric string', 'true'],
      ['a number', 1],
      ['null', null],
    ])('rejects matchSigns given as %s', (_label, matchSigns) => {
      expect(oeisIdentifySequence.input.safeParse({ terms: '1,2,3', matchSigns }).success).toBe(
        false,
      );
    });
  });

  describe('upstream query', () => {
    it('queries seq: with the normalized run and sends neither start nor sort for the first page', async () => {
      const { calls } = await identify(
        { terms: '[1, 2, 5, 14, 42, ...]' },
        page(resultsSearchPage),
      );
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0]?.url ?? '');
      expect(url.origin + url.pathname).toBe('https://oeis.org/search');
      expect(url.searchParams.get('q')).toBe('seq:1,2,5,14,42');
      expect(url.searchParams.get('fmt')).toBe('text');
      expect(url.searchParams.has('start')).toBe(false);
      expect(url.searchParams.has('sort')).toBe(false);
    });

    it('queries signed: when matchSigns is true, with minus signs intact', async () => {
      const { calls } = await identify(
        { terms: '−1, 1, −1', matchSigns: true },
        page(resultsSearchPage),
      );
      expect(queryOf(calls[0]).get('q')).toBe('signed:-1,1,-1');
    });

    it('keeps wildcards in the query', async () => {
      const { calls } = await identify({ terms: '1, _, 5' }, page(resultsSearchPage));
      expect(queryOf(calls[0]).get('q')).toBe('seq:1,_,5');
    });

    it('sends start for a later page', async () => {
      const { calls } = await identify({ terms: '1,2,3', start: 30 }, page(pageOf(10, 120, 31)));
      expect(queryOf(calls[0]).get('start')).toBe('30');
    });

    it('serves an identical repeat call from cache without a second request', async () => {
      const { calls, service } = serviceOver(page(resultsSearchPage));
      holder.service = service;
      await runToolContract(oeisIdentifySequence, { terms: '1,2,5,14,42' });
      await runToolContract(oeisIdentifySequence, { terms: '[1 2 5 14 42 ...]' });
      expect(calls).toHaveLength(1);
    });
  });

  describe('matchStartIndex', () => {
    it('is the index where the run begins in each row, and absent where the data line lacks it', async () => {
      const { result } = await identify(
        { terms: '1, 2, 5, 14, 42, 132, 429' },
        page(resultsSearchPage),
      );
      const [catalan, fibonacci] = rows(result);
      expect(catalan).toMatchObject({ aNumber: 'A000108', matchStartIndex: 1 });
      expect(fibonacci?.aNumber).toBe('A000045');
      expect(fibonacci).not.toHaveProperty('matchStartIndex');
      expect(textOf(result)).toContain('**Run starts at:** n = 1');
      expect(textOf(result)).toContain('**Run starts at:** not located in the data line');
    });

    it('adds the row firstIndex to the position of the run', async () => {
      const { result } = await identify(
        { terms: '3, 4, 7' },
        page(rowPage({ terms: ['2', '1', '3', '4', '7', '11', '18'], offset: '1,3' })),
      );
      // The run starts at position 2 of a data line whose first term is a(1).
      expect(rows(result)[0]?.matchStartIndex).toBe(3);
    });

    it('reports the first occurrence when the run repeats', async () => {
      const { result } = await identify(
        { terms: '1, 2' },
        page(rowPage({ terms: ['1', '2', '1', '2', '1', '2'], offset: '0,2' })),
      );
      expect(rows(result)[0]?.matchStartIndex).toBe(0);
    });

    it('treats a run at the very end of the data line as located', async () => {
      const { result } = await identify(
        { terms: '5, 8' },
        page(rowPage({ terms: ['1', '2', '3', '5', '8'], offset: '1,2' })),
      );
      expect(rows(result)[0]?.matchStartIndex).toBe(4);
    });

    it('omits it when the run is longer than the data line', async () => {
      const { result } = await identify(
        { terms: '1, 2, 3, 4, 5, 6' },
        page(rowPage({ terms: ['1', '2', '3'], offset: '1,2' })),
      );
      expect(rows(result)[0]).not.toHaveProperty('matchStartIndex');
    });

    it('omits it for a row whose data line is empty', async () => {
      const { result } = await identify(
        { terms: '1, 2, 3' },
        page(rowPage({ terms: [], offset: '1,1' })),
      );
      expect(rows(result)[0]).toMatchObject({ terms: [] });
      expect(rows(result)[0]).not.toHaveProperty('matchStartIndex');
      expect(textOf(result)).toContain('**Terms:** none listed');
    });

    describe('signs', () => {
      const moebius = () =>
        page(
          searchPageText({
            query: 'seq:1,0,1',
            status: 'Showing 1-1 of 1',
            records: [moebiusSearchRecord],
          }),
        );

      it('matches absolute values by default, so a sign difference does not hide the run', async () => {
        const { result } = await identify({ terms: '1, 0, 1' }, moebius());
        // |mu| = 1,1,1,0,1,1,1,0,0,1,1,0 from n = 1: the run 1,0,1 begins at position 2.
        expect(rows(result)[0]?.matchStartIndex).toBe(3);
      });

      it('matches a negative supplied term against its positive data term unless matchSigns', async () => {
        const { result } = await identify({ terms: '-1, -1, 0' }, moebius());
        expect(rows(result)[0]?.matchStartIndex).toBe(2);
      });

      it('requires signs to match with matchSigns: true, and omits the index when they differ', async () => {
        const mismatch = await identify({ terms: '1, 0, 1', matchSigns: true }, moebius());
        expect(rows(mismatch.result)[0]).not.toHaveProperty('matchStartIndex');
        const match = await identify({ terms: '-1, -1, 0', matchSigns: true }, moebius());
        expect(rows(match.result)[0]?.matchStartIndex).toBe(2);
      });

      it('does not let a positive supplied run match the negative data under matchSigns', async () => {
        const { result } = await identify({ terms: '1, 1, 0', matchSigns: true }, moebius());
        expect(rows(result)[0]).not.toHaveProperty('matchStartIndex');
      });
    });

    describe('wildcards', () => {
      it('lets _ match any single term', async () => {
        const { result } = await identify({ terms: '1, _, 5' }, page(resultsSearchPage));
        const [catalan] = rows(result);
        // Catalan from n = 0: 1,1,2,5 — the pattern 1,_,5 first matches at position 1.
        expect(catalan?.matchStartIndex).toBe(1);
      });

      it('matches a lone _ at the first position', async () => {
        const { result } = await identify({ terms: '_' }, page(resultsSearchPage));
        expect(rows(result).map((row) => row.matchStartIndex)).toEqual([0, 0]);
      });

      it('requires every non-wildcard term to match', async () => {
        const { result } = await identify(
          { terms: '1, _, 6' },
          page(rowPage({ terms: ['1', '2', '5'], offset: '1,1' })),
        );
        expect(rows(result)[0]).not.toHaveProperty('matchStartIndex');
      });
    });

    describe('terms past 2^53', () => {
      const near = ['9007199254740992', '9007199254740993', '9007199254740994', '9007199254740995'];

      it('tells neighbours apart where a double cannot', async () => {
        expect(Number(near[0])).toBe(Number(near[1]));
        const { result } = await identify(
          { terms: near[2] ?? '' },
          page(rowPage({ terms: near, offset: '0,1' })),
        );
        expect(rows(result)[0]?.matchStartIndex).toBe(2);
      });

      it('matches a multi-term run among near-identical big terms', async () => {
        const { result } = await identify(
          { terms: `${near[1]}, ${near[2]}` },
          page(rowPage({ terms: near, offset: '5,1' })),
        );
        expect(rows(result)[0]?.matchStartIndex).toBe(6);
      });

      it('does not match an off-by-one big term', async () => {
        const { result } = await identify(
          { terms: '9007199254740996' },
          page(rowPage({ terms: near, offset: '0,1' })),
        );
        expect(rows(result)[0]).not.toHaveProperty('matchStartIndex');
      });

      it('compares 30-digit terms exactly, signs included', async () => {
        const big = '123456789012345678901234567890';
        const bigger = '123456789012345678901234567891';
        const matched = await identify(
          { terms: `-${bigger}`, matchSigns: true },
          page(rowPage({ terms: [big, `-${bigger}`], offset: '0,1' })),
        );
        expect(rows(matched.result)[0]?.matchStartIndex).toBe(1);
        const unsigned = await identify(
          { terms: bigger },
          page(rowPage({ terms: [big, `-${bigger}`], offset: '0,1' })),
        );
        expect(rows(unsigned.result)[0]?.matchStartIndex).toBe(1);
        const signed = await identify(
          { terms: bigger, matchSigns: true },
          page(rowPage({ terms: [big, `-${bigger}`], offset: '0,1' })),
        );
        expect(rows(signed.result)[0]).not.toHaveProperty('matchStartIndex');
      });

      it('echoes the terms in the output as exact strings', async () => {
        const { result } = await identify(
          { terms: near[0] ?? '' },
          page(rowPage({ terms: near, offset: '0,1' })),
        );
        expect(rows(result)[0]?.terms).toEqual(near);
      });
    });
  });

  describe('paging', () => {
    it('offers nextStart 10 and truncated enrichment for a first page of a longer list', async () => {
      const { result } = await identify({ terms: '1,2,3,4' }, page(pageOf(10, 26)));
      expect(structured(result)).toMatchObject({
        start: 0,
        nextStart: 10,
        truncated: true,
        shown: 10,
        cap: 10,
        totalCount: 26,
        notice: 'Showing 1-10 of 26; call again with start 10 for the next page.',
      });
      expect(rows(result)).toHaveLength(10);
      expect(textOf(result)).toContain('**Next page:** call again with start 10.');
    });

    it('continues from a middle page and numbers rows by their rank', async () => {
      const { result } = await identify({ terms: '1,2,3,4', start: 10 }, page(pageOf(10, 26, 11)));
      expect(structured(result)).toMatchObject({ start: 10, nextStart: 20, truncated: true });
      expect(structured(result).notice).toContain('Showing 11-20 of 26');
      expect(textOf(result)).toContain('## 11. A100000:');
      expect(textOf(result)).toContain('## 20. A100009:');
    });

    it('ends on the last page: no nextStart, not truncated', async () => {
      const { result } = await identify({ terms: '1,2,3,4', start: 20 }, page(pageOf(6, 26, 21)));
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result)).toMatchObject({ truncated: false, shown: 6, totalCount: 26 });
      expect(structured(result).notice).toBeUndefined();
      expect(textOf(result)).not.toContain('Next page');
    });

    it('treats a full final page as the end when the total equals what has been shown', async () => {
      const { result } = await identify({ terms: '1,2,3,4', start: 10 }, page(pageOf(10, 20, 11)));
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result)).toMatchObject({ truncated: false, shown: 10 });
    });

    it('ends nextStart at 100: page 100 of a longer list names the window, not another page', async () => {
      const { result } = await identify(
        { terms: '1,2,3,4', start: 100 },
        page(pageOf(10, 150, 101)),
      );
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result)).toMatchObject({
        truncated: true,
        shown: 10,
        totalCount: 150,
      });
      expect(structured(result).notice).toContain('only the first 110 of 150 matches');
      expect(structured(result).notice).toContain('add more consecutive terms');
      expect(textOf(result)).not.toContain('Next page');
    });

    it('still offers start 100 from page 90 of a longer list', async () => {
      const { result } = await identify({ terms: '1,2,3,4', start: 90 }, page(pageOf(10, 150, 91)));
      expect(structured(result)).toMatchObject({ start: 90, nextStart: 100 });
    });

    it('does not truncate at start 100 when the list ends exactly at 110', async () => {
      const { result } = await identify(
        { terms: '1,2,3,4', start: 100 },
        page(pageOf(10, 110, 101)),
      );
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result)).toMatchObject({ truncated: false });
    });

    it.each([30, 100])(
      'labels a start of %i past the end as the last page OEIS served, from start 20',
      async (start) => {
        const { result } = await identify(
          { terms: '1, 2, 5, 14, 42, 132, 429', start },
          page(clampedSearchPage),
        );
        expect(result.isError).toBeUndefined();
        expect(structured(result)).toMatchObject({
          start: 20,
          truncated: false,
          shown: 6,
          totalCount: 26,
          notice: `Start ${start} is past the last of 26 results; this is the last page, from start 20.`,
        });
        expect(structured(result)).not.toHaveProperty('nextStart');
        expect(rows(result)).toHaveLength(6);
        expect(textOf(result)).toContain('# Sequence candidates (start 20)');
        expect(textOf(result)).toContain('## 21. A100000:');
        expect(textOf(result)).toContain('## 26. A100005:');
        expect(textOf(result)).not.toContain('## 31.');
      },
    );

    it('reads the anonymous paging cap (403 past result 110) as result_window_exceeded', async () => {
      const { calls, result } = await identify(
        { terms: '1,2,3,4', start: 100 },
        res(signInRefusalBody, { status: 403 }),
      );
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'result_window_exceeded' },
      });
      expect(errorOf(result).message).toContain('first 110 results');
      expect(calls).toHaveLength(1);
    });
  });

  describe('required enrichment', () => {
    it('carries truncated, shown, and cap on the zero-result page', async () => {
      const { result } = await identify({ terms: '1, 2, 5, 14, 42' }, page(noResultsSearchPage));
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({
        results: [],
        start: 0,
        truncated: false,
        shown: 0,
        cap: 10,
        totalCount: 0,
        effectiveQuery: 'id:axyz',
      });
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result).notice).toEqual(expect.any(String));
      expect(textOf(result)).toContain('No matching sequences on this page.');
    });

    it('carries truncated, shown, and cap on an under-cap page', async () => {
      const { result } = await identify(
        { terms: '1, 2, 5, 14, 42, 132, 429' },
        page(resultsSearchPage),
      );
      const out = structured(result);
      expect(rows(result)).toHaveLength(2);
      expect(out).toMatchObject({ truncated: true, shown: 2, cap: 10, totalCount: 26 });
    });

    it('carries them on an under-cap page that is the whole list', async () => {
      const { result } = await identify({ terms: '1, 2, 5, 14, 42, 132' }, page(pageOf(3, 3)));
      expect(structured(result)).toMatchObject({
        truncated: false,
        shown: 3,
        cap: 10,
        totalCount: 3,
        effectiveQuery: 'seq:1,2,3',
      });
      expect(structured(result).notice).toBeUndefined();
      expect(structured(result)).not.toHaveProperty('nextStart');
    });

    it('carries them on a too-many page, with no totalCount', async () => {
      const { result } = await identify({ terms: '1, 2, 3, 4' }, page(tooManySearchPage));
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({
        results: [],
        truncated: false,
        shown: 0,
        cap: 10,
      });
      expect(structured(result)).not.toHaveProperty('totalCount');
    });

    it('carries them on a full page', async () => {
      const { result } = await identify({ terms: '1,2,3,4,5,6' }, page(pageOf(10, 10)));
      expect(structured(result)).toMatchObject({
        truncated: false,
        shown: 10,
        cap: 10,
        totalCount: 10,
      });
    });

    it('renders the enrichment block in content[]', async () => {
      const { result } = await identify({ terms: '1, 2, 5, 14, 42' }, page(resultsSearchPage));
      const text = textOf(result);
      expect(text).toContain('**truncated:** true');
      expect(text).toContain('**shown:** 2');
      expect(text).toContain('**cap:** 10');
      expect(text).toContain('**26 total**');
      expect(text).toContain('Query: seq:1,2,5,14,42,132,429');
    });
  });

  describe('notices', () => {
    const noticeFor = async (input: Record<string, unknown>, body = noResultsSearchPage) => {
      const { result } = await identify(input, page(body));
      expect(result.isError).toBeUndefined();
      return structured(result).notice as string;
    };
    const POINTER = 'For words, formulas, or prefixes call oeis_search_sequences';
    const RETRY_ORDER = 'Drop the first term or two and retry';
    const SIGNS = 'Retry with matchSigns false to ignore sign conventions.';
    const LEADING = 'Leading 0s and 1s are often omitted or differ between sources; drop them.';
    const FEW = 'Few terms match many sequences; about 6 consecutive terms narrow the result.';

    it('always opens with the data-line statement and closes with the search pointer', async () => {
      const notice = await noticeFor({ terms: '3, 7, 12, 19, 28' });
      expect(
        notice.startsWith('No OEIS entry contains these terms consecutively in its data line.'),
      ).toBe(true);
      expect(notice).toContain(POINTER);
      expect(notice.endsWith('oeis_list_reference topic search_syntax lists the syntax.')).toBe(
        true,
      );
    });

    it('suggests dropping leading terms from five terms up, not below', async () => {
      expect(await noticeFor({ terms: '3, 7, 12, 19, 28' })).toContain(RETRY_ORDER);
      expect(await noticeFor({ terms: '3, 7, 12, 19' })).not.toContain(RETRY_ORDER);
    });

    it('suggests matchSigns false only when matchSigns was true', async () => {
      expect(await noticeFor({ terms: '3, 7, 12, 19', matchSigns: true })).toContain(SIGNS);
      expect(await noticeFor({ terms: '3, 7, 12, 19', matchSigns: false })).not.toContain(SIGNS);
    });

    it.each(['0, 5, 7, 11', '1, 5, 7, 11', '-1, 5, 7, 11'])(
      'flags a leading 0 or 1 in %j',
      async (terms) => {
        expect(await noticeFor({ terms })).toContain(LEADING);
      },
    );

    it.each(['2, 5, 7, 11', '5, 0, 1, 11', '_, 5, 7, 11', '10, 5, 7, 11'])(
      'does not flag %j as starting with 0 or 1',
      async (terms) => {
        expect(await noticeFor({ terms })).not.toContain(LEADING);
      },
    );

    it('names the common factor and the divided run when every term shares one', async () => {
      const notice = await noticeFor({ terms: '6, 12, 18, 30' });
      expect(notice).toContain('The terms share a common factor of 6; try the terms divided by 6.');
    });

    it('computes the factor over absolute values, skipping zeros and wildcards', async () => {
      expect(await noticeFor({ terms: '-4, 8, _, 0, 12' })).toContain('common factor of 4;');
      expect(await noticeFor({ terms: '0, 0, 9, 0' })).not.toContain('common factor');
    });

    it('computes the factor exactly for terms past 2^53', async () => {
      const g = '9007199254740993';
      const doubled = (BigInt(g) * 2n).toString();
      const tripled = (BigInt(g) * 3n).toString();
      expect(await noticeFor({ terms: `${doubled}, ${tripled}` })).toContain(
        `common factor of ${g}; try the terms divided by ${g}.`,
      );
    });

    it.each(['3, 7, 12, 19', '1, 2, 3, 4', '5, 9', '7'])(
      'names no factor for %j',
      async (terms) => {
        expect(await noticeFor({ terms })).not.toContain('common factor');
      },
    );

    it('adds the few-terms notice below four numeric terms, counting wildcards as unknown', async () => {
      expect(await noticeFor({ terms: '3, 7, 12' })).toContain(FEW);
      expect(await noticeFor({ terms: '3, _, 12, 19' })).toContain(FEW);
      expect(await noticeFor({ terms: '3, 7, 12, 19' })).not.toContain(FEW);
    });

    it('composes every condition that holds into one notice', async () => {
      const notice = await noticeFor({ terms: '2, 4, 6, 8, 10', matchSigns: true });
      for (const part of [RETRY_ORDER, SIGNS, 'common factor of 2', POINTER]) {
        expect(notice).toContain(part);
      }
      expect(notice).not.toContain(LEADING);
    });

    it('reports a too-many page with the narrowing advice and no zero-hit text', async () => {
      const notice = await noticeFor({ terms: '1, 2, 3, 4, 5' }, tooManySearchPage);
      expect(notice).toBe(
        'OEIS matched too many entries to list for these terms. Add more consecutive terms.',
      );
    });

    it('adds the few-terms notice to a too-many page and to a page that has results', async () => {
      const tooMany = await noticeFor({ terms: '1, 2' }, tooManySearchPage);
      expect(tooMany).toContain('too many entries');
      expect(tooMany).toContain(FEW);
      const withResults = await noticeFor({ terms: '1, 2, 5' }, pageOf(2, 2));
      expect(withResults).toBe(FEW);
    });

    it('joins the few-terms notice and the paging guidance into the truncation guidance', async () => {
      const { result } = await identify({ terms: '1, 2, 5' }, page(pageOf(10, 26)));
      expect(structured(result)).toMatchObject({ truncated: true, nextStart: 10 });
      expect(structured(result).notice).toBe(
        `${FEW} Showing 1-10 of 26; call again with start 10 for the next page.`,
      );
    });

    it('has no notice when results are complete and enough terms were given', async () => {
      const { result } = await identify({ terms: '1, 2, 5, 14' }, page(pageOf(2, 2)));
      expect(structured(result).notice).toBeUndefined();
    });
  });

  describe('upstream failures', () => {
    it('reports an unknown status line once, as non-retryable upstream_unparseable', async () => {
      const { calls, result } = await identify(
        { terms: '1,2,3,4' },
        page(searchPageText({ query: 'seq:1,2,3,4', status: 'Something new' })),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unparseable', retryable: false },
      });
      expect(calls).toHaveLength(1);
    });

    it('surfaces an edge 403 as upstream_refused, never Forbidden, without retrying', async () => {
      const { calls, result } = await identify(
        { terms: '1,2,3,4' },
        res('<html>Attention Required</html>', { status: 403 }),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_refused', retryable: false },
      });
      expect(calls).toHaveLength(1);
    });

    it('surfaces a 429 through the upstream_rate_limited contract: retryAfter plus the wait in content[]', async () => {
      const { calls, result } = await identify(
        { terms: '1,2,3,4' },
        res('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'upstream_rate_limited',
          retryAfter: '120',
          recovery: { hint: expect.stringContaining('oeis_identify_sequence again') },
        },
      });
      expect(textOf(result)).toContain('Recovery: oeis.org answered 429 Too Many Requests;');
      expect(textOf(result)).toContain('or 30 seconds if none is shown');
      expect(textOf(result)).toContain('reason upstream_rate_limited');
      expect(calls).toHaveLength(1);
    });

    it('does not follow a redirect from /search', async () => {
      const { calls, result } = await identify(
        { terms: '1,2,3,4' },
        res(null, { status: 301, headers: { location: 'https://oeis.org/' } }),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(calls).toHaveLength(1);
    });

    it('treats a 404 on /search as an error, not an empty result', async () => {
      const { result } = await identify({ terms: '1,2,3,4' }, res('nope', { status: 404 }));
      expect(result.isError).toBe(true);
    });

    describe('retried classes', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      const run = async (steps: ReturnType<typeof res>[]) => {
        const { calls, service } = serviceOver(...steps);
        holder.service = service;
        const result = await withBackoff(
          runToolContract(oeisIdentifySequence, { terms: '1,2,3,4' }),
        );
        return { calls, result };
      };

      it('retries a 5xx and then reports ServiceUnavailable with the attempt count', async () => {
        const { calls, result } = await run([res('oops', { status: 502 })]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { retryAttempts: 3 },
        });
        expect(calls).toHaveLength(3);
      });

      it('recovers when a 503 is followed by a good page', async () => {
        const { calls, result } = await run([
          res('oops', { status: 503 }),
          page(resultsSearchPage),
        ]);
        expect(result.isError).toBeUndefined();
        expect(rows(result)).toHaveLength(2);
        expect(calls).toHaveLength(2);
      });

      it('reports an HTML maintenance page as retryable upstream_unparseable', async () => {
        const { calls, result } = await run([res(htmlMaintenanceBody, { status: 200 })]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unparseable', retryAttempts: 3 },
        });
        expect(calls).toHaveLength(3);
      });

      it('reports an empty body as upstream_unparseable', async () => {
        const { result } = await run([res('', { status: 200 })]);
        expect(errorOf(result).data).toMatchObject({ reason: 'upstream_unparseable' });
      });

      it('maps a network failure to "oeis.org is unreachable"', async () => {
        const { result } = await run([new TypeError('fetch failed')]);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(errorOf(result).message).toContain('oeis.org is unreachable.');
      });

      it('maps the per-attempt timer firing to Timeout', async () => {
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
          AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
        );
        const { result } = await run([new DOMException('timed out', 'TimeoutError')]);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.Timeout);
        expect(errorOf(result).message).toContain('OEIS did not answer within 15 s.');
      });
    });

    it('sheds a queued call through the pacer_shed contract: RateLimited, retryable, with recovery', async () => {
      const pacer = createPacer({
        name: 'oeis-tool-test',
        minStartGapMs: 10_000,
        maxConcurrent: 1,
      });
      try {
        const { calls, fetch } = scriptedFetch(page(resultsSearchPage));
        holder.service = new OeisService({ fetch, pacer, queueMaxWaitMs: 1_000 });
        const first = await runToolContract(oeisIdentifySequence, { terms: '1,2,5,14' });
        expect(first.isError).toBeUndefined();
        const shed = await runToolContract(oeisIdentifySequence, { terms: '1,2,5,15' });
        expect(shed.isError).toBe(true);
        expect(errorOf(shed)).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'pacer_shed',
            retryAfter: expect.anything(),
            recovery: { hint: expect.stringContaining('oeis_identify_sequence again') },
          },
        });
        expect(textOf(shed)).toContain('reason pacer_shed');
        expect(calls).toHaveLength(1);
      } finally {
        pacer.dispose();
      }
    });
  });

  describe('partial rows', () => {
    it('keeps a row with no keywords and renders none', async () => {
      const { result } = await identify(
        { terms: '1, 2, 3' },
        page(rowPage({ keywords: '', terms: ['1', '2', '3'], offset: '1,1' })),
      );
      expect(rows(result)[0]).toMatchObject({ keywords: [] });
      expect(textOf(result)).toContain('**Keywords:** none');
    });

    it('declares its pacer_shed and upstream_rate_limited contracts with the design code and the retry hint', () => {
      expect(oeisIdentifySequence.errors).toEqual([
        expect.objectContaining({
          reason: 'pacer_shed',
          code: JsonRpcErrorCode.RateLimited,
          retryable: true,
        }),
        expect.objectContaining({
          reason: 'upstream_rate_limited',
          code: JsonRpcErrorCode.RateLimited,
          retryable: true,
          thrownBy: 'service',
          recovery: expect.stringContaining('oeis_identify_sequence again'),
        }),
      ]);
    });
  });

  describe('format', () => {
    it('carries the rank, A-number, name, run position, terms, offset, keywords, and URL of every row', async () => {
      const { result } = await identify({ terms: '1, 2, 5, 14, 42' }, page(resultsSearchPage));
      const text = textOf(result);
      for (const row of rows(result)) {
        expect(text).toContain(row.aNumber);
        expect(text).toContain(row.name);
        expect(text).toContain(`**Terms:** ${row.terms.join(', ')}`);
        expect(text).toContain(`https://oeis.org/${row.aNumber}`);
      }
      expect(text).toContain('# Sequence candidates (start 0)');
      expect(text).toContain('## 1. A000108:');
      expect(text).toContain('## 2. A000045:');
      expect(text).toContain('**Offset:** 0,3 (first term is a(0))');
      expect(text).toContain('**Keywords:** core, nonn, easy, eigen, nice, changed');
      expect(text).toContain('**Run starts at:** n = 1');
    });

    it('prints the zero-result page heading and the guidance from the enrichment block', async () => {
      const { result } = await identify({ terms: '1, 2, 5, 14, 42' }, page(noResultsSearchPage));
      const text = textOf(result);
      expect(text).toContain('# Sequence candidates (start 0)');
      expect(text).toContain('No matching sequences on this page.');
      expect(text).toContain(`> ${structured(result).notice}`);
    });

    it('flattens CR/LF in every inline slot of a hand-built output', () => {
      const blocks = oeisIdentifySequence.format?.({
        results: [
          {
            aNumber: 'A000001',
            name: 'a\nb\r\nc',
            terms: ['1', '2\n3'],
            offset: '0,1\n# x',
            firstIndex: 0,
            keywords: ['nonn\n## y', 'easy'],
            url: 'https://oeis.org/A000001',
          },
        ],
        start: 10,
      });
      const text = blocksText(blocks);
      expect(text).toContain('## 11. A000001: a b c');
      expect(text).toContain('**Terms:** 1, 2 3');
      expect(text).toContain('**Offset:** 0,1 # x (first term is a(0))');
      expect(text).toContain('**Keywords:** nonn ## y, easy');
      expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
        '# Sequence candidates (start 10)',
        '## 11. A000001: a b c',
      ]);
      expect(text).toContain('**Run starts at:** not located in the data line');
    });

    it('renders nextStart only when present', () => {
      const base = { results: [], start: 20 };
      expect(blocksText(oeisIdentifySequence.format?.(base))).not.toContain('Next page');
      expect(blocksText(oeisIdentifySequence.format?.({ ...base, nextStart: 30 }))).toContain(
        '**Next page:** call again with start 30.',
      );
    });
  });
});
