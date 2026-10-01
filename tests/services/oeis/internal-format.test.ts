/**
 * @fileoverview Tests for the `/search?fmt=text` parser: the `Search:` echo, the three status
 * lines, the `%S %T %U %N %K %O` record lines, and the three failure classes.
 * @module tests/services/oeis/internal-format.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parseSearchText } from '@/services/oeis/internal-format.js';
import {
  catalanSearchRecord,
  clampedSearchPage,
  fibonacciSearchRecord,
  htmlMaintenanceBody,
  moebiusSearchPage,
  noResultsSearchPage,
  reservedSearchRecordText,
  resultsSearchPage,
  searchPageText,
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
        ['aNumber', 'firstIndex', 'keywords', 'name', 'offset', 'terms', 'url'].sort(),
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

    it('reads a reserved row with no %S or %O line as a summary without offset or firstIndex', () => {
      expect(pageWith(reservedSearchRecordText()).rows).toEqual([
        {
          aNumber: 'A397217',
          name: 'allocated for Jane Doe',
          terms: [],
          keywords: ['allocated'],
          url: 'https://oeis.org/A397217',
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

    it('an unknown status line is non-retryable and quotes the line', () => {
      const error = parseError('Search: x\nSomething new happened.\n');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toContain('Something new happened.');
    });

    it('a Search: line with nothing after it is a non-retryable unknown status', () => {
      const error = parseError('Search: x');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
    });

    it('truncates a very long unknown status line in the message', () => {
      const error = parseError(`Search: x\n${'z'.repeat(500)}\n`);
      expect(error.message.length).toBeLessThan(300);
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

    it('an unreadable offset is non-retryable', () => {
      const error = parseError('Search: x\nShowing 1-1 of 1\n%N A000001 Name\n%O A000001 abc\n');
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toContain('"abc"');
    });
  });
});
