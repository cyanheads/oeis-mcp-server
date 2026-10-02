/**
 * @fileoverview Tests for oeis_search_sequences through the tool contract over a real OeisService
 * with a scripted fetch: query/sort/start input and blank form-client values, the query sent
 * upstream, paging to start 100 and the result-window refusal past it, the zero-hit, unknown-prefix,
 * too-many, and start-past-total notices, required enrichment on the zero-result and under-cap
 * pages, upstream failure classes, and `format()` parity with `structuredContent`.
 * @module tests/tools/oeis-search-sequences.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oeisSearchSequences } from '@/mcp-server/tools/definitions/oeis-search-sequences.tool.js';
import { OeisService } from '@/services/oeis/oeis-service.js';
import {
  capturedSearchRecords,
  clampedSearchPage,
  htmlMaintenanceBody,
  moebiusSearchRecord,
  noResultsSearchPage,
  reservedSearchRecordText,
  resultsSearchPage,
  searchPageText,
  signInRefusalBody,
  syntheticSearchPage,
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
type Row = {
  aNumber: string;
  author?: string;
  firstIndex: number;
  keywords: string[];
  legacyIds?: string[];
  modified?: string;
  name: string;
  offset: string;
  terms: string[];
  url: string;
};

const page = (body: string) => res(body, { status: 200 });

async function search(
  input: Record<string, unknown>,
  ...steps: ReturnType<typeof res>[]
): Promise<{ calls: ReturnType<typeof serviceOver>['calls']; result: Result }> {
  const { calls, service } = serviceOver(...steps);
  holder.service = service;
  return { calls, result: await runToolContract(oeisSearchSequences, input as never) };
}

const structured = (result: Result) => result.structuredContent as Record<string, unknown>;
const rows = (result: Result) => structured(result).results as Row[];
const textOf = (result: Result) =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
const errorOf = (result: Result) =>
  structured(result).error as { code: number; data: Record<string, unknown>; message: string };

afterEach(() => {
  holder.service = undefined;
});

describe('oeis_search_sequences', () => {
  describe('input', () => {
    it('trims the query and applies the sort and start defaults', () => {
      expect(oeisSearchSequences.input.parse({ query: '  keyword:core fibonacci \n' })).toEqual({
        query: 'keyword:core fibonacci',
        sort: 'relevance',
        start: 0,
      });
    });

    it('reads blank sort and start (form clients send "") as the defaults', () => {
      for (const blank of ['', '   ', '\t']) {
        expect(oeisSearchSequences.input.parse({ query: 'a', sort: blank, start: blank })).toEqual({
          query: 'a',
          sort: 'relevance',
          start: 0,
        });
      }
    });

    it.each(['', '   ', '\n\t'])('rejects the blank query %j', (query) => {
      expect(oeisSearchSequences.input.safeParse({ query }).success).toBe(false);
    });

    it('rejects a missing, null, or non-string query', () => {
      expect(oeisSearchSequences.input.safeParse({}).success).toBe(false);
      expect(oeisSearchSequences.input.safeParse({ query: null }).success).toBe(false);
      expect(oeisSearchSequences.input.safeParse({ query: 5 }).success).toBe(false);
      expect(oeisSearchSequences.input.safeParse({ query: ['a'] }).success).toBe(false);
    });

    it('accepts 1000 characters and rejects 1001, measured after the trim', () => {
      expect(oeisSearchSequences.input.safeParse({ query: 'a'.repeat(1000) }).success).toBe(true);
      expect(
        oeisSearchSequences.input.safeParse({ query: `  ${'a'.repeat(1000)}  ` }).success,
      ).toBe(true);
      expect(oeisSearchSequences.input.safeParse({ query: 'a'.repeat(1001) }).success).toBe(false);
    });

    it.each(['relevance', 'number', 'created', 'modified'])('accepts sort %s', (sort) => {
      expect(oeisSearchSequences.input.parse({ query: 'a', sort }).sort).toBe(sort);
    });

    it.each(['references', 'Number', 'bogus', 5, null])('rejects sort %j', (sort) => {
      expect(oeisSearchSequences.input.safeParse({ query: 'a', sort }).success).toBe(false);
    });

    it.each([0, 10, 50, 100])('accepts start %i', (start) => {
      expect(oeisSearchSequences.input.parse({ query: 'a', start }).start).toBe(start);
    });

    it.each([
      ['not a multiple of ten', 5],
      ['past the anonymous window', 110],
      ['negative', -10],
      ['fractional', 10.5],
      ['a numeric string', '20'],
      ['null', null],
    ])('rejects start that is %s', (_label, start) => {
      expect(oeisSearchSequences.input.safeParse({ query: 'a', start }).success).toBe(false);
    });

    it('answers a blank query with invalid_arguments and no request', async () => {
      const { calls, result } = await search({ query: '  ' }, page(resultsSearchPage));
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(calls).toHaveLength(0);
    });

    it('answers an out-of-window start with invalid_arguments and no request', async () => {
      const { calls, result } = await search({ query: 'a', start: 110 }, page(resultsSearchPage));
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('upstream query', () => {
    it('sends the query as written and neither sort nor start for the first relevance page', async () => {
      const { calls } = await search(
        { query: '  keyword:core "Catalan numbers" -author:Sloane | id:A000045 ' },
        page(resultsSearchPage),
      );
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0]?.url ?? '');
      expect(url.origin + url.pathname).toBe('https://oeis.org/search');
      expect(url.searchParams.get('q')).toBe(
        'keyword:core "Catalan numbers" -author:Sloane | id:A000045',
      );
      expect(url.searchParams.get('fmt')).toBe('text');
      expect(url.searchParams.has('sort')).toBe(false);
      expect(url.searchParams.has('start')).toBe(false);
    });

    it('sends sort for the three non-default orders and start from 10 up', async () => {
      const { calls } = await search(
        { query: 'fibonacci', sort: 'modified', start: 20 },
        page(syntheticSearchPage({ count: 10, firstRow: 21, total: 80 })),
      );
      expect(queryOf(calls[0]).get('sort')).toBe('modified');
      expect(queryOf(calls[0]).get('start')).toBe('20');
      const created = await search({ query: 'a', sort: 'created' }, page(resultsSearchPage));
      expect(queryOf(created.calls[0]).get('sort')).toBe('created');
      const byNumber = await search({ query: 'a', sort: 'number' }, page(resultsSearchPage));
      expect(queryOf(byNumber.calls[0]).get('sort')).toBe('number');
    });

    it('omits sort when relevance is given explicitly or sent blank', async () => {
      const explicit = await search({ query: 'a', sort: 'relevance' }, page(resultsSearchPage));
      expect(queryOf(explicit.calls[0]).has('sort')).toBe(false);
      const blank = await search({ query: 'a', sort: '', start: '' }, page(resultsSearchPage));
      expect(blank.result.isError).toBeUndefined();
      expect(queryOf(blank.calls[0]).has('sort')).toBe(false);
      expect(queryOf(blank.calls[0]).has('start')).toBe(false);
      expect(structured(blank.result)).toMatchObject({ sort: 'relevance', start: 0 });
    });

    it('percent-encodes reserved characters of the query so they stay one parameter', async () => {
      const { calls } = await search({ query: 'a&sort=number #x' }, page(resultsSearchPage));
      expect(queryOf(calls[0]).get('q')).toBe('a&sort=number #x');
      expect(queryOf(calls[0]).has('sort')).toBe(false);
    });

    it('serves a repeated identical query from the cache', async () => {
      const { service, calls } = serviceOver(page(resultsSearchPage));
      holder.service = service;
      await runToolContract(oeisSearchSequences, { query: 'catalan' });
      const second = await runToolContract(oeisSearchSequences, { query: 'catalan' });
      expect(second.isError).toBeUndefined();
      expect(rows(second)).toHaveLength(2);
      expect(calls).toHaveLength(1);
    });
  });

  describe('results and paging', () => {
    it('maps each hit to a summary row, with the applied sort echoed', async () => {
      const { result } = await search({ query: '1,2,5,14,42,132,429' }, page(resultsSearchPage));
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({ start: 0, sort: 'relevance' });
      expect(rows(result)).toEqual([
        {
          aNumber: 'A000108',
          name: 'Catalan numbers: C(n) = binomial(2n,n)/(n+1) = (2n)!/(n!(n+1)!).',
          terms: ['1', '1', '2', '5', '14', '42', '132', '429', '1430', '4862', '16796', '58786'],
          offset: '0,3',
          firstIndex: 0,
          keywords: ['core', 'nonn', 'easy', 'eigen', 'nice', 'changed'],
          author: '_N. J. A. Sloane_, Apr 30 1991',
          modified: '2026-09-15T21:11:07-04:00',
          legacyIds: ['M1459', 'N0577'],
          url: 'https://oeis.org/A000108',
        },
        expect.objectContaining({ aNumber: 'A000045', firstIndex: 0 }),
      ]);
    });

    it('carries author, modified, and legacyIds on each row, and leaves out what a row lacks', async () => {
      const body = searchPageText({
        query: 'keyword:core',
        status: 'Showing 1-4 of 4',
        records: [
          capturedSearchRecords.A000045,
          capturedSearchRecords.A399236,
          capturedSearchRecords.A397217,
          capturedSearchRecords.A395050,
        ],
      });
      const { result } = await search({ query: 'keyword:core', sort: 'modified' }, page(body));
      expect(result.isError).toBeUndefined();
      const [fibonacci, knight, reserved, recycled] = rows(result);
      expect(fibonacci).toMatchObject({
        aNumber: 'A000045',
        author: '_N. J. A. Sloane_, 1964',
        modified: '2026-09-23T16:08:09-04:00',
        legacyIds: ['M0692', 'N0256'],
      });
      expect(knight).toMatchObject({
        aNumber: 'A399236',
        author: '_Benjamin Simon Strang_, Aug 23 2026',
        modified: '2026-10-01T14:35:22-04:00',
      });
      expect(knight).not.toHaveProperty('legacyIds');
      expect(reserved).toMatchObject({ aNumber: 'A397217', modified: '2026-09-29T20:19:41-04:00' });
      expect(recycled).toMatchObject({ aNumber: 'A395050', modified: '2026-09-22T17:49:40-04:00' });
      for (const row of [reserved, recycled]) {
        expect(row).not.toHaveProperty('author');
        expect(row).not.toHaveProperty('legacyIds');
      }

      const sections = textOf(result).split('\n\n## ').slice(1);
      expect(sections[0]).toContain(
        [
          '**Keywords:** nonn, core, nice, easy, hear, changed',
          '**Author:** _N. J. A. Sloane_, 1964',
          '**Legacy IDs:** M0692, N0256',
          '**Modified:** 2026-09-23T16:08:09-04:00',
          '**URL:** https://oeis.org/A000045',
        ].join('\n'),
      );
      expect(sections[1]).toContain('**Author:** _Benjamin Simon Strang_, Aug 23 2026');
      expect(sections[1]).not.toContain('**Legacy IDs:**');
      for (const [i, row] of [reserved, recycled].entries()) {
        expect(sections[i + 2]).toContain(`**Modified:** ${row?.modified}`);
        expect(sections[i + 2]).not.toContain('**Author:**');
        expect(sections[i + 2]).not.toContain('**Legacy IDs:**');
      }
    });

    it('carries the fields on every row of a full page and of the last page OEIS clamps to', async () => {
      const full = await search(
        { query: 'prime', start: 10 },
        page(syntheticSearchPage({ count: 10, firstRow: 11, total: 183 })),
      );
      const clamped = await search({ query: '1,2,5,14,42', start: 30 }, page(clampedSearchPage));
      expect(structured(full.result)).toMatchObject({ truncated: true, shown: 10, nextStart: 20 });
      expect(structured(clamped.result)).toMatchObject({ start: 20, shown: 6 });
      for (const { result } of [full, clamped]) {
        for (const row of rows(result)) {
          expect(row).toMatchObject({
            author: '_N. J. A. Sloane_, Apr 30 1991',
            modified: '2026-09-15T21:11:07-04:00',
            legacyIds: ['M0692', 'N0256'],
          });
        }
        expect(textOf(result).match(/\*\*Modified:\*\* /g)).toHaveLength(rows(result).length);
      }
    });

    it('keeps signed terms and a non-zero first index', async () => {
      const { result } = await search(
        { query: 'id:A008683' },
        page(
          searchPageText({
            query: 'id:a008683',
            status: 'Showing 1-1 of 1',
            records: [moebiusSearchRecord],
          }),
        ),
      );
      expect(rows(result)[0]).toMatchObject({
        aNumber: 'A008683',
        terms: expect.arrayContaining(['-1', '0', '1']),
        firstIndex: 1,
      });
    });

    it('offers nextStart when more rows follow within the window', async () => {
      const { result } = await search(
        { query: 'prime', start: 10 },
        page(syntheticSearchPage({ count: 10, firstRow: 11, total: 183 })),
      );
      expect(structured(result)).toMatchObject({
        start: 10,
        nextStart: 20,
        truncated: true,
        shown: 10,
        cap: 10,
        totalCount: 183,
      });
      expect(structured(result).notice).toBe(
        'Showing 11-20 of 183; call again with start 20 for the next page.',
      );
    });

    it('walks start 90 to 100 and stops there, naming the 110-result window', async () => {
      const at90 = await search(
        { query: 'keyword:core', start: 90 },
        page(syntheticSearchPage({ count: 10, firstRow: 91, total: 183 })),
      );
      expect(structured(at90.result)).toMatchObject({ start: 90, nextStart: 100 });

      const at100 = await search(
        { query: 'keyword:core', start: 100 },
        page(syntheticSearchPage({ count: 10, firstRow: 101, total: 183 })),
      );
      expect(structured(at100.result)).toMatchObject({
        start: 100,
        truncated: true,
        shown: 10,
        totalCount: 183,
      });
      expect(structured(at100.result)).not.toHaveProperty('nextStart');
      expect(structured(at100.result).notice).toBe(
        'OEIS lists only the first 110 of 183 matches without an account; add a word, a quoted phrase, or a prefix to narrow the query.',
      );
      expect(queryOf(at100.calls[0]).get('start')).toBe('100');
    });

    it('has no nextStart or window notice when start 100 holds the last rows', async () => {
      const { result } = await search(
        { query: 'keyword:core', start: 100 },
        page(syntheticSearchPage({ count: 5, firstRow: 101, total: 105 })),
      );
      expect(structured(result)).toMatchObject({ truncated: false, shown: 5, totalCount: 105 });
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result).notice).toBeUndefined();
    });

    it('ends paging on a short last page', async () => {
      const { result } = await search(
        { query: 'a', start: 20 },
        page(syntheticSearchPage({ count: 3, firstRow: 21, total: 23 })),
      );
      expect(rows(result)).toHaveLength(3);
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result)).toMatchObject({ truncated: false, shown: 3 });
    });

    it('turns the anonymous paging-cap 403 into the result_window_exceeded validation error', async () => {
      const { calls, result } = await search(
        { query: 'keyword:core', start: 100 },
        res(signInRefusalBody, { status: 403 }),
      );
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'result_window_exceeded' },
      });
      expect(errorOf(result).message).toContain('narrow the query instead of paging deeper');
      expect(calls).toHaveLength(1);
    });
  });

  describe('zero-hit and refusal notices', () => {
    const noticeFor = async (input: Record<string, unknown>, body = noResultsSearchPage) => {
      const { result } = await search(input, page(body));
      expect(result.isError).toBeUndefined();
      return structured(result).notice as string;
    };
    const LOOSEN =
      'Loosen the query: drop a prefix filter or a quoted phrase, or use | between alternatives.';
    const SYNTAX = 'oeis_list_reference topic search_syntax lists the valid prefixes.';
    const NUMBERS =
      'Drop the first term or two and retry, since sources disagree on where a sequence starts; or put subseq: before the terms to match them with other terms in between.';

    it('answers an ordinary miss with the loosening advice alone', async () => {
      expect(await noticeFor({ query: 'zzzz qqqq' })).toBe(LOOSEN);
    });

    it('flags an unknown prefix as searched-as-words, with the syntax pointer and no loosening advice', async () => {
      const notice = await noticeFor({ query: 'kewyord:core' });
      expect(notice).toBe(
        `"kewyord:" is not an OEIS prefix, so OEIS searched it as plain words. ${SYNTAX}`,
      );
    });

    it('lists several unknown prefixes once each, in the plural form', async () => {
      const notice = await noticeFor({ query: 'foo:a bar:b foo:c' });
      expect(notice).toBe(
        `"foo:", "bar:" are not OEIS prefixes, so OEIS searched them as plain words. ${SYNTAX}`,
      );
    });

    it('treats | and - as token separators when looking for prefixes', async () => {
      expect(await noticeFor({ query: 'foo:a|bar:b' })).toContain('"foo:", "bar:" are not');
      expect(await noticeFor({ query: '-foo:a' })).toContain('"foo:" is not an OEIS prefix');
    });

    it.each([
      'keyword:core',
      'KEYWORD:core',
      '-author:Sloane',
      'id:A000045|seq:1,2,3',
      'signedsubseq:1,-1',
      'extension:x',
      'xref:A000045',
    ])('does not flag the known prefix in %j', async (query) => {
      expect(await noticeFor({ query })).toBe(LOOSEN);
    });

    it('skips a prefix-looking token inside a quoted phrase', async () => {
      expect(await noticeFor({ query: '"foo:bar baz" fibonacci' })).toBe(LOOSEN);
    });

    it('does not read a word with digits before the colon as a prefix', async () => {
      expect(await noticeFor({ query: 'a1:b' })).toBe(LOOSEN);
    });

    it.each(['1,2,3', '1 2 3', '-1, 2, -3', '42'])(
      'answers a numbers-only query %j with term-run advice, not a pointer to identify',
      async (query) => {
        expect(await noticeFor({ query })).toBe(NUMBERS);
      },
    );

    it('does not treat a numbers-and-words query as numbers only', async () => {
      expect(await noticeFor({ query: '1,2,3 prime' })).toBe(LOOSEN);
    });

    it('gives the same guidance at a later start, since OEIS answers "No results." there only for a query that matches nothing', async () => {
      expect(await noticeFor({ query: 'zzzz', start: 30 })).toBe(LOOSEN);
      expect(await noticeFor({ query: 'foo:1', start: 20 })).toBe(
        `"foo:" is not an OEIS prefix, so OEIS searched it as plain words. ${SYNTAX}`,
      );
      expect(await noticeFor({ query: '1,2,3', start: 10 })).toBe(NUMBERS);
    });

    it('reports a too-many page with the narrowing advice and no rows', async () => {
      const { result } = await search({ query: 'prime' }, page(tooManySearchPage));
      expect(result.isError).toBeUndefined();
      expect(rows(result)).toEqual([]);
      expect(structured(result)).toMatchObject({ truncated: false, shown: 0, cap: 10 });
      expect(structured(result)).not.toHaveProperty('totalCount');
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result).notice).toBe(
        'OEIS matched too many entries to list. Add a word, a quoted phrase, or a prefix such as keyword:nice or author:<name>.',
      );
    });

    it.each([30, 100])(
      'labels a start of %i past the total as the last page OEIS served, from start 20',
      async (start) => {
        const { result } = await search(
          { query: '1,2,5,14,42,132,429', start },
          page(clampedSearchPage),
        );
        expect(result.isError).toBeUndefined();
        expect(rows(result)).toHaveLength(6);
        expect(structured(result)).toMatchObject({
          start: 20,
          truncated: false,
          shown: 6,
          totalCount: 26,
          notice: `Start ${start} is past the last of 26 results; this is the last page, from start 20.`,
        });
        expect(structured(result)).not.toHaveProperty('nextStart');
        expect(textOf(result)).toContain('# OEIS search results (start 20, sort relevance)');
        expect(textOf(result)).toContain('## 21. A100000:');
        expect(textOf(result)).toContain('## 26. A100005:');
        expect(textOf(result)).not.toContain('## 31.');
      },
    );

    it('has no notice when the whole list fits on the page', async () => {
      const { result } = await search(
        { query: 'catalan' },
        page(syntheticSearchPage({ count: 4, total: 4 })),
      );
      expect(structured(result).notice).toBeUndefined();
    });

    describe('data-line limit on a query OEIS reads as one run', () => {
      const DATA_LINE =
        'OEIS matches only the first terms of each entry (its data line, at most about 270 characters), so a long run or one from far into a sequence is not found; give about 6 of the earliest terms you have.';
      const PAST_DATA_LINE = `${DATA_LINE} ${NUMBERS}`;
      const F60_64 = '1548008755920 2504730781961 4052739537881 6557470319842 10610209857723';
      /** `count` consecutive four-digit terms from 1000, joined by `separator`. */
      const fourDigit = (count: number, separator: string) =>
        Array.from({ length: count }, (_, i) => String(1000 + i)).join(separator);
      /** The echo OEIS gives bare numbers it reads as one run: `seq:` and the terms joined by commas. */
      const seqEcho = (query: string) => `seq:${query.split(/[\s,]+/).join(',')}`;

      /**
       * Runs a zero-hit search whose `Search:` line echoes `echo`, and asserts `expected` on
       * structuredContent and in the content[] trailer.
       */
      async function zeroHitNotice(
        input: { query: string; start?: number },
        expected: string,
        echo = seqEcho(input.query),
      ) {
        const noHits = searchPageText({ query: echo, status: 'No results.' });
        const { result } = await search(input, page(noHits));
        expect(result.isError).toBeUndefined();
        expect(structured(result).notice).toBe(expected);
        expect(textOf(result)).toContain(`> ${expected}`);
      }

      it('pins the whole notice for a numbers-only zero-hit of small terms', async () => {
        await zeroHitNotice({ query: '3 7 12 19 28' }, NUMBERS);
      });

      it('keeps the notice for F(40)..F(44), whose terms have nine digits', async () => {
        await zeroHitNotice(
          { query: '102334155 165580141 267914296 433494437 701408733' },
          NUMBERS,
        );
      });

      it('keeps the notice for a run of zeros', async () => {
        await zeroHitNotice({ query: '0 0 0 0 0' }, NUMBERS);
      });

      it('measures the length on the terms joined with commas, not on the query as written', async () => {
        const query = `${fourDigit(53, ', ')}, 10000`;
        expect(query.length).toBeGreaterThan(270);
        expect(query.split(', ').join(',')).toHaveLength(270);
        await zeroHitNotice({ query }, NUMBERS);
      });

      it('names the data line before the term-run advice for F(60)..F(64)', async () => {
        await zeroHitNotice({ query: F60_64 }, PAST_DATA_LINE);
      });

      it.each([
        ['commas', F60_64.replaceAll(' ', ',')],
        ['commas and spaces', F60_64.replaceAll(' ', ', ')],
        [
          'signs, counted by absolute value',
          '-6227020801, 87178291200, -1307674368000, 20922789888000',
        ],
        ['a leading 0, which the digit test skips', `0 ${F60_64}`],
        ['60 four-digit terms, longer than any data line', fourDigit(60, ' ')],
      ])('names the data line for a run written with %s', async (_case, query) => {
        await zeroHitNotice({ query }, PAST_DATA_LINE);
      });

      it.each([
        ['a seq: prefix', `seq:${F60_64.replaceAll(' ', ',')}`],
        ['a signed: prefix', `signed:${F60_64.replaceAll(' ', ',')}`],
        ['a seq: prefix on a single large term', 'seq:10610209857723'],
      ])(
        'names the data line for a run written with %s, which OEIS echoes as written',
        async (_case, query) => {
          await zeroHitNotice({ query }, PAST_DATA_LINE, query);
        },
      );

      it('leaves the sentence out when OEIS splits spaced numbers apart at a negative term', async () => {
        // OEIS echoes `1 -1 -1 0 -1 1 -1 0 0 1` as `1 seq:-1 seq:-1 0 seq:-1 1 seq:-1,0,0,1`.
        await zeroHitNotice(
          { query: '-6227020801 87178291200 -1307674368000 20922789888000' },
          NUMBERS,
          'seq:-6227020801 87178291200 seq:-1307674368000 20922789888000',
        );
      });

      it('names the data line from 271 characters joined with commas', async () => {
        const query = `${fourDigit(53, ' ')} 100000`;
        expect(query.replaceAll(' ', ',')).toHaveLength(271);
        await zeroHitNotice({ query }, PAST_DATA_LINE);
      });

      it('gives the same notice at a later start', async () => {
        await zeroHitNotice({ query: F60_64, start: 10 }, PAST_DATA_LINE);
      });

      it.each([
        ['a subseq: prefix', `subseq:${F60_64.replaceAll(' ', ',')}`, LOOSEN],
        ['a word', `fibonacci ${F60_64}`, LOOSEN],
        ['a _ wildcard', `_ ${F60_64}`, LOOSEN],
        [
          'an unknown prefix',
          `foo:${F60_64}`,
          `"foo:" is not an OEIS prefix, so OEIS searched it as plain words. ${SYNTAX}`,
        ],
      ])(
        'never adds the sentence to a large-term query with %s',
        async (_case, query, expected) => {
          await zeroHitNotice({ query }, expected, query);
        },
      );

      it('adds no zero-hit text to a large-term numbers-only query that hits', async () => {
        const { result } = await search(
          { query: F60_64 },
          page(syntheticSearchPage({ count: 2, total: 2 })),
        );
        expect(structured(result).notice).toBeUndefined();
        expect(textOf(result)).not.toContain('OEIS matches only the first terms');

        const tooMany = await search({ query: fourDigit(60, ' ') }, page(tooManySearchPage));
        expect(structured(tooMany.result).notice).toBe(
          'OEIS matched too many entries to list. Add a word, a quoted phrase, or a prefix such as keyword:nice or author:<name>.',
        );
      });
    });
  });

  describe('required enrichment', () => {
    it('carries truncated, shown, and cap on the zero-result page', async () => {
      const { result } = await search({ query: 'id:Axyz' }, page(noResultsSearchPage));
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({
        results: [],
        start: 0,
        sort: 'relevance',
        truncated: false,
        shown: 0,
        cap: 10,
        totalCount: 0,
        effectiveQuery: 'id:axyz',
      });
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result).notice).toEqual(expect.any(String));
      expect(textOf(result)).toContain('No sequences on this page.');
    });

    it('carries truncated, shown, and cap on an under-cap page', async () => {
      const { result } = await search({ query: '1,2,5,14,42,132,429' }, page(resultsSearchPage));
      expect(rows(result)).toHaveLength(2);
      expect(structured(result)).toMatchObject({
        truncated: true,
        shown: 2,
        cap: 10,
        totalCount: 26,
        effectiveQuery: 'seq:1,2,5,14,42,132,429',
      });
    });

    it('carries them on an under-cap page that is the whole list', async () => {
      const { result } = await search(
        { query: 'catalan' },
        page(syntheticSearchPage({ count: 3, total: 3, query: 'catalan' })),
      );
      expect(structured(result)).toMatchObject({
        truncated: false,
        shown: 3,
        cap: 10,
        totalCount: 3,
        effectiveQuery: 'catalan',
      });
    });

    it('carries them on a too-many page and on a full page', async () => {
      const tooMany = await search({ query: 'prime' }, page(tooManySearchPage));
      expect(structured(tooMany.result)).toMatchObject({ truncated: false, shown: 0, cap: 10 });
      const full = await search(
        { query: 'catalan' },
        page(syntheticSearchPage({ count: 10, total: 10 })),
      );
      expect(structured(full.result)).toMatchObject({ truncated: false, shown: 10, cap: 10 });
    });

    it('renders the enrichment block in content[]', async () => {
      const { result } = await search({ query: '1,2,5,14,42,132,429' }, page(resultsSearchPage));
      const text = textOf(result);
      expect(text).toContain('**truncated:** true');
      expect(text).toContain('**shown:** 2');
      expect(text).toContain('**cap:** 10');
      expect(text).toContain('**26 total**');
      expect(text).toContain('Query: seq:1,2,5,14,42,132,429');
    });
  });

  describe('upstream failures', () => {
    it('reports an unknown status line once, as non-retryable upstream_unparseable', async () => {
      const { calls, result } = await search(
        { query: 'a' },
        page(searchPageText({ query: 'a', status: 'Something new' })),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unparseable', retryable: false },
      });
      expect(calls).toHaveLength(1);
    });

    it('surfaces an edge 403 as upstream_refused, never Forbidden, without retrying', async () => {
      const { calls, result } = await search(
        { query: 'a' },
        res('<html>Attention Required</html>', { status: 403 }),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_refused', retryable: false },
      });
      expect(calls).toHaveLength(1);
    });

    it('surfaces a 429 with a long Retry-After as RateLimited carrying retryAfter', async () => {
      const { calls, result } = await search(
        { query: 'a' },
        res('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { retryAfter: '120' },
      });
      expect(calls).toHaveLength(1);
    });

    it('does not follow the 301 that a blank q would have drawn', async () => {
      const { calls, result } = await search(
        { query: 'a' },
        res(null, { status: 301, headers: { location: 'https://oeis.org/' } }),
      );
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(1);
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
        const result = await withBackoff(runToolContract(oeisSearchSequences, { query: 'a' }));
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

    it('settles a call aborted mid-request as RequestCancelled', async () => {
      const controller = new AbortController();
      const { service } = serviceOver(async () => {
        controller.abort();
        throw new Error('socket closed');
      });
      holder.service = service;
      const result = await runToolContract(
        oeisSearchSequences,
        { query: 'a' },
        { context: { signal: controller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    });

    it('sheds a queued call through the pacer_shed contract: RateLimited, retryable, with recovery', async () => {
      const pacer = createPacer({
        name: 'oeis-search-tool-test',
        minStartGapMs: 10_000,
        maxConcurrent: 1,
      });
      try {
        const { calls, fetch } = scriptedFetch(page(resultsSearchPage));
        holder.service = new OeisService({ fetch, pacer, queueMaxWaitMs: 1_000 });
        const first = await runToolContract(oeisSearchSequences, { query: 'catalan' });
        expect(first.isError).toBeUndefined();
        const shed = await runToolContract(oeisSearchSequences, { query: 'fibonacci' });
        expect(shed.isError).toBe(true);
        expect(errorOf(shed)).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'pacer_shed',
            retryAfter: expect.anything(),
            recovery: { hint: expect.stringContaining('oeis_search_sequences again') },
          },
        });
        expect(textOf(shed)).toContain('reason pacer_shed');
        expect(calls).toHaveLength(1);
      } finally {
        pacer.dispose();
      }
    });

    it('declares pacer_shed and upstream_rate_limited, as retryable RateLimited service errors', () => {
      expect(oeisSearchSequences.errors).toEqual([
        expect.objectContaining({
          reason: 'pacer_shed',
          code: JsonRpcErrorCode.RateLimited,
          retryable: true,
          thrownBy: 'service',
        }),
        expect.objectContaining({
          reason: 'upstream_rate_limited',
          code: JsonRpcErrorCode.RateLimited,
          retryable: true,
          thrownBy: 'service',
          recovery: expect.stringContaining('oeis_search_sequences again'),
        }),
      ]);
    });
  });

  describe('partial rows', () => {
    it('keeps a row with no keywords and no terms and renders them as none', async () => {
      const { result } = await search(
        { query: 'a' },
        page(
          searchPageText({
            query: 'a',
            status: 'Showing 1-1 of 1',
            records: [
              {
                aNumber: 'A388000',
                name: 'Sparse entry.',
                terms: [],
                offset: '1,1',
                keywords: '',
              },
            ],
          }),
        ),
      );
      expect(rows(result)[0]).toMatchObject({ aNumber: 'A388000', terms: [], keywords: [] });
      const text = textOf(result);
      expect(text).toContain('**Terms:** none listed');
      expect(text).toContain('**Keywords:** none');
    });

    it('lists a reserved row, which has no %O offset, beside ordinary rows instead of failing the page', async () => {
      const body = searchPageText({
        query: 'keyword:allocated',
        status: 'Showing 1-2 of 2',
        records: [moebiusSearchRecord, reservedSearchRecordText()],
      });
      const { result } = await search({ query: 'keyword:allocated', sort: 'created' }, page(body));
      expect(result.isError).toBeUndefined();
      expect(rows(result).map((row) => row.aNumber)).toEqual(['A008683', 'A397217']);
      expect(rows(result)[1]).toMatchObject({ terms: [], keywords: ['allocated'] });
      expect(rows(result)[1]).not.toHaveProperty('offset');
      expect(rows(result)[1]).not.toHaveProperty('firstIndex');
      const text = textOf(result);
      expect(text).toContain('**Offset:** 1,1 (first term is a(1))');
      expect(text).toContain('**Offset:** none (reserved or recycled A-number)');
    });
  });

  describe('format', () => {
    it('carries the rank, A-number, name, terms, offset, keywords, and URL of every row', async () => {
      const { result } = await search({ query: '1,2,5,14,42,132,429' }, page(resultsSearchPage));
      const text = textOf(result);
      expect(text).toContain('# OEIS search results (start 0, sort relevance)');
      rows(result).forEach((row, i) => {
        expect(text).toContain(`## ${i + 1}. ${row.aNumber}: ${row.name}`);
        expect(text).toContain(`**Terms:** ${row.terms.join(', ')}`);
        expect(text).toContain(`**Offset:** ${row.offset} (first term is a(${row.firstIndex}))`);
        expect(text).toContain(`**Keywords:** ${row.keywords.join(', ')}`);
        expect(text).toContain(`**Author:** ${row.author}`);
        expect(text).toContain(`**Legacy IDs:** ${row.legacyIds?.join(', ')}`);
        expect(text).toContain(`**Modified:** ${row.modified}`);
        expect(text).toContain(`**URL:** ${row.url}`);
      });
    });

    it('numbers ranks from start and names the sort and the next page', async () => {
      const { result } = await search(
        { query: 'a', sort: 'created', start: 20 },
        page(syntheticSearchPage({ count: 10, firstRow: 21, total: 60 })),
      );
      const text = textOf(result);
      expect(text).toContain('# OEIS search results (start 20, sort created)');
      expect(text).toContain('## 21. A100000: Synthetic 0.');
      expect(text).toContain('## 30. A100009: Synthetic 9.');
      expect(text).toContain('**Next page:** call again with start 30.');
    });

    it('prints the zero-result heading and the guidance from the enrichment block', async () => {
      const { result } = await search({ query: 'kewyord:core' }, page(noResultsSearchPage));
      const text = textOf(result);
      expect(text).toContain('# OEIS search results (start 0, sort relevance)');
      expect(text).toContain('No sequences on this page.');
      expect(text).toContain(String(structured(result).notice));
    });

    it('omits the next-page line when there is no nextStart', async () => {
      const { result } = await search(
        { query: 'a' },
        page(syntheticSearchPage({ count: 2, total: 2 })),
      );
      expect(textOf(result)).not.toContain('Next page');
    });

    it('flattens CR/LF in every inline slot of a hand-built output', () => {
      const blocks = oeisSearchSequences.format?.({
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
        sort: 'number',
      });
      const text = blocksText(blocks);
      expect(text).toContain('## 11. A000001: a b c');
      expect(text).toContain('**Terms:** 1, 2 3');
      expect(text).toContain('**Offset:** 0,1 # x (first term is a(0))');
      expect(text).toContain('**Keywords:** nonn ## y, easy');
      expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
        '# OEIS search results (start 10, sort number)',
        '## 11. A000001: a b c',
      ]);
    });

    it('renders nextStart only when present', () => {
      const base = { results: [], start: 20, sort: 'relevance' as const };
      expect(blocksText(oeisSearchSequences.format?.(base))).not.toContain('Next page');
      expect(blocksText(oeisSearchSequences.format?.({ ...base, nextStart: 30 }))).toContain(
        '**Next page:** call again with start 30.',
      );
    });

    it('renders rows without author, modified, or legacyIds as the summary lines alone', () => {
      const text = blocksText(
        oeisSearchSequences.format?.({
          results: [
            {
              aNumber: 'A000045',
              name: 'Fibonacci numbers.',
              terms: ['0', '1', '1'],
              offset: '0,4',
              firstIndex: 0,
              keywords: ['nonn', 'core'],
              url: 'https://oeis.org/A000045',
            },
            {
              aNumber: 'A397217',
              name: 'allocated for Jane Doe',
              terms: [],
              keywords: ['allocated'],
              url: 'https://oeis.org/A397217',
            },
          ],
          start: 0,
          nextStart: 10,
          sort: 'modified',
        }),
      );
      expect(text).toBe(
        [
          '# OEIS search results (start 0, sort modified)',
          '',
          '## 1. A000045: Fibonacci numbers.',
          '**Terms:** 0, 1, 1',
          '**Offset:** 0,4 (first term is a(0))',
          '**Keywords:** nonn, core',
          '**URL:** https://oeis.org/A000045',
          '',
          '## 2. A397217: allocated for Jane Doe',
          '**Terms:** none listed',
          '**Offset:** none (reserved or recycled A-number)',
          '**Keywords:** allocated',
          '**URL:** https://oeis.org/A397217',
          '',
          '**Next page:** call again with start 10.',
        ].join('\n'),
      );
    });
  });
});
