/**
 * @fileoverview Tests for oeis_get_cross_refs through the tool contract over a real OeisService
 * with a scripted fetch: A-number, direction, and start input with blank form-client values; the
 * outgoing flow (A-number extraction, notes, dedupe, batch name lookup, paging to the 110-row
 * window), the incoming flow, the degrade-to-unresolved-rows path and its cancellation rethrow, the
 * sequence_not_found and pacer_shed contracts, every notice, required enrichment on the zero-result
 * and under-cap pages, unsafe hrefs, upstream failure classes, and `format()` parity with
 * `structuredContent`.
 * @module tests/tools/oeis-get-cross-refs.tool.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oeisGetCrossRefs } from '@/mcp-server/tools/definitions/oeis-get-cross-refs.tool.js';
import { OeisService } from '@/services/oeis/oeis-service.js';
import {
  fibonacciRecordJson,
  fibonacciSearchRecord,
  htmlMaintenanceBody,
  noResultsSearchPage,
  type RawRecord,
  recordBody,
  recordWith,
  reservedSearchRecordText,
  type SearchFixtureRecord,
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
type Related = {
  aNumber: string;
  firstIndex?: number;
  keywords?: string[];
  lineIndex?: number;
  name?: string;
  note?: string;
  offset?: string;
  resolved: boolean;
  terms?: string[];
  url: string;
};

const record = (raw: RawRecord = fibonacciRecordJson) =>
  res(recordBody(raw), { status: 200, headers: { 'content-type': 'application/json' } });
const missing = () => res('<html>Not found</html>', { status: 404 });
const page = (body: string) => res(body, { status: 200 });

const aNum = (n: number) => `A${String(n).padStart(6, '0')}`;

/** A summary record for `aNumber`, named after it. */
const summary = (aNumber: string, overrides: Partial<SearchFixtureRecord> = {}) => ({
  ...fibonacciSearchRecord,
  aNumber,
  name: `Name of ${aNumber}.`,
  ...overrides,
});

/** A `Showing 1-n of n` batch page holding `aNumbers`, in the order given. */
function batchPage(...aNumbers: string[]): string {
  return searchPageText({
    query: aNumbers.map((a) => `id:${a.toLowerCase()}`).join('|'),
    status: `Showing 1-${aNumbers.length} of ${aNumbers.length}`,
    records: aNumbers.map((a) => summary(a)),
  });
}

/** The Fibonacci record with its cross-reference lines replaced. */
const withXref = (xref: string[]) => recordWith({ xref });

/** A record whose cross-reference lines name `count` distinct A-numbers from A100001. */
const withManyRefs = (count: number) =>
  withXref(
    Array.from(
      { length: Math.ceil(count / 5) },
      (_, line) =>
        `Cf. ${Array.from({ length: 5 }, (_, i) => line * 5 + i + 1)
          .filter((n) => n <= count)
          .map((n) => aNum(100_000 + n))
          .join(', ')}.`,
    ),
  );

const batchOf = (from: number, count: number) =>
  batchPage(...Array.from({ length: count }, (_, i) => aNum(100_000 + from + i)));

async function crossRefs(
  input: Record<string, unknown>,
  ...steps: ReturnType<typeof res>[]
): Promise<{ calls: ReturnType<typeof serviceOver>['calls']; result: Result }> {
  const { calls, service } = serviceOver(...steps);
  holder.service = service;
  return { calls, result: await runToolContract(oeisGetCrossRefs, input as never) };
}

const structured = (result: Result) => result.structuredContent as Record<string, unknown>;
const related = (result: Result) => structured(result).related as Related[];
const textOf = (result: Result) =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
const errorOf = (result: Result) =>
  structured(result).error as { code: number; data: Record<string, unknown>; message: string };

afterEach(() => {
  holder.service = undefined;
});

describe('oeis_get_cross_refs', () => {
  describe('input', () => {
    it('normalizes every accepted A-number form to the zero-padded one', () => {
      for (const given of ['A000045', 'a000045', 'A45', '45', 'https://oeis.org/A000045']) {
        expect(oeisGetCrossRefs.input.parse({ aNumber: given }).aNumber).toBe('A000045');
      }
    });

    it.each(['M1459', '', 'A12345678', 'abc', 'A45x'])('rejects the A-number %j', (aNumber) => {
      expect(oeisGetCrossRefs.input.safeParse({ aNumber }).success).toBe(false);
    });

    it('defaults direction to outgoing and start to 0', () => {
      expect(oeisGetCrossRefs.input.parse({ aNumber: 'A45' })).toEqual({
        aNumber: 'A000045',
        direction: 'outgoing',
        start: 0,
      });
    });

    it('reads blank direction and start (form clients send "") as the defaults', () => {
      for (const blank of ['', '   ']) {
        expect(
          oeisGetCrossRefs.input.parse({ aNumber: 'A45', direction: blank, start: blank }),
        ).toEqual({ aNumber: 'A000045', direction: 'outgoing', start: 0 });
      }
    });

    it.each(['sideways', 'Outgoing', 'both', 5, null])('rejects direction %j', (direction) => {
      expect(oeisGetCrossRefs.input.safeParse({ aNumber: 'A45', direction }).success).toBe(false);
    });

    it.each([0, 10, 100])('accepts start %i', (start) => {
      expect(oeisGetCrossRefs.input.parse({ aNumber: 'A45', start }).start).toBe(start);
    });

    it.each([
      ['not a multiple of ten', 5],
      ['past the window', 110],
      ['negative', -10],
      ['a numeric string', '20'],
      ['null', null],
    ])('rejects start that is %s', (_label, start) => {
      expect(oeisGetCrossRefs.input.safeParse({ aNumber: 'A45', start }).success).toBe(false);
    });

    it('answers a rejected input with invalid_arguments and no request', async () => {
      const { calls, result } = await crossRefs({ aNumber: 'M1459' }, record());
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(calls).toHaveLength(0);
    });

    it('runs a form-client payload as outgoing, first page', async () => {
      const { calls, result } = await crossRefs(
        { aNumber: '45', direction: '', start: '' },
        record(),
        page(batchPage('A000032', 'A001045', 'A011973')),
      );
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({ direction: 'outgoing', start: 0 });
      expect(calls).toHaveLength(2);
    });
  });

  describe('outgoing', () => {
    it('fetches the record, then names the cross-referenced A-numbers in one batch search', async () => {
      const { calls, result } = await crossRefs(
        { aNumber: 'A45' },
        record(),
        page(batchPage('A000032', 'A001045', 'A011973')),
      );
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(2);
      expect(new URL(calls[0]?.url ?? '').pathname).toBe('/A000045');
      expect(queryOf(calls[0]).get('fmt')).toBe('json');
      expect(new URL(calls[1]?.url ?? '').pathname).toBe('/search');
      expect(queryOf(calls[1]).get('q')).toBe('id:A000032|id:A001045|id:A011973');
      expect(queryOf(calls[1]).get('fmt')).toBe('text');
      expect(queryOf(calls[1]).has('start')).toBe(false);
      expect(queryOf(calls[1]).has('sort')).toBe(false);

      expect(structured(result)).toMatchObject({
        aNumber: 'A000045',
        direction: 'outgoing',
        start: 0,
        lines: ['Cf. A000032, A001045.', 'Row sums of A011973.'],
      });
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(related(result)).toEqual([
        expect.objectContaining({
          aNumber: 'A000032',
          resolved: true,
          name: 'Name of A000032.',
          lineIndex: 0,
          url: 'https://oeis.org/A000032',
          firstIndex: 0,
          offset: '0,4',
          keywords: expect.arrayContaining(['nonn']),
          terms: expect.arrayContaining(['0', '1']),
        }),
        expect.objectContaining({ aNumber: 'A001045', resolved: true, lineIndex: 0 }),
        expect.objectContaining({ aNumber: 'A011973', resolved: true, lineIndex: 1 }),
      ]);
    });

    it('lists rows in the order the lines name them, not the order the batch returns', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(),
        page(batchPage('A011973', 'A001045', 'A000032')),
      );
      expect(related(result).map((row) => row.aNumber)).toEqual(['A000032', 'A001045', 'A011973']);
      expect(related(result).map((row) => row.name)).toEqual([
        'Name of A000032.',
        'Name of A001045.',
        'Name of A011973.',
      ]);
    });

    it('resolves a page whose batch holds a reserved A-number with no %O line', async () => {
      const body = searchPageText({
        query: 'id:a000032|id:a397217',
        status: 'Showing 1-2 of 2',
        records: [summary('A000032'), reservedSearchRecordText('A397217')],
      });
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(withXref(['Cf. A000032, A397217.'])),
        page(body),
      );
      expect(result.isError).toBeUndefined();
      expect(related(result)).toEqual([
        expect.objectContaining({ aNumber: 'A000032', resolved: true, offset: '0,4' }),
        expect.objectContaining({ aNumber: 'A397217', resolved: true, keywords: ['allocated'] }),
      ]);
      expect(related(result)[1]).not.toHaveProperty('offset');
      expect(structured(result).notice).toBeUndefined();
    });

    it('ignores batch records it did not ask for', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(),
        page(batchPage('A000032', 'A999999', 'A001045', 'A011973')),
      );
      expect(related(result).map((row) => row.aNumber)).toEqual(['A000032', 'A001045', 'A011973']);
    });

    it('marks an A-number the batch has no record for as unresolved, without inventing fields', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(withXref(['Cf. A000032 (Lucas), A001045.'])),
        page(batchPage('A000032')),
      );
      const [resolved, unresolved] = related(result);
      expect(resolved).toMatchObject({ aNumber: 'A000032', resolved: true, note: 'Lucas' });
      expect(unresolved).toEqual({
        aNumber: 'A001045',
        resolved: false,
        url: 'https://oeis.org/A001045',
        lineIndex: 0,
      });
      expect(structured(result).notice).toBeUndefined();
      expect(textOf(result)).toContain('**Resolved:** no (name and terms not fetched)');
    });

    it('keeps a resolved row with no terms and no keywords', async () => {
      const sparse = searchPageText({
        query: 'id:a000032',
        status: 'Showing 1-1 of 1',
        records: [summary('A000032', { terms: [], keywords: '' })],
      });
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(withXref(['Cf. A000032.'])),
        page(sparse),
      );
      expect(related(result)[0]).toMatchObject({ resolved: true, terms: [], keywords: [] });
      const text = textOf(result);
      expect(text).toContain('**Terms:** none listed');
      expect(text).toContain('**Keywords:** none');
    });

    describe('A-number extraction', () => {
      const refsOf = async (xref: string[]) => {
        const aNumbers = [...new Set(xref.join(' ').match(/\bA\d{6,7}(?!\d)/g) ?? [])].filter(
          (a) => a !== 'A000045',
        );
        const { result } = await crossRefs(
          { aNumber: 'A45' },
          record(withXref(xref)),
          page(batchPage(...aNumbers)),
        );
        return related(result);
      };

      it('dedupes in order of first appearance and drops the entry itself', async () => {
        const rows = await refsOf([
          'Cf. A000032, A001045, A000045.',
          'Also A001045 and A000032, then A011973.',
        ]);
        expect(rows.map((row) => row.aNumber)).toEqual(['A000032', 'A001045', 'A011973']);
        expect(rows.map((row) => row.lineIndex)).toEqual([0, 0, 1]);
      });

      it('matches six- and seven-digit A-numbers only', async () => {
        const { calls } = await crossRefs(
          { aNumber: 'A45' },
          record(withXref(['A12345 A123456 A1234567 A12345678 xA000032'])),
          page(batchPage('A123456', 'A1234567')),
        );
        expect(queryOf(calls[1]).get('q')).toBe('id:A123456|id:A1234567');
      });

      it('reads an A-number glued to a function suffix, as OEIS writes A048720bi(x,y) and A326722_row(n)', async () => {
        const rows = await refsOf(['a(n) = A048720bi(21,n) + A326722_row(2*n).']);
        expect(rows.map((row) => row.aNumber)).toEqual(['A048720', 'A326722']);
      });

      it('takes the parenthetical beside an A-number as its note, balancing nested parentheses', async () => {
        const rows = await refsOf([
          'Cf. A001622 (phi), A000032 (Lucas (with a nested) note), A001045 (unclosed.',
        ]);
        expect(rows.map((row) => [row.aNumber, row.note])).toEqual([
          ['A001622', 'phi'],
          ['A000032', 'Lucas (with a nested) note'],
          ['A001045', undefined],
        ]);
      });

      it('skips spaces before the parenthesis but not a comma', async () => {
        const rows = await refsOf(['Cf. A001622   (spaced), A000032, (not a note).']);
        expect(rows.map((row) => row.note)).toEqual(['spaced', undefined]);
      });

      it('ignores an empty parenthetical', async () => {
        const rows = await refsOf(['Cf. A001622 (), A000032 (   ).']);
        expect(rows.map((row) => row.note)).toEqual([undefined, undefined]);
      });

      it('keeps the first note found and the first line that names the A-number', async () => {
        const rows = await refsOf([
          'Cf. A001622.',
          'The golden ratio, A001622 (phi). Also A001622 (other).',
          'A000032 (first), A000032 (second).',
        ]);
        expect(rows).toEqual([
          expect.objectContaining({ aNumber: 'A001622', note: 'phi', lineIndex: 0 }),
          expect.objectContaining({ aNumber: 'A000032', note: 'first', lineIndex: 2 }),
        ]);
      });

      it('finds A-numbers inside the anchors OEIS writes into cross-reference lines', async () => {
        const rows = await refsOf([
          'Cf. <a href="/A000032" title="Lucas numbers">A000032</a> (Lucas), <a href="/A001045">A001045</a>.',
        ]);
        expect(rows.map((row) => row.aNumber)).toEqual(['A000032', 'A001045']);
        expect(rows.map((row) => row.url)).toEqual([
          'https://oeis.org/A000032',
          'https://oeis.org/A001045',
        ]);
      });

      it('records the first line index even when a later line carries the note', async () => {
        const rows = await refsOf(['Cf. A000032.', 'See A000032 (Lucas numbers).']);
        expect(rows[0]).toMatchObject({ lineIndex: 0, note: 'Lucas numbers' });
      });

      it('balances a later parenthetical inside an earlier unclosed one', async () => {
        const rows = await refsOf(['Cf. A000032 (open A001045 (closed) and A001622 (x)']);
        expect(rows.map((row) => [row.aNumber, row.note])).toEqual([
          ['A000032', undefined],
          ['A001045', 'closed'],
          ['A001622', 'x'],
        ]);
      });

      it('reads 1 MiB of mentions before unclosed parentheses in linear time', async () => {
        const line = `Cf. ${'A000032 ('.repeat(Math.floor((1024 * 1024) / 9))}`;
        const started = performance.now();
        const rows = await refsOf([line]);
        expect(performance.now() - started).toBeLessThan(250);
        expect(rows.map((row) => [row.aNumber, row.note])).toEqual([['A000032', undefined]]);
      });
    });

    describe('unsafe hrefs', () => {
      const unsafeLinks = [
        '<a href="javascript:alert(1)">Evil</a>',
        '<a href="data:text/html,<script>alert(1)</script>">Data</a>',
        '<a href="JaVaScRiPt:alert(2)">Mixed</a>',
      ];

      it('never lets a javascript: or data: href in the record reach the output', async () => {
        const raw = recordWith({ link: unsafeLinks, xref: ['Cf. A000032, A001045.'] });
        const { result } = await crossRefs(
          { aNumber: 'A45' },
          record(raw),
          page(batchPage('A000032', 'A001045')),
        );
        const everything = JSON.stringify(structured(result)) + textOf(result);
        expect(everything).not.toMatch(/javascript:/i);
        expect(everything).not.toMatch(/data:text/i);
      });

      it('gives every row the canonical oeis.org URL, whatever hrefs the cross-reference line carries', async () => {
        const raw = withXref([
          'Cf. <a href="javascript:alert(1)">A000032</a>, <a href="data:text/html,x">A001045</a>.',
        ]);
        const { result } = await crossRefs(
          { aNumber: 'A45' },
          record(raw),
          page(batchPage('A000032', 'A001045')),
        );
        expect(related(result).map((row) => row.url)).toEqual([
          'https://oeis.org/A000032',
          'https://oeis.org/A001045',
        ]);
        for (const row of related(result)) {
          expect(JSON.stringify(row)).not.toMatch(/javascript:|data:/i);
        }
      });

      it('keeps a javascript: href in a cross-reference line out of lines and content[]', async () => {
        const raw = withXref([
          'Cf. <a href="javascript:alert(1)">A000032</a>, <a href=\'data:text/html,x\'>A001045</a>.',
        ]);
        const { result } = await crossRefs(
          { aNumber: 'A45' },
          record(raw),
          page(batchPage('A000032', 'A001045')),
        );
        expect(structured(result).lines).toEqual(['Cf. <a>A000032</a>, <a>A001045</a>.']);
        expect(related(result).map((row) => row.aNumber)).toEqual(['A000032', 'A001045']);
        expect(textOf(result)).not.toMatch(/javascript:|data:/i);
      });

      it('escapes link, image, and HTML syntax in notes and lines, and keeps both verbatim in structuredContent', async () => {
        const line =
          'Cf. A000032 (see [here](https://attacker.example/n)), A001045 (<img src=x onerror=alert(7)>).';
        const { result } = await crossRefs(
          { aNumber: 'A45' },
          record(withXref([line])),
          page(batchPage('A000032', 'A001045')),
        );
        expect(related(result).map((row) => row.note)).toEqual([
          'see [here](https://attacker.example/n)',
          '<img src=x onerror=alert(7)>',
        ]);
        expect(structured(result).lines).toEqual([line]);
        const text = textOf(result);
        expect(text).toContain('**Note:** see [here\\](https://attacker.example/n)');
        expect(text).toContain('**Note:** \\<img src=x onerror=alert(7)>');
        expect(text).toContain(
          '> Cf. A000032 (see [here\\](https://attacker.example/n)), A001045 (\\<img src=x onerror=alert(7)>).',
        );
      });
    });

    describe('empty and past-the-end pages', () => {
      it('reports an entry that names no other A-number, without a batch request', async () => {
        const { calls, result } = await crossRefs(
          { aNumber: 'A45' },
          record(withXref(['Cf. A000045 (itself).', 'Nothing else here.'])),
        );
        expect(calls).toHaveLength(1);
        expect(related(result)).toEqual([]);
        expect(structured(result)).toMatchObject({
          lines: ['Cf. A000045 (itself).', 'Nothing else here.'],
          truncated: false,
          shown: 0,
          totalCount: 0,
        });
        expect(structured(result).notice).toBe(
          'This entry names no other A-numbers in its cross-reference lines; try direction incoming.',
        );
        expect(textOf(result)).toContain('No related sequences on this page.');
      });

      it('reports an entry with no cross-reference lines at all', async () => {
        const { calls, result } = await crossRefs(
          { aNumber: 'A388000' },
          record(recordWith({ number: 388000, xref: undefined })),
        );
        expect(calls).toHaveLength(1);
        expect(structured(result)).toMatchObject({ related: [], lines: [] });
        expect(structured(result).notice).toContain('names no other A-numbers');
        expect(textOf(result)).toContain('## Cross-reference lines');
        expect(textOf(result)).toContain('None.');
      });

      it('answers a start past the last A-number with the last page start and no batch request', async () => {
        const { calls, result } = await crossRefs(
          { aNumber: 'A45', start: 30 },
          record(withManyRefs(25)),
        );
        expect(calls).toHaveLength(1);
        expect(related(result)).toEqual([]);
        expect(structured(result)).toMatchObject({
          start: 30,
          truncated: false,
          shown: 0,
          totalCount: 25,
        });
        expect(structured(result)).not.toHaveProperty('nextStart');
        expect(structured(result).notice).toBe(
          'This entry names 25 other A-numbers; start 30 is past the last of them. Call again with start 20.',
        );
      });

      it('names start 0 as the last page when exactly one page of A-numbers exists', async () => {
        const { result } = await crossRefs({ aNumber: 'A45', start: 10 }, record(withManyRefs(10)));
        expect(structured(result).notice).toBe(
          'This entry names 10 other A-numbers; start 10 is past the last of them. Call again with start 0.',
        );
      });

      it('caps the suggested start at 100 for an entry with more than 110 A-numbers', async () => {
        const { result } = await crossRefs(
          { aNumber: 'A45', start: 100 },
          record(withManyRefs(100)),
        );
        expect(structured(result).notice).toContain('Call again with start 90.');
      });
    });

    describe('paging', () => {
      it('slices ten A-numbers per page, resolves only that slice, and offers nextStart', async () => {
        const { calls, result } = await crossRefs(
          { aNumber: 'A45' },
          record(withManyRefs(25)),
          page(batchOf(1, 10)),
        );
        expect(queryOf(calls[1]).get('q')).toBe(
          Array.from({ length: 10 }, (_, i) => `id:${aNum(100_001 + i)}`).join('|'),
        );
        expect(related(result)).toHaveLength(10);
        expect(structured(result)).toMatchObject({
          start: 0,
          nextStart: 10,
          truncated: true,
          shown: 10,
          cap: 10,
          totalCount: 25,
        });
        expect(structured(result).notice).toBe(
          'Showing 1-10 of 25; call again with start 10 for the next page.',
        );
        expect(structured(result).lines).toHaveLength(5);
      });

      it('walks the middle and last pages by start', async () => {
        const middle = await crossRefs(
          { aNumber: 'A45', start: 10 },
          record(withManyRefs(25)),
          page(batchOf(11, 10)),
        );
        expect(queryOf(middle.calls[1]).get('q')?.split('|')[0]).toBe(`id:${aNum(100_011)}`);
        expect(related(middle.result)[0]?.aNumber).toBe(aNum(100_011));
        expect(structured(middle.result)).toMatchObject({ start: 10, nextStart: 20 });
        expect(structured(middle.result).notice).toBe(
          'Showing 11-20 of 25; call again with start 20 for the next page.',
        );

        const last = await crossRefs(
          { aNumber: 'A45', start: 20 },
          record(withManyRefs(25)),
          page(batchOf(21, 5)),
        );
        expect(related(last.result)).toHaveLength(5);
        expect(structured(last.result)).toMatchObject({
          truncated: false,
          shown: 5,
          totalCount: 25,
        });
        expect(structured(last.result)).not.toHaveProperty('nextStart');
        expect(structured(last.result).notice).toBeUndefined();
      });

      it('serves the record from the cache across pages', async () => {
        const { service, calls } = serviceOver(
          record(withManyRefs(25)),
          page(batchOf(1, 10)),
          page(batchOf(11, 10)),
        );
        holder.service = service;
        await runToolContract(oeisGetCrossRefs, { aNumber: 'A45' });
        await runToolContract(oeisGetCrossRefs, { aNumber: 'A45', start: 10 });
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          '/A000045',
          '/search',
          '/search',
        ]);
      });

      it('stops at start 100 and says lines names the rest', async () => {
        const { result } = await crossRefs(
          { aNumber: 'A45', start: 100 },
          record(withManyRefs(120)),
          page(batchOf(101, 10)),
        );
        expect(related(result)).toHaveLength(10);
        expect(structured(result)).toMatchObject({
          start: 100,
          truncated: true,
          shown: 10,
          totalCount: 120,
        });
        expect(structured(result)).not.toHaveProperty('nextStart');
        expect(structured(result).notice).toBe(
          'Only the first 110 of 120 related A-numbers can be paged here; lines names the rest.',
        );
      });

      it('has no window notice when start 100 reaches the last A-number', async () => {
        const { result } = await crossRefs(
          { aNumber: 'A45', start: 100 },
          record(withManyRefs(105)),
          page(batchOf(101, 5)),
        );
        expect(structured(result)).toMatchObject({ truncated: false, shown: 5 });
        expect(structured(result).notice).toBeUndefined();
      });
    });

    describe('name lookup failures', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      const NOTE_LINES = ['Cf. A000032 (Lucas), A001045.', 'Row sums of A011973.'];

      const degraded = async (batch: Parameters<typeof serviceOver>, start = 0) => {
        const { calls, service } = serviceOver(record(withXref(NOTE_LINES)), ...batch);
        holder.service = service;
        const result = await withBackoff(
          runToolContract(oeisGetCrossRefs, { aNumber: 'A45', start }),
        );
        return { calls, result };
      };

      const expectUnresolvedPage = (result: Result) => {
        expect(result.isError).toBeUndefined();
        expect(related(result)).toEqual([
          {
            aNumber: 'A000032',
            resolved: false,
            url: 'https://oeis.org/A000032',
            note: 'Lucas',
            lineIndex: 0,
          },
          { aNumber: 'A001045', resolved: false, url: 'https://oeis.org/A001045', lineIndex: 0 },
          { aNumber: 'A011973', resolved: false, url: 'https://oeis.org/A011973', lineIndex: 1 },
        ]);
        expect(structured(result)).toMatchObject({
          lines: NOTE_LINES,
          truncated: false,
          shown: 3,
          cap: 10,
          totalCount: 3,
        });
      };

      it('degrades a batch that keeps failing with 5xx to unresolved rows plus a notice', async () => {
        const { calls, result } = await degraded([res('oops', { status: 502 })]);
        expectUnresolvedPage(result);
        expect(calls).toHaveLength(4);
        expect(structured(result).notice).toBe(
          'Names and terms for these A-numbers could not be fetched (upstream_unavailable); call oeis_get_cross_refs again with the same start after about 10 seconds, or pass an A-number to oeis_get_sequence.',
        );
      });

      it('names a reason code, never the failure message, when the failure carries no reason', async () => {
        const { service } = serviceOver(record(withXref(NOTE_LINES)));
        holder.service = service;
        vi.spyOn(service, 'search').mockRejectedValueOnce(
          serviceUnavailable('<h1>Backend db01 down</h1>'),
        );
        const result = await runToolContract(oeisGetCrossRefs, { aNumber: 'A45' });
        expectUnresolvedPage(result);
        expect(structured(result).notice).toContain('could not be fetched (upstream_unavailable)');
        expect(JSON.stringify(result)).not.toContain('db01');
      });

      it('names the upstream reason when the failure carries one', async () => {
        const { result } = await degraded([res(htmlMaintenanceBody, { status: 200 })]);
        expectUnresolvedPage(result);
        expect(structured(result).notice).toContain('could not be fetched (upstream_unparseable)');
      });

      it('degrades an edge refusal with its reason', async () => {
        const { calls, result } = await degraded([res('<html>blocked</html>', { status: 403 })]);
        expectUnresolvedPage(result);
        expect(structured(result).notice).toContain('could not be fetched (upstream_refused)');
        expect(calls).toHaveLength(2);
      });

      it('degrades a network failure to unresolved rows', async () => {
        const { result } = await degraded([new TypeError('fetch failed')]);
        expectUnresolvedPage(result);
        expect(structured(result).notice).toContain('could not be fetched (upstream_unavailable)');
      });

      it('degrades a timeout to unresolved rows', async () => {
        const { service } = serviceOver(
          record(withXref(NOTE_LINES)),
          new DOMException('timed out', 'TimeoutError'),
        );
        holder.service = service;
        await service.getRecord('A000045', createMockContext());
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
          AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
        );
        const result = await withBackoff(runToolContract(oeisGetCrossRefs, { aNumber: 'A45' }));
        expectUnresolvedPage(result);
        expect(structured(result).notice).toContain('could not be fetched (upstream_timeout)');
      });

      it('carries a 429 Retry-After into the notice, in whole seconds', async () => {
        const { calls, result } = await degraded([
          res('slow', { status: 429, headers: { 'retry-after': '45' } }),
        ]);
        expectUnresolvedPage(result);
        expect(structured(result).notice).toContain(
          'again with the same start after about 45 seconds',
        );
        expect(calls).toHaveLength(2);
      });

      it('falls back to ten seconds when a 429 names no usable Retry-After', async () => {
        const { result } = await degraded([
          res('slow', { status: 429, headers: { 'retry-after': '0' } }),
        ]);
        expectUnresolvedPage(result);
        expect(structured(result).notice).toContain('after about 10 seconds');
      });

      it('puts the failure notice before the paging notice on a degraded first page', async () => {
        const { service } = serviceOver(record(withManyRefs(25)), new TypeError('fetch failed'));
        holder.service = service;
        const result = await withBackoff(runToolContract(oeisGetCrossRefs, { aNumber: 'A45' }));
        expect(related(result)).toHaveLength(10);
        expect(related(result).every((row) => !row.resolved)).toBe(true);
        expect(structured(result)).toMatchObject({ truncated: true, nextStart: 10, shown: 10 });
        const notice = String(structured(result).notice);
        expect(notice.indexOf('could not be fetched')).toBeGreaterThanOrEqual(0);
        expect(notice.indexOf('could not be fetched')).toBeLessThan(
          notice.indexOf('Showing 1-10 of 25'),
        );
      });

      it('rethrows a failure that is not a rate limit, outage, or timeout', async () => {
        const { calls, result } = await degraded([res(signInRefusalBody, { status: 403 })]);
        expect(result.isError).toBe(true);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'result_window_exceeded' },
        });
        expect(calls).toHaveLength(2);
      });

      it('rethrows an error that is not an McpError', async () => {
        const { service } = serviceOver(record(withXref(NOTE_LINES)));
        holder.service = service;
        vi.spyOn(service, 'search').mockRejectedValueOnce(new Error('boom'));
        const result = await runToolContract(oeisGetCrossRefs, { aNumber: 'A45' });
        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.InternalError);
      });

      it('rethrows a classified failure from an unlisted code', async () => {
        const { service } = serviceOver(record(withXref(NOTE_LINES)));
        holder.service = service;
        vi.spyOn(service, 'search').mockRejectedValueOnce(
          Object.assign(serviceUnavailable('x'), { code: JsonRpcErrorCode.Forbidden }),
        );
        const result = await runToolContract(oeisGetCrossRefs, { aNumber: 'A45' });
        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.Forbidden);
      });

      it('rethrows a cancellation instead of degrading to unresolved rows', async () => {
        const controller = new AbortController();
        const { service } = serviceOver(record(withXref(NOTE_LINES)), async () => {
          controller.abort();
          throw new TypeError('fetch failed');
        });
        holder.service = service;
        const result = await runToolContract(
          oeisGetCrossRefs,
          { aNumber: 'A45' },
          { context: { signal: controller.signal } },
        );
        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      });

      it('rethrows a cancellation that surfaces as a classified 5xx', async () => {
        const controller = new AbortController();
        const { service } = serviceOver(record(withXref(NOTE_LINES)), async () => {
          controller.abort();
          return new Response('oops', { status: 503 });
        });
        holder.service = service;
        const result = await runToolContract(
          oeisGetCrossRefs,
          { aNumber: 'A45' },
          { context: { signal: controller.signal } },
        );
        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      });
    });

    describe('record failures', () => {
      it('answers sequence_not_found when the record is 404', async () => {
        const { calls, result } = await crossRefs({ aNumber: 'A999999' }, missing());
        expect(result.isError).toBe(true);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'sequence_not_found',
            aNumber: 'A999999',
            recovery: { hint: expect.stringContaining('oeis_search_sequences') },
          },
        });
        expect(textOf(result)).toContain('reason sequence_not_found');
        expect(calls).toHaveLength(1);
      });

      it('fails the call on a record 429 with retryAfter, without a batch request', async () => {
        const { calls, result } = await crossRefs(
          { aNumber: 'A45' },
          res('slow', { status: 429, headers: { 'retry-after': '120' } }),
        );
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { retryAfter: '120' },
        });
        expect(calls).toHaveLength(1);
      });

      it('fails the call on a record edge 403', async () => {
        const { result } = await crossRefs(
          { aNumber: 'A45' },
          res('<html>blocked</html>', { status: 403 }),
        );
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_refused', retryable: false },
        });
      });

      it('fails the call on a record that is missing required fields, once', async () => {
        const { calls, result } = await crossRefs(
          { aNumber: 'A45' },
          res(JSON.stringify({ number: 45 }), { status: 200 }),
        );
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unparseable', retryable: false },
        });
        expect(calls).toHaveLength(1);
      });

      describe('retried classes', () => {
        beforeEach(() => {
          vi.useFakeTimers();
        });
        afterEach(() => {
          vi.useRealTimers();
        });

        it('retries a record 5xx and then fails with the attempt count', async () => {
          const { service, calls } = serviceOver(res('oops', { status: 502 }));
          holder.service = service;
          const result = await withBackoff(runToolContract(oeisGetCrossRefs, { aNumber: 'A45' }));
          expect(errorOf(result)).toMatchObject({
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { retryAttempts: 3 },
          });
          expect(calls).toHaveLength(3);
        });

        it('reports an HTML maintenance page in place of the record as upstream_unparseable', async () => {
          const { service } = serviceOver(res(htmlMaintenanceBody, { status: 200 }));
          holder.service = service;
          const result = await withBackoff(runToolContract(oeisGetCrossRefs, { aNumber: 'A45' }));
          expect(errorOf(result)).toMatchObject({
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { reason: 'upstream_unparseable', retryAttempts: 3 },
          });
        });

        it('reports a malformed JSON record as upstream_unparseable', async () => {
          const { service } = serviceOver(res('{"number": 45,', { status: 200 }));
          holder.service = service;
          const result = await withBackoff(runToolContract(oeisGetCrossRefs, { aNumber: 'A45' }));
          expect(errorOf(result).data).toMatchObject({ reason: 'upstream_unparseable' });
        });

        it('maps a network failure on the record to "oeis.org is unreachable"', async () => {
          const { service } = serviceOver(new TypeError('fetch failed'));
          holder.service = service;
          const result = await withBackoff(runToolContract(oeisGetCrossRefs, { aNumber: 'A45' }));
          expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
          expect(errorOf(result).message).toContain('oeis.org is unreachable.');
        });
      });
    });
  });

  describe('incoming', () => {
    const incoming = (input: Record<string, unknown> = {}) => ({
      aNumber: 'A45',
      direction: 'incoming',
      ...input,
    });
    const mentionsPage = (options: { count: number; firstRow?: number; total: number }) =>
      syntheticSearchPage({ ...options, query: 'a000045 -id:a000045' });

    it('searches for the A-number minus the entry itself, with no record fetch', async () => {
      const { calls, result } = await crossRefs(
        incoming(),
        page(mentionsPage({ count: 3, total: 3 })),
      );
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]?.url ?? '').pathname).toBe('/search');
      expect(queryOf(calls[0]).get('q')).toBe('A000045 -id:A000045');
      expect(queryOf(calls[0]).get('fmt')).toBe('text');
      expect(queryOf(calls[0]).has('start')).toBe(false);
    });

    it('lists the mentioning entries in relevance order as resolved rows without outgoing-only fields', async () => {
      const { result } = await crossRefs(incoming(), page(mentionsPage({ count: 3, total: 3 })));
      expect(structured(result)).toMatchObject({
        aNumber: 'A000045',
        direction: 'incoming',
        start: 0,
        truncated: false,
        shown: 3,
        cap: 10,
        totalCount: 3,
        effectiveQuery: 'a000045 -id:a000045',
      });
      expect(structured(result)).not.toHaveProperty('lines');
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(related(result).map((row) => row.aNumber)).toEqual(['A100000', 'A100001', 'A100002']);
      for (const row of related(result)) {
        expect(row).toMatchObject({ resolved: true, url: `https://oeis.org/${row.aNumber}` });
        expect(row).not.toHaveProperty('note');
        expect(row).not.toHaveProperty('lineIndex');
      }
      expect(structured(result).notice).toBeUndefined();
    });

    it('pages by start and offers nextStart within the window', async () => {
      const { calls, result } = await crossRefs(
        incoming({ start: 30 }),
        page(mentionsPage({ count: 10, firstRow: 31, total: 6161 })),
      );
      expect(queryOf(calls[0]).get('start')).toBe('30');
      expect(structured(result)).toMatchObject({
        start: 30,
        nextStart: 40,
        truncated: true,
        shown: 10,
        totalCount: 6161,
      });
      expect(structured(result).notice).toBe(
        'Showing 31-40 of 6161; call again with start 40 for the next page.',
      );
    });

    it('stops at start 100 and names the 110-entry window', async () => {
      const { result } = await crossRefs(
        incoming({ start: 100 }),
        page(mentionsPage({ count: 10, firstRow: 101, total: 6161 })),
      );
      expect(structured(result)).toMatchObject({ start: 100, truncated: true, shown: 10 });
      expect(structured(result)).not.toHaveProperty('nextStart');
      expect(structured(result).notice).toBe(
        'OEIS lists only the first 110 of 6161 entries that mention A000045 without an account; narrow with oeis_search_sequences, e.g. "A000045 keyword:core".',
      );
    });

    it('reports no mention at any start, since OEIS answers "No results." only when nothing matches', async () => {
      const none = await crossRefs(incoming(), page(noResultsSearchPage));
      expect(related(none.result)).toEqual([]);
      expect(structured(none.result)).toMatchObject({ truncated: false, shown: 0, totalCount: 0 });
      expect(structured(none.result).notice).toBe('No other OEIS entry mentions this A-number.');
      const later = await crossRefs(incoming({ start: 20 }), page(noResultsSearchPage));
      expect(structured(later.result)).toMatchObject({ start: 20, shown: 0 });
      expect(structured(later.result).notice).toBe('No other OEIS entry mentions this A-number.');
    });

    it('does not need the A-number to exist: a quiet entry is an empty page, not sequence_not_found', async () => {
      const { calls, result } = await crossRefs(
        { aNumber: 'A999999', direction: 'incoming' },
        page(noResultsSearchPage),
      );
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it('reports a too-many page with the narrowing example for this A-number', async () => {
      const { result } = await crossRefs(incoming(), page(tooManySearchPage));
      expect(related(result)).toEqual([]);
      expect(structured(result)).toMatchObject({ truncated: false, shown: 0, cap: 10 });
      expect(structured(result)).not.toHaveProperty('totalCount');
      expect(structured(result).notice).toBe(
        'OEIS reports too many entries mentioning A000045 to list; narrow with oeis_search_sequences, e.g. "A000045 keyword:core".',
      );
    });

    it.each([30, 100])(
      'labels a start of %i past the last entry as the last page OEIS served, from start 20',
      async (start) => {
        const { result } = await crossRefs(
          incoming({ start }),
          page(mentionsPage({ count: 6, firstRow: 21, total: 26 })),
        );
        expect(related(result)).toHaveLength(6);
        expect(structured(result)).toMatchObject({
          start: 20,
          truncated: false,
          shown: 6,
          totalCount: 26,
          notice: `Start ${start} is past the last of 26 entries; this is the last page, from start 20.`,
        });
        expect(structured(result)).not.toHaveProperty('nextStart');
        expect(textOf(result)).toContain('# Entries that mention A000045 (start 20)');
        expect(textOf(result)).toContain('## 21. A100000:');
        expect(textOf(result)).toContain('## 26. A100005:');
        expect(textOf(result)).not.toContain('## 31.');
      },
    );

    it('fails the call, never degrading, on a search 5xx or 429', async () => {
      const limited = await crossRefs(
        incoming(),
        res('slow', { status: 429, headers: { 'retry-after': '120' } }),
      );
      expect(errorOf(limited.result)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { retryAfter: '120' },
      });
      vi.useFakeTimers();
      try {
        const { service, calls } = serviceOver(res('oops', { status: 502 }));
        holder.service = service;
        const result = await withBackoff(runToolContract(oeisGetCrossRefs, incoming() as never));
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { retryAttempts: 3 },
        });
        expect(calls).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('turns the anonymous paging-cap 403 into result_window_exceeded', async () => {
      const { result } = await crossRefs(
        incoming({ start: 100 }),
        res(signInRefusalBody, { status: 403 }),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'result_window_exceeded' },
      });
    });

    it('reports an unknown status line as non-retryable upstream_unparseable', async () => {
      const { calls, result } = await crossRefs(
        incoming(),
        page(searchPageText({ query: 'a', status: 'Something new' })),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unparseable', retryable: false },
      });
      expect(calls).toHaveLength(1);
    });
  });

  describe('required enrichment', () => {
    it('carries truncated, shown, and cap on the zero-result page (outgoing, no A-numbers)', async () => {
      const { result } = await crossRefs({ aNumber: 'A45' }, record(withXref([])));
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({
        related: [],
        truncated: false,
        shown: 0,
        cap: 10,
        totalCount: 0,
      });
      expect(structured(result).notice).toEqual(expect.any(String));
      expect(textOf(result)).toContain('**truncated:** false');
      expect(textOf(result)).toContain('**shown:** 0');
      expect(textOf(result)).toContain('**cap:** 10');
    });

    it('carries them on the zero-result pages of a past-the-end start and an empty incoming search', async () => {
      const pastEnd = await crossRefs({ aNumber: 'A45', start: 50 }, record());
      expect(structured(pastEnd.result)).toMatchObject({ truncated: false, shown: 0, cap: 10 });
      const none = await crossRefs(
        { aNumber: 'A45', direction: 'incoming' },
        page(noResultsSearchPage),
      );
      expect(structured(none.result)).toMatchObject({ truncated: false, shown: 0, cap: 10 });
    });

    it('carries them on an under-cap outgoing page, with totalCount and no effectiveQuery', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(),
        page(batchPage('A000032', 'A001045', 'A011973')),
      );
      expect(related(result)).toHaveLength(3);
      expect(structured(result)).toMatchObject({
        truncated: false,
        shown: 3,
        cap: 10,
        totalCount: 3,
      });
      expect(structured(result)).not.toHaveProperty('effectiveQuery');
    });

    it('carries them on an under-cap incoming page, with effectiveQuery', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45', direction: 'incoming' },
        page(syntheticSearchPage({ count: 4, total: 4, query: 'a000045 -id:a000045' })),
      );
      expect(structured(result)).toMatchObject({
        truncated: false,
        shown: 4,
        cap: 10,
        totalCount: 4,
        effectiveQuery: 'a000045 -id:a000045',
      });
    });

    it('carries them on a full page', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(withManyRefs(10)),
        page(batchOf(1, 10)),
      );
      expect(structured(result)).toMatchObject({
        truncated: false,
        shown: 10,
        cap: 10,
        totalCount: 10,
      });
    });

    it('renders the enrichment block in content[]', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(withManyRefs(25)),
        page(batchOf(1, 10)),
      );
      const text = textOf(result);
      expect(text).toContain('**truncated:** true');
      expect(text).toContain('**shown:** 10');
      expect(text).toContain('**cap:** 10');
      expect(text).toContain('**25 total**');
    });
  });

  describe('pacer_shed', () => {
    const withShedService = async (steps: ReturnType<typeof res>[], run: () => Promise<void>) => {
      const pacer = createPacer({
        name: 'oeis-xref-tool-test',
        minStartGapMs: 10_000,
        maxConcurrent: 1,
      });
      try {
        const { calls, fetch } = scriptedFetch(...steps);
        holder.service = new OeisService({ fetch, pacer, queueMaxWaitMs: 1_000 });
        await run();
        return calls;
      } finally {
        pacer.dispose();
      }
    };

    it('sheds a queued record fetch through the contract: RateLimited, retryable, with recovery', async () => {
      const calls = await withShedService([record(withXref([]))], async () => {
        const first = await runToolContract(oeisGetCrossRefs, { aNumber: 'A45' });
        expect(first.isError).toBeUndefined();
        const shed = await runToolContract(oeisGetCrossRefs, { aNumber: 'A108' });
        expect(shed.isError).toBe(true);
        expect(errorOf(shed)).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'pacer_shed',
            retryAfter: expect.anything(),
            recovery: { hint: expect.stringContaining('oeis_get_cross_refs again') },
          },
        });
        expect(textOf(shed)).toContain('reason pacer_shed');
      });
      expect(calls).toHaveLength(1);
    });

    it('sheds a queued incoming search through the same contract', async () => {
      const calls = await withShedService([page(noResultsSearchPage)], async () => {
        const first = await runToolContract(oeisGetCrossRefs, {
          aNumber: 'A45',
          direction: 'incoming',
        });
        expect(first.isError).toBeUndefined();
        const shed = await runToolContract(oeisGetCrossRefs, {
          aNumber: 'A108',
          direction: 'incoming',
        });
        expect(errorOf(shed)).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'pacer_shed' },
        });
      });
      expect(calls).toHaveLength(1);
    });

    it('degrades, rather than fails, when only the name batch is shed', async () => {
      await withShedService([record()], async () => {
        const result = await runToolContract(oeisGetCrossRefs, { aNumber: 'A45' });
        expect(result.isError).toBeUndefined();
        expect(related(result).map((row) => row.resolved)).toEqual([false, false, false]);
        expect(related(result).map((row) => row.aNumber)).toEqual([
          'A000032',
          'A001045',
          'A011973',
        ]);
        expect(structured(result).notice).toContain('could not be fetched (pacer_shed)');
        expect(structured(result).notice).toMatch(
          /again with the same start after about \d+ seconds/,
        );
        expect(structured(result)).toMatchObject({ truncated: false, shown: 3, totalCount: 3 });
      });
    });

    it('declares sequence_not_found, pacer_shed, and upstream_rate_limited', () => {
      expect(oeisGetCrossRefs.errors).toEqual([
        expect.objectContaining({
          reason: 'sequence_not_found',
          code: JsonRpcErrorCode.NotFound,
        }),
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
          recovery: expect.stringContaining('oeis_get_cross_refs again'),
        }),
      ]);
    });
  });

  describe('format', () => {
    it('carries every row field and the cross-reference lines of an outgoing result', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(withXref(['Cf. A000032 (Lucas), A001045.', 'Row sums of A011973.'])),
        page(
          batchPage('A000032', 'A001045', 'A011973').replace(
            'Name of A011973.',
            'Name of A011973.',
          ),
        ),
      );
      const text = textOf(result);
      expect(text).toContain('# Sequences A000045 cross-references (start 0)');
      expect(text).toContain('**Direction:** outgoing');
      related(result).forEach((row, i) => {
        expect(text).toContain(`## ${i + 1}. ${row.aNumber}: ${row.name}`);
        expect(text).toContain('**Resolved:** yes');
        expect(text).toContain(`**Terms:** ${row.terms?.join(', ')}`);
        expect(text).toContain(`**Offset:** ${row.offset}`);
        expect(text).toContain(`**First term:** a(${row.firstIndex})`);
        expect(text).toContain(`**Keywords:** ${row.keywords?.join(', ')}`);
        expect(text).toContain(`**URL:** ${row.url}`);
      });
      expect(text).toContain('**Note:** Lucas');
      expect(text).toContain('**Cross-reference line:** 0');
      expect(text).toContain('**Cross-reference line:** 1');
      expect(text).toContain('## Cross-reference lines');
      expect(text).toContain('Line 0:\n> Cf. A000032 (Lucas), A001045.');
      expect(text).toContain('Line 1:\n> Row sums of A011973.');
    });

    it('renders an incoming result with its heading and no cross-reference lines section', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45', direction: 'incoming', start: 20 },
        page(
          syntheticSearchPage({ count: 10, firstRow: 21, total: 60, query: 'a000045 -id:a000045' }),
        ),
      );
      const text = textOf(result);
      expect(text).toContain('# Entries that mention A000045 (start 20)');
      expect(text).toContain('**Direction:** incoming');
      expect(text).toContain('## 21. A100000: Synthetic 0.');
      expect(text).not.toContain('## Cross-reference lines');
      expect(text).not.toContain('**Cross-reference line:**');
      expect(text).toContain('**Next page:** call again with start 30.');
    });

    it('renders an unresolved row without a name and says it was not fetched', async () => {
      const { result } = await crossRefs(
        { aNumber: 'A45' },
        record(withXref(['Cf. A000032 (Lucas).'])),
        page(noResultsSearchPage),
      );
      const text = textOf(result);
      expect(text).toContain('## 1. A000032\n');
      expect(text).toContain('**Resolved:** no (name and terms not fetched)');
      expect(text).toContain('**Note:** Lucas');
      expect(text).not.toContain('**Terms:**');
      expect(text).not.toContain('**Offset:**');
      expect(text).toContain('**URL:** https://oeis.org/A000032');
    });

    it('prints the zero-result heading and the guidance from the enrichment block', async () => {
      const { result } = await crossRefs({ aNumber: 'A45' }, record(withXref([])));
      const text = textOf(result);
      expect(text).toContain('# Sequences A000045 cross-references (start 0)');
      expect(text).toContain('No related sequences on this page.');
      expect(text).toContain(String(structured(result).notice));
    });

    it('flattens CR/LF in every inline slot and quotes every line of a multi-line cross-reference', () => {
      const blocks = oeisGetCrossRefs.format?.({
        aNumber: 'A000001',
        direction: 'outgoing',
        related: [
          {
            aNumber: 'A000002',
            resolved: true,
            name: 'a\nb\r\nc',
            terms: ['1', '2\n3'],
            offset: '0,1\n# x',
            firstIndex: 0,
            keywords: ['nonn\n## y', 'easy'],
            note: 'n1\n# n2',
            lineIndex: 0,
            url: 'https://oeis.org/A000002',
          },
        ],
        lines: ['Cf. A000002\n# not a heading\r\n- not a list'],
        start: 10,
      });
      const text = blocksText(blocks);
      expect(text).toContain('## 11. A000002: a b c');
      expect(text).toContain('**Note:** n1 # n2');
      expect(text).toContain('**Terms:** 1, 2 3');
      expect(text).toContain('**Offset:** 0,1 # x');
      expect(text).toContain('**Keywords:** nonn ## y, easy');
      expect(text).toContain('> Cf. A000002\n> # not a heading\n> - not a list');
      expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
        '# Sequences A000001 cross-references (start 10)',
        '## 11. A000002: a b c',
        '## Cross-reference lines',
      ]);
    });

    it('renders empty terms and keywords as none, an empty lines list as None, and nextStart only when present', () => {
      const base = {
        aNumber: 'A000001',
        direction: 'outgoing' as const,
        related: [
          {
            aNumber: 'A000002',
            resolved: true,
            name: 'x',
            terms: [],
            keywords: [],
            url: 'https://oeis.org/A000002',
          },
        ],
        lines: [],
        start: 0,
      };
      const text = blocksText(oeisGetCrossRefs.format?.(base));
      expect(text).toContain('**Terms:** none listed');
      expect(text).toContain('**Keywords:** none');
      expect(text).toContain('## Cross-reference lines\n\nNone.');
      expect(text).not.toContain('Next page');
      expect(blocksText(oeisGetCrossRefs.format?.({ ...base, nextStart: 10 }))).toContain(
        '**Next page:** call again with start 10.',
      );
    });
  });
});
