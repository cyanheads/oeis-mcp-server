/**
 * @fileoverview Tests for the `/search?fmt=text` parser: the `Search:` echo, the three status
 * lines, the `%I %S %T %U %N %K %O %A` record lines (author, last-edit time in America/New_York,
 * legacy ids), and the three failure classes.
 * @module tests/services/oeis/internal-format.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parseSearchText } from '@/services/oeis/internal-format.js';
import { normalizeRecord } from '@/services/oeis/normalize-record.js';
import type { SequenceSummary } from '@/services/oeis/types.js';
import { cpuMs } from '../../fixtures/cpu-time.js';
import {
  capturedRecordJson,
  capturedSearchRecords,
  catalanSearchRecord,
  clampedSearchPage,
  fibonacciSearchRecord,
  htmlMaintenanceBody,
  moebiusSearchPage,
  noResultsSearchPage,
  reservedSearchRecordText,
  resultsSearchPage,
  searchPageText,
  searchRecordText,
  tooManySearchPage,
} from '../../fixtures/oeis-upstream.js';

function parseError(text: string): McpError {
  try {
    parseSearchText(text);
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected parseSearchText to throw.');
}

describe('parseSearchText', () => {
  describe('results pages', () => {
    it('reads the Search: echo, the total, and every record in page order', () => {
      const page = parseSearchText(resultsSearchPage);
      expect(page.status).toBe('results');
      expect(page.total).toBe(26);
      expect(page.effectiveQuery).toBe('seq:1,2,5,14,42,132,429');
      expect(page.rows.map((r) => r.aNumber)).toEqual(['A000108', 'A000045']);
    });

    it('joins %S, %T and %U into one term list and drops the trailing commas', () => {
      const [catalan] = parseSearchText(resultsSearchPage).rows;
      expect(catalan?.terms).toEqual([
        '1',
        '1',
        '2',
        '5',
        '14',
        '42',
        '132',
        '429',
        '1430',
        '4862',
        '16796',
        '58786',
      ]);
    });

    it('removes a non-web href from a %N name and keeps a web one', () => {
      const [unsafe, safe] = parseSearchText(
        searchPageText({
          query: 'id:a000001|id:a000002',
          status: 'Showing 1-2 of 2',
          records: [
            {
              ...fibonacciSearchRecord,
              aNumber: 'A000001',
              name: 'X <a href="javascript:y">z</a>',
            },
            { ...fibonacciSearchRecord, aNumber: 'A000002', name: 'X <a href="/A000045">z</a>' },
          ],
        }),
      ).rows;
      expect(unsafe?.name).toBe('X <a>z</a>');
      expect(safe?.name).toBe('X <a href="/A000045">z</a>');
    });

    it('reads name, keywords, offset, firstIndex and the canonical URL', () => {
      const [catalan] = parseSearchText(resultsSearchPage).rows;
      expect(catalan).toMatchObject({
        name: 'Catalan numbers: C(n) = binomial(2n,n)/(n+1) = (2n)!/(n!(n+1)!).',
        keywords: ['core', 'nonn', 'easy', 'eigen', 'nice', 'changed'],
        offset: '0,3',
        firstIndex: 0,
        url: 'https://oeis.org/A000108',
      });
    });

    it('keeps signed terms as exact strings', () => {
      const [mobius] = parseSearchText(moebiusSearchPage).rows;
      expect(mobius?.terms).toEqual([
        '1',
        '-1',
        '-1',
        '0',
        '-1',
        '1',
        '-1',
        '0',
        '0',
        '1',
        '-1',
        '0',
      ]);
      expect(mobius?.firstIndex).toBe(1);
    });

    it('ignores the greeting, the license line, and every record line it does not read', () => {
      const [fib] = parseSearchText(resultsSearchPage).rows;
      expect(Object.keys(fib ?? {}).sort()).toEqual(
        [
          'aNumber',
          'author',
          'firstIndex',
          'keywords',
          'legacyIds',
          'modified',
          'name',
          'offset',
          'terms',
          'url',
        ].sort(),
      );
      expect(fib?.name).not.toContain('comment line');
    });

    it('parses a CRLF page the same as an LF page', () => {
      const crlf = searchPageText({
        eol: '\r\n',
        query: 'seq:1,2,5,14,42,132,429',
        status: 'Showing 1-2 of 26',
        records: [],
      });
      expect(parseSearchText(crlf)).toMatchObject({ status: 'results', total: 26, rows: [] });
      expect(parseSearchText(resultsSearchPage.replaceAll('\n', '\r\n'))).toEqual(
        parseSearchText(resultsSearchPage),
      );
    });

    it('tolerates blank lines and padding around the status line', () => {
      const text = 'Search: x\n\n\n  Showing 1-1 of 1  \n%N A000001 Name\n%O A000001 0,1\n';
      expect(parseSearchText(text)).toMatchObject({ status: 'results', total: 1 });
    });

    it('accepts seven-digit A-numbers', () => {
      const text =
        'Search: x\nShowing 1-1 of 1\n%S A1234567 1,2\n%N A1234567 Future entry\n%O A1234567 1,2\n';
      expect(parseSearchText(text).rows[0]).toMatchObject({
        aNumber: 'A1234567',
        url: 'https://oeis.org/A1234567',
      });
    });

    it('reads a record with no %K line as an empty keyword list and no %S data as no terms', () => {
      const text = 'Search: x\nShowing 1-1 of 1\n%N A000001 Name\n%O A000001 4,2\n';
      expect(parseSearchText(text).rows[0]).toMatchObject({
        keywords: [],
        terms: [],
        firstIndex: 4,
      });
    });

    it('reads firstIndex from a single-number or negative offset', () => {
      const text = (offset: string) =>
        `Search: x\nShowing 1-1 of 1\n%N A000001 Name\n%O A000001 ${offset}\n`;
      expect(parseSearchText(text('7')).rows[0]?.firstIndex).toBe(7);
      expect(parseSearchText(text('-3,2')).rows[0]?.firstIndex).toBe(-3);
    });

    it('reads the offset OEIS served from the Showing line', () => {
      expect(parseSearchText(resultsSearchPage).start).toBe(0);
      expect(parseSearchText('Search: x\nShowing 91-100 of 183\n').start).toBe(90);
    });

    it('reads a start past the end as the last page OEIS clamped it to', () => {
      const page = parseSearchText(clampedSearchPage);
      expect(page).toMatchObject({ status: 'results', start: 20, total: 26 });
      expect(page.rows).toHaveLength(6);
    });

    it('returns an empty row list when the status promises results but no record follows', () => {
      expect(parseSearchText('Search: x\nShowing 1-10 of 40\n')).toMatchObject({
        status: 'results',
        total: 40,
        rows: [],
      });
    });

    it('does not let a cross-reference line in one record bleed into another', () => {
      const text = [
        'Search: x',
        'Showing 1-2 of 2',
        '%S A000001 1,2,',
        '%N A000001 First',
        '%Y A000001 Cf. A000002.',
        '%O A000001 1,2',
        '',
        '%S A000002 3,4',
        '%N A000002 Second',
        '%O A000002 1,1',
      ].join('\n');
      const rows = parseSearchText(text).rows;
      expect(rows.map((r) => r.terms)).toEqual([
        ['1', '2'],
        ['3', '4'],
      ]);
    });
  });

  describe('reserved and recycled rows', () => {
    const pageWith = (...records: Parameters<typeof searchPageText>[0]['records'] & {}) =>
      parseSearchText(
        searchPageText({
          query: 'keyword:allocated',
          status: `Showing 1-${records.length} of ${records.length}`,
          records,
        }),
      );

    it('reads a reserved row with an empty %S and no %O or %A line as a summary without offset, firstIndex, or author', () => {
      expect(pageWith(reservedSearchRecordText()).rows).toEqual([
        {
          aNumber: 'A397217',
          name: 'allocated for Jane Doe',
          terms: [],
          keywords: ['allocated'],
          modified: '2026-09-29T12:00:00-04:00',
          url: 'https://oeis.org/A397217',
        },
      ]);
    });

    it('reads the reserved and recycled rows oeis.org serves: modified from %I, no author', () => {
      expect(pageWith(capturedSearchRecords.A397217, capturedSearchRecords.A395050).rows).toEqual([
        {
          aNumber: 'A397217',
          name: 'allocated for Eric Stolee',
          terms: [],
          keywords: ['allocated'],
          modified: '2026-09-29T20:19:41-04:00',
          url: 'https://oeis.org/A397217',
        },
        {
          aNumber: 'A395050',
          name: '',
          terms: [],
          keywords: ['recycled'],
          modified: '2026-09-22T17:49:40-04:00',
          url: 'https://oeis.org/A395050',
        },
      ]);
    });

    it('reads a recycled row the same way', () => {
      const recycled = reservedSearchRecordText().replace(
        '%K A397217 allocated',
        '%K A397217 recycled',
      );
      const [row] = pageWith(recycled).rows;
      expect(row).toMatchObject({ aNumber: 'A397217', keywords: ['recycled'] });
      expect(row).not.toHaveProperty('offset');
    });

    it('lists a reserved row beside ordinary rows instead of failing the page', () => {
      const page = pageWith(fibonacciSearchRecord, reservedSearchRecordText(), catalanSearchRecord);
      expect(page.rows.map((row) => row.aNumber)).toEqual(['A000045', 'A397217', 'A000108']);
      expect(page.rows[0]).toMatchObject({ offset: '0,4', firstIndex: 0 });
      expect(page.rows[2]).toMatchObject({ offset: '0,3', firstIndex: 0 });
    });
  });

  describe('author, modified, and legacyIds', () => {
    const pageOf = (...records: string[]) =>
      parseSearchText(
        searchPageText({
          query: 'x',
          status: `Showing 1-${records.length} of ${records.length}`,
          records,
        }),
      );
    const rowOf = (record: string) => pageOf(record).rows[0];

    /** A000001 with the given `%I` and `%A` values after the A-number; `undefined` leaves the line out. */
    const rowWith = (id: string | undefined, author: string | undefined) =>
      rowOf(
        [
          ...(id === undefined ? [] : [`%I A000001 ${id}`]),
          '%S A000001 1,2,3',
          '%N A000001 Name',
          '%K A000001 nonn',
          '%O A000001 0,1',
          ...(author === undefined ? [] : [`%A A000001 ${author}`]),
        ].join('\n'),
      );
    const plainRow = {
      aNumber: 'A000001',
      name: 'Name',
      terms: ['1', '2', '3'],
      offset: '0,1',
      firstIndex: 0,
      keywords: ['nonn'],
      url: 'https://oeis.org/A000001',
    };

    it('reads the author, the last edit, and both legacy ids of the A000045 row oeis.org serves', () => {
      expect(rowOf(capturedSearchRecords.A000045)).toEqual({
        aNumber: 'A000045',
        name: 'Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
        terms: expect.arrayContaining(['0', '832040', '102334155']),
        offset: '0,4',
        firstIndex: 0,
        keywords: ['nonn', 'core', 'nice', 'easy', 'hear', 'changed'],
        author: '_N. J. A. Sloane_, 1964',
        modified: '2026-09-23T16:08:09-04:00',
        legacyIds: ['M0692', 'N0256'],
        url: 'https://oeis.org/A000045',
      });
    });

    it('gives one legacy id as a one-element array and none as no legacyIds key', () => {
      expect(rowOf(capturedSearchRecords.A005700)?.legacyIds).toEqual(['M2975']);
      expect(rowOf(capturedSearchRecords.A007318)?.legacyIds).toEqual(['M0082']);
      const row = rowOf(capturedSearchRecords.A399236);
      expect(row).not.toHaveProperty('legacyIds');
      expect(row?.modified).toBe('2026-10-01T14:35:22-04:00');
    });

    it('writes a winter timestamp with the -05:00 offset', () => {
      expect(rowOf(capturedSearchRecords.A068875)?.modified).toBe('2026-01-15T13:24:20-05:00');
      expect(rowOf(capturedSearchRecords.A288942)?.modified).toBe('2025-11-05T15:22:40-05:00');
    });

    it('passes a two-author line and one without wiki underscores through verbatim', () => {
      expect(rowOf(capturedSearchRecords.A007318)?.author).toBe(
        '_N. J. A. Sloane_ and _Mira Bernstein_, Apr 28 1994',
      );
      expect(rowOf(capturedSearchRecords.A033191)?.author).toBe('Simon P. Norton');
    });

    it('reads every row of a full page, each from its own %I and %A lines', () => {
      const rows = pageOf(
        capturedSearchRecords.A000045,
        capturedSearchRecords.A397217,
        capturedSearchRecords.A005700,
        capturedSearchRecords.A068875,
        capturedSearchRecords.A007318,
        capturedSearchRecords.A395050,
        capturedSearchRecords.A033191,
        searchRecordText(catalanSearchRecord),
        capturedSearchRecords.A288942,
        capturedSearchRecords.A399236,
      ).rows;
      expect(
        rows.map(({ aNumber, author, modified, legacyIds }) => [
          aNumber,
          author,
          modified,
          legacyIds,
        ]),
      ).toEqual([
        ['A000045', '_N. J. A. Sloane_, 1964', '2026-09-23T16:08:09-04:00', ['M0692', 'N0256']],
        ['A397217', undefined, '2026-09-29T20:19:41-04:00', undefined],
        ['A005700', '_N. J. A. Sloane_', '2026-07-30T18:33:54-04:00', ['M2975']],
        ['A068875', '_N. J. A. Sloane_, Jun 06 2002', '2026-01-15T13:24:20-05:00', undefined],
        [
          'A007318',
          '_N. J. A. Sloane_ and _Mira Bernstein_, Apr 28 1994',
          '2026-09-25T10:59:50-04:00',
          ['M0082'],
        ],
        ['A395050', undefined, '2026-09-22T17:49:40-04:00', undefined],
        ['A033191', 'Simon P. Norton', '2026-06-30T19:56:59-04:00', undefined],
        [
          'A000108',
          '_N. J. A. Sloane_, Apr 30 1991',
          '2026-09-15T21:11:07-04:00',
          ['M1459', 'N0577'],
        ],
        ['A288942', '_Alois P. Heinz_, Sep 01 2017', '2025-11-05T15:22:40-05:00', undefined],
        ['A399236', '_Benjamin Simon Strang_, Aug 23 2026', '2026-10-01T14:35:22-04:00', undefined],
      ]);
    });

    it('reads the last line when %A or %I repeats, without mixing in the earlier one', () => {
      expect(
        rowOf(
          [
            '%I A000001 M0001 #1 Jan 15 2026 13:24:20',
            '%S A000001 1,2,3',
            '%N A000001 Name',
            '%K A000001 nonn',
            '%O A000001 0,1',
            '%A A000001 _First Author_',
            '%I A000001 #2 Sep 23 2026 16:08:09',
            '%A A000001 _Second Author_, Jan 01 2000',
          ].join('\n'),
        ),
      ).toEqual({
        ...plainRow,
        author: '_Second Author_, Jan 01 2000',
        modified: '2026-09-23T16:08:09-04:00',
      });
    });

    it('reads the same modified whatever time zone the process runs in', () => {
      const page = () =>
        pageOf(
          capturedSearchRecords.A000045,
          capturedSearchRecords.A068875,
          ['%I A000001 #1 Nov 01 2026 01:30:00', '%N A000001 Name', '%O A000001 0,1'].join('\n'),
          ['%I A000002 #1 Mar 08 2026 02:30:00', '%N A000002 Name', '%O A000002 0,1'].join('\n'),
        ).rows.map((row) => row.modified);
      const zones = [
        ['UTC', 0],
        ['America/Los_Angeles', 480],
        ['Asia/Tokyo', -540],
        ['Australia/Lord_Howe', -660],
      ] as const;
      const original = process.env.TZ;
      try {
        for (const [zone, januaryOffset] of zones) {
          process.env.TZ = zone;
          expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).toBe(januaryOffset);
          expect(page()).toEqual([
            '2026-09-23T16:08:09-04:00',
            '2026-01-15T13:24:20-05:00',
            '2026-11-01T01:30:00-04:00',
            '2026-03-08T02:30:00-05:00',
          ]);
        }
      } finally {
        if (original === undefined) Reflect.deleteProperty(process.env, 'TZ');
        else process.env.TZ = original;
      }
    });

    it.each([
      ['A000045', capturedRecordJson.A000045],
      ['A068875', capturedRecordJson.A068875],
      ['A288942', capturedRecordJson.A288942],
    ] as const)(
      'carries the author, modified, and legacyIds the %s record has',
      (aNumber, json) => {
        const fields = ({ author, modified, legacyIds }: Partial<SequenceSummary>) => ({
          author,
          modified,
          legacyIds,
        });
        const record = normalizeRecord(json);
        expect(record.author).toBeDefined();
        expect(record.modified).toBeDefined();
        expect(fields(rowOf(capturedSearchRecords[aNumber]) ?? {})).toEqual(fields(record));
      },
    );

    it.each([
      ['Mar 08 2026 01:59:59', '2026-03-08T01:59:59-05:00', 'the last second before daylight time'],
      [
        'Mar 08 2026 02:30:00',
        '2026-03-08T02:30:00-05:00',
        'the skipped hour, with the offset before the change',
      ],
      ['Mar 08 2026 03:00:00', '2026-03-08T03:00:00-04:00', 'the first second of daylight time'],
      [
        'Nov 01 2026 00:59:59',
        '2026-11-01T00:59:59-04:00',
        'the last second before the repeated hour',
      ],
      ['Nov 01 2026 01:00:00', '2026-11-01T01:00:00-04:00', 'the repeated hour, as daylight time'],
      ['Nov 01 2026 01:59:59', '2026-11-01T01:59:59-04:00', 'the repeated hour, as daylight time'],
      [
        'Nov 01 2026 02:00:00',
        '2026-11-01T02:00:00-05:00',
        'the first second after the repeated hour',
      ],
      ['Mar 20 2006 12:00:00', '2006-03-20T12:00:00-05:00', 'March 2006, before the 2007 rules'],
      [
        'Apr 03 2006 12:00:00',
        '2006-04-03T12:00:00-04:00',
        'April 2006, after the change that year',
      ],
      [
        'Oct 30 2006 12:00:00',
        '2006-10-30T12:00:00-05:00',
        'October 2006, after the change that year',
      ],
      ['Feb 29 2024 23:59:59', '2024-02-29T23:59:59-05:00', 'a leap day'],
    ])('reads %s as America/New_York time %s (%s)', (time, iso) => {
      expect(rowWith(`#12 ${time}`, undefined)?.modified).toBe(iso);
    });

    it('tolerates runs of spaces around and between the %I tokens', () => {
      expect(rowWith('  M0692  N0256  #12  Sep  23  2026  16:08:09  ', undefined)).toMatchObject({
        legacyIds: ['M0692', 'N0256'],
        modified: '2026-09-23T16:08:09-04:00',
      });
    });

    it.each([
      ['no %I line', undefined],
      ['an empty %I', ''],
      ['no timestamp', 'M0692 #12'],
      ['no revision', 'M0692 Sep 23 2026 16:08:09'],
      ['an ISO timestamp', 'M0692 #12 2026-09-23 16:08:09'],
      ['a time zone after the time', 'M0692 #12 Sep 23 2026 16:08:09 EDT'],
      ['a month OEIS does not write', 'M0692 #12 Sept 23 2026 16:08:09'],
      ['a lowercase month', 'M0692 #12 sep 23 2026 16:08:09'],
      ['a day the month does not have', 'M0692 #12 Feb 29 2026 16:08:09'],
      ['hour 24', 'M0692 #12 Sep 23 2026 24:00:00'],
      ['second 60', 'M0692 #12 Sep 23 2026 16:08:60'],
      ['a year before 100', 'M0692 #12 Sep 23 0045 16:08:09'],
      ['a year New York kept local mean time', 'M0692 #12 Sep 23 1850 16:08:09'],
      ['a two-digit year', 'M0692 #12 Sep 23 26 16:08:09'],
      ['an id that is not an M or N number', 'X0692 #12 Sep 23 2026 16:08:09'],
      ['a five-digit legacy id', 'M06920 #12 Sep 23 2026 16:08:09'],
    ])('reads %s as no modified and no legacyIds, and keeps the rest of the row', (_shape, id) => {
      expect(rowWith(id, 'Jane Doe')).toEqual({ ...plainRow, author: 'Jane Doe' });
    });

    it.each([
      ['no %A line', undefined],
      ['an empty %A', ''],
      ['a blank %A', '   '],
    ])('leaves author out for %s', (_shape, author) => {
      const row = rowWith('#12 Sep 23 2026 16:08:09', author);
      expect(row).toEqual({ ...plainRow, modified: '2026-09-23T16:08:09-04:00' });
    });

    it('trims the author and removes a non-web href from it, keeping a web one', () => {
      expect(
        rowWith(
          undefined,
          '  <a href="javascript:alert(1)">Eve</a> and <a href="/wiki/User:X">X</a>, Jan 01 2020  ',
        )?.author,
      ).toBe('<a>Eve</a> and <a href="/wiki/User:X">X</a>, Jan 01 2020');
    });

    it('reads %I and %A lines of 5k, 20k, and 80k characters in time linear in their length', () => {
      /** Each shape runs a scan to its last character and then fails; the %I shapes leave no modified. */
      const shapes = [
        (chars: number) => `%I A000001 ${'M0000 '.repeat(chars / 6)}x`,
        (chars: number) => `%I A000002 M0000${' '.repeat(chars)}x`,
        (chars: number) => `%I A000003 #${'9'.repeat(chars)} x`,
        (chars: number) => `%A A000004 ${'<a href=javascript:x '.repeat(chars / 21)}`,
      ];
      const sizes = [5_000, 20_000, 80_000];
      const SPAN = 16;
      const SAMPLES = 5;
      const REPEAT = 10;
      const pages = sizes.map((chars) =>
        searchPageText({
          query: 'x',
          status: `Showing 1-${shapes.length} of ${shapes.length}`,
          records: shapes.map((shape, i) =>
            [shape(chars), `%N A00000${i + 1} Name`, `%O A00000${i + 1} 0,1`].join('\n'),
          ),
        }),
      );
      for (const page of pages) {
        const rows = parseSearchText(page).rows;
        expect(rows.map((row) => row.modified ?? row.legacyIds)).toEqual([
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
        expect(rows[3]?.author).toMatch(/^<a <a /);
        expect(rows[3]?.author).not.toContain('href');
      }

      const spent = sizes.map((): number[] => []);
      for (let sample = 0; sample < SAMPLES; sample++) {
        pages.forEach((page, size) => {
          spent[size]?.push(
            cpuMs(() => {
              for (let i = 0; i < REPEAT; i++) parseSearchText(page);
            }),
          );
        });
      }
      const fastest = spent.map((samples) => Math.min(...samples));
      const smallest = fastest[0] ?? Number.NaN;
      const largest = fastest.at(-1) ?? Number.NaN;
      // Linear growth keeps the ratio near SPAN; quadratic growth would put it near SPAN².
      expect(largest / smallest).toBeLessThan(SPAN * 2);
      expect(largest / REPEAT).toBeLessThan(100);
    });
  });

  describe('status lines', () => {
    it('reads "No results." as status none with total 0', () => {
      expect(parseSearchText(noResultsSearchPage)).toEqual({
        effectiveQuery: 'id:axyz',
        status: 'none',
        total: 0,
        rows: [],
      });
    });

    it('reads the too-many line as status too_many with no total', () => {
      const page = parseSearchText(tooManySearchPage);
      expect(page).toMatchObject({ status: 'too_many', effectiveQuery: 'prime', rows: [] });
      expect(page).not.toHaveProperty('total');
      expect(page).not.toHaveProperty('start');
    });

    it('does not read record lines under a none or too_many status', () => {
      const text = 'Search: x\nNo results.\n%N A000001 Stray\n%O A000001 0,1\n';
      expect(parseSearchText(text).rows).toEqual([]);
    });
  });

  describe('failure classes', () => {
    it('a body without a Search: line is retryable upstream_unparseable (HTML page)', () => {
      const error = parseError(htmlMaintenanceBody);
      expect(error).toMatchObject({ data: { reason: 'upstream_unparseable' } });
      expect(error.data).not.toMatchObject({ retryable: false });
      expect(error.message).toContain('"Search:"');
    });

    it('an empty body fails the same way', () => {
      const error = parseError('');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable' });
      expect(error.data).not.toMatchObject({ retryable: false });
    });

    it('an unknown status line is non-retryable and stays out of the message', () => {
      const error = parseError('Search: x\nSomething new happened.\n');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toBe(
        'OEIS returned a search page in an unrecognized format: an unknown status line.',
      );
      expect(JSON.stringify(error.data)).not.toContain('Something new');
    });

    it('a Search: line with nothing after it is a non-retryable unknown status', () => {
      const error = parseError('Search: x');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
    });

    it('a record with no %N line is non-retryable', () => {
      const error = parseError('Search: x\nShowing 1-1 of 1\n%S A000001 1,2\n%O A000001 0,1\n');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toContain('A000001');
      expect(error.message).toContain('%N');
    });

    it('a record with no %O line is non-retryable', () => {
      const error = parseError('Search: x\nShowing 1-1 of 1\n%S A000001 1,2\n%N A000001 Name\n');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toContain('%O');
    });

    it('an unreadable offset is non-retryable and stays out of the message', () => {
      const error = parseError(
        'Search: x\nShowing 1-1 of 1\n%N A000001 Name\n%O A000001 see <a href="x">here</a>\n',
      );
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toContain('A000001');
      expect(error.message).not.toContain('here');
      expect(JSON.stringify(error.data)).not.toContain('here');
    });
  });
});
