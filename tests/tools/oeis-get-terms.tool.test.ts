/**
 * @fileoverview Tests for oeis_get_terms through the tool contract over a real OeisService with a
 * scripted fetch: A-number, fromIndex, and limit input with blank form-client values; the b-file
 * request (206 paging, a 200 cut at 1 MiB), the data-line fallback on a missing b-file, the
 * cached-record routes that skip the b-file request, the sequence_not_found and pacer_shed contracts,
 * slicing and nextFromIndex, every notice, required enrichment on the zero-result and under-cap
 * pages, upstream failure classes, and `format()` parity with `structuredContent`.
 * @module tests/tools/oeis-get-terms.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oeisGetTerms } from '@/mcp-server/tools/definitions/oeis-get-terms.tool.js';
import { OeisService } from '@/services/oeis/oeis-service.js';
import {
  bFileText,
  fibonacciBFile,
  fibonacciRecordJson,
  htmlMaintenanceBody,
  minimalRecordJson,
  oversizedBFile,
  type RawRecord,
  recordBody,
  recordWith,
  reservedRecordJson,
  synthesizedBFile,
} from '../fixtures/oeis-upstream.js';
import { res, scriptedFetch } from '../fixtures/scripted-fetch.js';
import { blocksText, immediatePacer, serviceOver, withBackoff } from '../fixtures/tool-service.js';

const holder = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock('@/services/oeis/oeis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/oeis/oeis-service.js')>()),
  getOeisService: () => holder.service,
}));

type Result = Awaited<ReturnType<typeof runToolContract>>;
type Term = { n: number; value: string };

const FIB_BFILE_URL = 'https://oeis.org/A000045/b000045.txt';
const ONE_MIB = 1_048_576;

const record = (raw: RawRecord = fibonacciRecordJson) =>
  res(recordBody(raw), { status: 200, headers: { 'content-type': 'application/json' } });
const missing = () => res('<html>Not found</html>', { status: 404 });
const bFile = (body: string, headers: Record<string, string> = {}) =>
  res(body, { status: 200, headers: { 'content-type': 'text/plain', ...headers } });
const bFilePartial = (body: string, total = body.length) =>
  res(body, {
    status: 206,
    headers: {
      'content-range': `bytes 0-${body.length - 1}/${total}`,
      'content-type': 'text/plain',
    },
  });

async function getTerms(
  input: Record<string, unknown>,
  ...steps: ReturnType<typeof res>[]
): Promise<{ calls: ReturnType<typeof serviceOver>['calls']; result: Result }> {
  const { calls, service } = serviceOver(...steps);
  holder.service = service;
  return { calls, result: await runToolContract(oeisGetTerms, input as never) };
}

const structured = (result: Result) => result.structuredContent as Record<string, unknown>;
const terms = (result: Result) => structured(result).terms as Term[];
const ns = (result: Result) => terms(result).map((term) => term.n);
const textOf = (result: Result) =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
const errorOf = (result: Result) =>
  structured(result).error as { code: number; data: Record<string, unknown>; message: string };

afterEach(() => {
  holder.service = undefined;
});

describe('oeis_get_terms', () => {
  describe('input', () => {
    it('normalizes every accepted A-number form to the zero-padded one', () => {
      for (const given of ['A000045', 'a000045', 'A45', '45', ' 45 ', 'https://oeis.org/A000045']) {
        expect(oeisGetTerms.input.parse({ aNumber: given }).aNumber).toBe('A000045');
      }
      expect(oeisGetTerms.input.parse({ aNumber: 'oeis.org/A000045/b000045.txt' }).aNumber).toBe(
        'A000045',
      );
      expect(oeisGetTerms.input.parse({ aNumber: 'A1234567' }).aNumber).toBe('A1234567');
    });

    it.each(['M1459', 'N0256', '', 'A', 'A12345678', 'abc', 'A00004x', '-5'])(
      'rejects the A-number %j',
      (aNumber) => {
        expect(oeisGetTerms.input.safeParse({ aNumber }).success).toBe(false);
      },
    );

    it('rejects a missing or non-string A-number', () => {
      expect(oeisGetTerms.input.safeParse({}).success).toBe(false);
      expect(oeisGetTerms.input.safeParse({ aNumber: 45 }).success).toBe(false);
      expect(oeisGetTerms.input.safeParse({ aNumber: null }).success).toBe(false);
    });

    it('defaults limit to 100 and leaves fromIndex unset', () => {
      const parsed = oeisGetTerms.input.parse({ aNumber: 'A45' });
      expect(parsed.limit).toBe(100);
      expect(parsed.fromIndex).toBeUndefined();
    });

    it('reads blank fromIndex and limit (form clients send "") as unset and the default', () => {
      for (const blank of ['', '  ', '\t']) {
        const parsed = oeisGetTerms.input.parse({ aNumber: 'A45', fromIndex: blank, limit: blank });
        expect(parsed.limit).toBe(100);
        expect(parsed.fromIndex).toBeUndefined();
      }
    });

    it.each([1, 100, 1000])('accepts limit %i', (limit) => {
      expect(oeisGetTerms.input.parse({ aNumber: 'A45', limit }).limit).toBe(limit);
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['past the cap', 1001],
      ['fractional', 10.5],
      ['a numeric string', '50'],
      ['null', null],
    ])('rejects limit that is %s', (_label, limit) => {
      expect(oeisGetTerms.input.safeParse({ aNumber: 'A45', limit }).success).toBe(false);
    });

    it.each([0, 5, -3, 100_000])('accepts the integer fromIndex %i', (fromIndex) => {
      expect(oeisGetTerms.input.parse({ aNumber: 'A45', fromIndex }).fromIndex).toBe(fromIndex);
    });

    it.each([
      ['fractional', 1.5],
      ['a numeric string', '5'],
      ['null', null],
      ['a word', 'start'],
    ])('rejects fromIndex that is %s', (_label, fromIndex) => {
      expect(oeisGetTerms.input.safeParse({ aNumber: 'A45', fromIndex }).success).toBe(false);
    });

    it('answers a rejected A-number with invalid_arguments and no request', async () => {
      const { calls, result } = await getTerms({ aNumber: 'M1459' }, bFile(fibonacciBFile));
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(calls).toHaveLength(0);
    });

    it('runs a form-client payload as the defaults', async () => {
      const { result } = await getTerms(
        { aNumber: '45', fromIndex: '', limit: '' },
        bFile(fibonacciBFile),
      );
      expect(result.isError).toBeUndefined();
      expect(ns(result)).toEqual(Array.from({ length: 15 }, (_, i) => i));
      expect(structured(result)).toMatchObject({ cap: 100 });
    });
  });

  describe('b-file route', () => {
    it('requests only the canonical b-file, with a 1 MiB Range, when nothing is cached', async () => {
      const { calls, result } = await getTerms({ aNumber: 'A45' }, bFile(fibonacciBFile));
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(FIB_BFILE_URL);
      expect(calls[0]?.headers.get('range')).toBe(`bytes=0-${ONE_MIB - 1}`);
      expect(calls[0]?.init.redirect).toBe('manual');
    });

    it('returns the terms of a complete 200 b-file with their indices', async () => {
      const { result } = await getTerms({ aNumber: 'A000045' }, bFile(fibonacciBFile));
      expect(structured(result)).toMatchObject({
        aNumber: 'A000045',
        source: 'bfile',
        firstAvailableIndex: 0,
        lastAvailableIndex: 14,
        bFileUrl: FIB_BFILE_URL,
        bFileCut: false,
        url: 'https://oeis.org/A000045',
      });
      expect(structured(result)).not.toHaveProperty('nextFromIndex');
      expect(structured(result)).not.toHaveProperty('bFileSizeInBytes');
      expect(terms(result).slice(0, 4)).toEqual([
        { n: 0, value: '0' },
        { n: 1, value: '1' },
        { n: 2, value: '1' },
        { n: 3, value: '2' },
      ]);
      expect(terms(result).at(-1)).toEqual({ n: 14, value: '377' });
    });

    it('reports the full size from Content-Length on a 200', async () => {
      const { result } = await getTerms(
        { aNumber: 'A000045' },
        bFile(fibonacciBFile, { 'content-length': String(fibonacciBFile.length) }),
      );
      expect(structured(result)).toMatchObject({
        bFileSizeInBytes: fibonacciBFile.length,
        bFileCut: false,
      });
    });

    it('starts at the first index a b-file carries when that is not 0', async () => {
      const { result } = await getTerms(
        { aNumber: 'A000045' },
        bFile(bFileText(['2', '3', '5'], 1)),
      );
      expect(ns(result)).toEqual([1, 2, 3]);
      expect(structured(result)).toMatchObject({ firstAvailableIndex: 1, lastAvailableIndex: 3 });
    });

    it('keeps signs and values beyond 2^53 as exact decimal strings', async () => {
      const big = '123456789012345678901234567890';
      const { result } = await getTerms(
        { aNumber: 'A000045' },
        bFile(bFileText(['-1', big, `-${big}`, '9007199254740993'])),
      );
      expect(terms(result).map((term) => term.value)).toEqual([
        '-1',
        big,
        `-${big}`,
        '9007199254740993',
      ]);
    });

    it('parses tab separators, CRLF line ends, and padding, and skips comments and junk lines', async () => {
      const body = [
        '# Table of n, a(n) for n = 0..5',
        '',
        '0\t10',
        '  1   20  ',
        '2 30\r',
        'not a term line',
        '3 40 50',
        '3.5 7',
        '#4 99',
        '9007199254740993 5',
        '4 -50',
        '',
      ].join('\n');
      const { result } = await getTerms({ aNumber: 'A000045' }, bFile(body));
      expect(terms(result)).toEqual([
        { n: 0, value: '10' },
        { n: 1, value: '20' },
        { n: 2, value: '30' },
        { n: 4, value: '-50' },
      ]);
    });

    it('serves a 206 b-file whole and reports the size from Content-Range', async () => {
      const body = bFileText(Array.from({ length: 300 }, (_, i) => String(i * i)));
      const { result } = await getTerms({ aNumber: 'A000045', limit: 1000 }, bFilePartial(body));
      expect(terms(result)).toHaveLength(300);
      expect(structured(result)).toMatchObject({
        source: 'bfile',
        lastAvailableIndex: 299,
        bFileSizeInBytes: body.length,
        bFileCut: false,
      });
    });

    it('marks a 206 b-file whose Content-Range total exceeds what was read as cut', async () => {
      const body = bFileText(Array.from({ length: 50 }, (_, i) => String(i)));
      const { result } = await getTerms(
        { aNumber: 'A000045' },
        bFilePartial(body, body.length + 429_385),
      );
      expect(structured(result)).toMatchObject({
        bFileCut: true,
        lastAvailableIndex: 49,
        bFileSizeInBytes: body.length + 429_385,
      });
      expect(structured(result).notice).toBe(
        `Only the first 1 MiB of the b-file was read; terms past n = 49 are at ${FIB_BFILE_URL}.`,
      );
    });

    it('pages through a 206 b-file with nextFromIndex from one upstream request', async () => {
      const body = bFileText(Array.from({ length: 25 }, (_, i) => String(i + 100)));
      const { service, calls } = serviceOver(bFilePartial(body));
      holder.service = service;

      const first = await runToolContract(oeisGetTerms, { aNumber: 'A45', limit: 10 });
      expect(ns(first)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(structured(first)).toMatchObject({
        nextFromIndex: 10,
        truncated: true,
        shown: 10,
        cap: 10,
      });
      const second = await runToolContract(oeisGetTerms, {
        aNumber: 'A45',
        limit: 10,
        fromIndex: 10,
      });
      expect(ns(second)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
      expect(structured(second)).toMatchObject({ nextFromIndex: 20, firstAvailableIndex: 0 });
      const third = await runToolContract(oeisGetTerms, {
        aNumber: 'A45',
        limit: 10,
        fromIndex: 20,
      });
      expect(ns(third)).toEqual([20, 21, 22, 23, 24]);
      expect(structured(third)).not.toHaveProperty('nextFromIndex');
      expect(structured(third)).toMatchObject({ truncated: false, shown: 5, cap: 10 });
      expect(calls).toHaveLength(1);
    });

    it('cuts a 200 b-file that ignores Range at 1 MiB and drops the partial last line', async () => {
      const { lines, text } = oversizedBFile();
      expect(text.length).toBeGreaterThan(ONE_MIB);
      const head = text.slice(0, ONE_MIB);
      const full = head.split('\n');
      full.pop();
      const lastFullN = full.length - 1;

      const { result } = await getTerms({ aNumber: 'A000045', limit: 1000 }, bFile(text));
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({
        source: 'bfile',
        bFileCut: true,
        firstAvailableIndex: 0,
        lastAvailableIndex: lastFullN,
        nextFromIndex: 1000,
        truncated: true,
        shown: 1000,
        cap: 1000,
      });
      expect(terms(result)).toHaveLength(1000);
      expect(terms(result)[999]).toEqual({
        n: 999,
        value: String(lines[999]?.split(' ')[1]).trim(),
      });
      expect(String(structured(result).notice)).toContain(
        `Only the first 1 MiB of the b-file was read; terms past n = ${lastFullN} are at ${FIB_BFILE_URL}.`,
      );
      expect(String(structured(result).notice)).toContain(
        'More terms follow; call again with fromIndex 1000.',
      );
    });

    it('reaches the last term read from a cut b-file and says nothing follows in this read', async () => {
      const { text } = oversizedBFile();
      const head = text.slice(0, ONE_MIB).split('\n');
      head.pop();
      const lastFullN = head.length - 1;
      const { result } = await getTerms(
        { aNumber: 'A000045', fromIndex: lastFullN - 1, limit: 1000 },
        bFile(text),
      );
      expect(ns(result)).toEqual([lastFullN - 1, lastFullN]);
      expect(structured(result)).toMatchObject({ bFileCut: true, truncated: false, shown: 2 });
      expect(structured(result)).not.toHaveProperty('nextFromIndex');
    });

    it('reports the size of a cut 200 when Content-Length is present', async () => {
      const { text } = oversizedBFile();
      const { result } = await getTerms(
        { aNumber: 'A000045' },
        bFile(text, { 'content-length': String(text.length) }),
      );
      expect(structured(result)).toMatchObject({ bFileCut: true, bFileSizeInBytes: text.length });
    });

    it('serves a repeated call from the cached b-file without a second request', async () => {
      const { service, calls } = serviceOver(bFile(fibonacciBFile));
      holder.service = service;
      await runToolContract(oeisGetTerms, { aNumber: 'A45' });
      const again = await runToolContract(oeisGetTerms, { aNumber: 'A45', fromIndex: 10 });
      expect(ns(again)).toEqual([10, 11, 12, 13, 14]);
      expect(calls).toHaveLength(1);
    });
  });

  describe('slicing', () => {
    const fifteen = () => bFile(fibonacciBFile);

    it('applies limit and offers nextFromIndex with a guidance notice', async () => {
      const { result } = await getTerms({ aNumber: 'A45', limit: 5 }, fifteen());
      expect(ns(result)).toEqual([0, 1, 2, 3, 4]);
      expect(structured(result)).toMatchObject({
        nextFromIndex: 5,
        truncated: true,
        shown: 5,
        cap: 5,
        firstAvailableIndex: 0,
        lastAvailableIndex: 14,
      });
      expect(structured(result).notice).toBe('More terms follow; call again with fromIndex 5.');
    });

    it('starts at fromIndex and runs to the end without nextFromIndex', async () => {
      const { result } = await getTerms({ aNumber: 'A45', fromIndex: 10 }, fifteen());
      expect(ns(result)).toEqual([10, 11, 12, 13, 14]);
      expect(structured(result)).toMatchObject({ truncated: false, shown: 5, cap: 100 });
      expect(structured(result)).not.toHaveProperty('nextFromIndex');
      expect(structured(result).notice).toBeUndefined();
    });

    it('has no nextFromIndex when limit exactly covers the remaining terms', async () => {
      const { result } = await getTerms({ aNumber: 'A45', fromIndex: 10, limit: 5 }, fifteen());
      expect(ns(result)).toEqual([10, 11, 12, 13, 14]);
      expect(structured(result)).toMatchObject({ truncated: false, shown: 5, cap: 5 });
      expect(structured(result)).not.toHaveProperty('nextFromIndex');
    });

    it('returns one term for limit 1 and points at the next', async () => {
      const { result } = await getTerms({ aNumber: 'A45', limit: 1, fromIndex: 3 }, fifteen());
      expect(terms(result)).toEqual([{ n: 3, value: '2' }]);
      expect(structured(result)).toMatchObject({ nextFromIndex: 4, shown: 1, cap: 1 });
    });

    it('starts at the first available index when fromIndex is below it', async () => {
      for (const fromIndex of [-5, 0]) {
        const { result } = await getTerms({ aNumber: 'A45', fromIndex, limit: 3 }, fifteen());
        expect(ns(result)).toEqual([0, 1, 2]);
        expect(structured(result).notice).toBe('More terms follow; call again with fromIndex 3.');
      }
    });

    it('lands on the next index a gappy b-file has at or after fromIndex', async () => {
      const body = ['0 1', '1 1', '2 2', '5 8', '6 13', ''].join('\n');
      const { result } = await getTerms({ aNumber: 'A45', fromIndex: 3 }, bFile(body));
      expect(ns(result)).toEqual([5, 6]);
      expect(structured(result)).toMatchObject({ firstAvailableIndex: 0, lastAvailableIndex: 6 });
    });

    it('returns an empty slice with the last available index when fromIndex is past the end', async () => {
      const { result } = await getTerms({ aNumber: 'A45', fromIndex: 99 }, fifteen());
      expect(result.isError).toBeUndefined();
      expect(terms(result)).toEqual([]);
      expect(structured(result)).toMatchObject({
        truncated: false,
        shown: 0,
        cap: 100,
        firstAvailableIndex: 0,
        lastAvailableIndex: 14,
      });
      expect(structured(result)).not.toHaveProperty('nextFromIndex');
      expect(structured(result).notice).toBe(
        'No terms at n ≥ 99 in what OEIS publishes for this entry; the last available index is 14.',
      );
      expect(textOf(result)).toContain('None in this slice.');
    });

    it('treats the last index itself as in range, not past it', async () => {
      const { result } = await getTerms({ aNumber: 'A45', fromIndex: 14 }, fifteen());
      expect(terms(result)).toEqual([{ n: 14, value: '377' }]);
      expect(structured(result).notice).toBeUndefined();
    });
  });

  describe('byte budget', () => {
    const BUDGET = 100_000;
    const wireBytes = (result: Result) =>
      new TextEncoder().encode(
        JSON.stringify(result.structuredContent) + JSON.stringify(result.content),
      ).length;
    const thousandDigitTerms = () =>
      bFile(bFileText(Array.from({ length: 300 }, (_, i) => `${i + 1}`.padEnd(1000, '7'))));

    it('stops a slice of large terms within 100,000 bytes and continues from the first term left out', async () => {
      const { result } = await getTerms({ aNumber: 'A45', limit: 1000 }, thousandDigitTerms());
      const shown = terms(result).length;
      expect(shown).toBeGreaterThan(1);
      expect(shown).toBeLessThan(100);
      expect(ns(result)).toEqual(Array.from({ length: shown }, (_, i) => i));
      expect(wireBytes(result)).toBeLessThanOrEqual(BUDGET);
      expect(structured(result)).toMatchObject({
        nextFromIndex: shown,
        truncated: true,
        shown,
        cap: 1000,
      });
      expect(structured(result).notice).toBe(
        `Stopped after ${shown} terms to stay within the 100,000-byte response budget; call again with fromIndex ${shown}.`,
      );

      const { result: rest } = await getTerms(
        { aNumber: 'A45', fromIndex: shown, limit: 1000 },
        thousandDigitTerms(),
      );
      expect(ns(rest)[0]).toBe(shown);
      expect(wireBytes(rest)).toBeLessThanOrEqual(BUDGET);
    });

    it('holds the budget with the longest notices, URL, and indices the schema allows', async () => {
      const base = Number.MAX_SAFE_INTEGER - 2000;
      // Terms of ~260 bytes each fill the slice to within one term of the budget's term share.
      const body = bFileText(
        Array.from({ length: 500 }, () => `-${'9'.repeat(99)}`),
        base,
      );
      const { result } = await getTerms(
        { aNumber: 'A1234567', limit: 1000 },
        bFilePartial(body, Number.MAX_SAFE_INTEGER),
      );
      expect(structured(result)).toMatchObject({
        bFileCut: true,
        bFileSizeInBytes: Number.MAX_SAFE_INTEGER,
        bFileUrl: 'https://oeis.org/A1234567/b1234567.txt',
        truncated: true,
      });
      expect(structured(result).notice).toMatch(/^Only the first 1 MiB .* Stopped after \d+ terms/);
      expect(wireBytes(result)).toBeGreaterThan(BUDGET - 5_000);
      expect(wireBytes(result)).toBeLessThanOrEqual(BUDGET);
    });

    it('holds the budget at the default limit too', async () => {
      const { result } = await getTerms({ aNumber: 'A45' }, thousandDigitTerms());
      expect(terms(result).length).toBeLessThan(100);
      expect(wireBytes(result)).toBeLessThanOrEqual(BUDGET);
    });

    it('returns a single term larger than the budget on its own and points at the next', async () => {
      const huge = '9'.repeat(120_000);
      const { result } = await getTerms(
        { aNumber: 'A45', fromIndex: 1 },
        bFile(bFileText(['1', huge, '2'])),
      );
      expect(terms(result)).toEqual([{ n: 1, value: huge }]);
      expect(structured(result)).toMatchObject({ nextFromIndex: 2, truncated: true, shown: 1 });
      expect(structured(result).notice).toBe(
        'Stopped after 1 term to stay within the 100,000-byte response budget; call again with fromIndex 2.',
      );
    });

    it('leaves a slice of small terms to limit alone', async () => {
      const small = bFile(bFileText(Array.from({ length: 1200 }, (_, i) => String(i * 7))));
      const { result } = await getTerms({ aNumber: 'A45', limit: 1000 }, small);
      expect(terms(result)).toHaveLength(1000);
      expect(structured(result).notice).toBe('More terms follow; call again with fromIndex 1000.');
    });
  });

  describe('data-line fallback', () => {
    it('falls back to the record when the b-file answers 404, indexing from firstIndex', async () => {
      const { calls, result } = await getTerms(
        { aNumber: 'A388000' },
        missing(),
        record(minimalRecordJson),
      );
      expect(result.isError).toBeUndefined();
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        '/A388000/b388000.txt',
        '/A388000',
      ]);
      expect(calls[0]?.headers.get('range')).toBe(`bytes=0-${ONE_MIB - 1}`);
      expect(calls[1]?.headers.get('range')).toBeNull();
      expect(structured(result)).toMatchObject({
        aNumber: 'A388000',
        source: 'data',
        terms: [
          { n: 1, value: '1' },
          { n: 2, value: '2' },
          { n: 3, value: '3' },
        ],
        firstAvailableIndex: 1,
        lastAvailableIndex: 3,
        bFileCut: false,
        url: 'https://oeis.org/A388000',
      });
      expect(structured(result)).not.toHaveProperty('bFileUrl');
      expect(structured(result)).not.toHaveProperty('bFileSizeInBytes');
      expect(structured(result).notice).toBe(
        'This entry has no b-file; these are the data-line terms only.',
      );
    });

    it('treats a b-file OEIS synthesized from the data line as no b-file', async () => {
      const { calls, result } = await getTerms(
        { aNumber: 'A388000' },
        bFile(synthesizedBFile('A388000', ['1', '2', '3'], 1)),
        record(minimalRecordJson),
      );
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        '/A388000/b388000.txt',
        '/A388000',
      ]);
      expect(structured(result)).toMatchObject({
        source: 'data',
        firstAvailableIndex: 1,
        lastAvailableIndex: 3,
        bFileCut: false,
      });
      expect(structured(result)).not.toHaveProperty('bFileUrl');
      expect(structured(result)).not.toHaveProperty('bFileSizeInBytes');
      expect(structured(result).notice).toBe(
        'This entry has no b-file; these are the data-line terms only.',
      );
    });

    it('answers the same for an entry without a b-file whether or not its record is cached', async () => {
      const { service, calls } = serviceOver(
        bFile(synthesizedBFile('A388000', ['1', '2', '3'], 1)),
        record(minimalRecordJson),
      );
      holder.service = service;
      const cold = await runToolContract(oeisGetTerms, { aNumber: 'A388000' });
      await service.getRecord('A388000', createMockContext());
      const warm = await runToolContract(oeisGetTerms, { aNumber: 'A388000' });
      expect(structured(cold)).toMatchObject({ source: 'data' });
      expect(structured(warm)).toEqual(structured(cold));
      expect(calls).toHaveLength(2);
    });

    it('slices the data-line terms like b-file terms', async () => {
      const raw = recordWith({ data: '5,6,7,8,9,10', offset: '3,1' }, minimalRecordJson);
      const { result } = await getTerms(
        { aNumber: 'A388000', fromIndex: 4, limit: 2 },
        missing(),
        record(raw),
      );
      expect(terms(result)).toEqual([
        { n: 4, value: '6' },
        { n: 5, value: '7' },
      ]);
      expect(structured(result)).toMatchObject({
        source: 'data',
        nextFromIndex: 6,
        truncated: true,
        firstAvailableIndex: 3,
        lastAvailableIndex: 8,
      });
      expect(structured(result).notice).toBe(
        'This entry has no b-file; these are the data-line terms only. More terms follow; call again with fromIndex 6.',
      );
    });

    it('reports a start past the data line, with both the past-end and the no-b-file notices', async () => {
      const { result } = await getTerms(
        { aNumber: 'A388000', fromIndex: 50 },
        missing(),
        record(minimalRecordJson),
      );
      expect(terms(result)).toEqual([]);
      expect(structured(result).notice).toBe(
        'No terms at n ≥ 50 in what OEIS publishes for this entry; the last available index is 3. This entry has no b-file; these are the data-line terms only.',
      );
    });

    it('skips the b-file request when a cached record names no b-file', async () => {
      const { service, calls } = serviceOver(record(minimalRecordJson));
      holder.service = service;
      await service.getRecord('A388000', createMockContext());
      expect(calls).toHaveLength(1);

      const result = await runToolContract(oeisGetTerms, { aNumber: 'A388000' });
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(structured(result)).toMatchObject({
        source: 'data',
        firstAvailableIndex: 1,
        lastAvailableIndex: 3,
      });
      expect(structured(result).notice).toBe(
        'This entry has no b-file; these are the data-line terms only.',
      );
    });

    it('requests the b-file again once a cached record that named none is past its 24 h', async () => {
      const clock = { now: 1_800_000_000_000 };
      const { calls, fetch } = scriptedFetch(
        record(minimalRecordJson),
        bFile(bFileText(['7', '8', '9', '10'], 1)),
      );
      const service = new OeisService({ fetch, now: () => clock.now, pacer: immediatePacer() });
      holder.service = service;
      await service.getRecord('A388000', createMockContext());
      clock.now += 24 * 60 * 60 * 1000;

      const result = await runToolContract(oeisGetTerms, { aNumber: 'A388000' });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        '/A388000',
        '/A388000/b388000.txt',
      ]);
      expect(structured(result)).toMatchObject({ source: 'bfile', lastAvailableIndex: 4 });
    });

    it('requests the b-file when a cached record links one, and uses it', async () => {
      const { service, calls } = serviceOver(record(), bFile(fibonacciBFile));
      holder.service = service;
      await service.getRecord('A000045', createMockContext());
      const result = await runToolContract(oeisGetTerms, { aNumber: 'A000045' });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        '/A000045',
        '/A000045/b000045.txt',
      ]);
      expect(structured(result)).toMatchObject({ source: 'bfile', lastAvailableIndex: 14 });
    });

    it('falls back to the cached record without refetching it when its b-file answers 404', async () => {
      const { service, calls } = serviceOver(record(), missing());
      holder.service = service;
      await service.getRecord('A000045', createMockContext());
      const result = await runToolContract(oeisGetTerms, { aNumber: 'A000045', limit: 4 });
      expect(calls).toHaveLength(2);
      expect(structured(result)).toMatchObject({
        source: 'data',
        firstAvailableIndex: 0,
        lastAvailableIndex: 14,
        nextFromIndex: 4,
      });
      expect(ns(result)).toEqual([0, 1, 2, 3]);
    });

    it('answers sequence_not_found when both the b-file and the record answer 404', async () => {
      const { calls, result } = await getTerms({ aNumber: 'A999999' }, missing(), missing());
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
      expect(calls).toHaveLength(2);
    });
  });

  describe('entries with no published terms', () => {
    it('reports an empty data line without first or last index', async () => {
      const raw = recordWith({ data: '', keyword: 'allocated' }, minimalRecordJson);
      const { result } = await getTerms({ aNumber: 'A388000' }, missing(), record(raw));
      expect(result.isError).toBeUndefined();
      expect(terms(result)).toEqual([]);
      expect(structured(result)).not.toHaveProperty('firstAvailableIndex');
      expect(structured(result)).not.toHaveProperty('lastAvailableIndex');
      expect(structured(result)).not.toHaveProperty('nextFromIndex');
      expect(structured(result)).toMatchObject({ source: 'data', truncated: false, shown: 0 });
      expect(structured(result).notice).toBe(
        'OEIS publishes no terms for this entry. This entry has no b-file; these are the data-line terms only.',
      );
    });

    it('reads a reserved A-number: its marker-only b-file is no b-file, and its record has no offset', async () => {
      const { calls, result } = await getTerms(
        { aNumber: 'A397217' },
        bFile(synthesizedBFile('A397217', [])),
        record(reservedRecordJson),
      );
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(2);
      expect(structured(result)).toMatchObject({
        source: 'data',
        terms: [],
        bFileCut: false,
        truncated: false,
        shown: 0,
      });
      expect(structured(result)).not.toHaveProperty('bFileUrl');
      expect(structured(result)).not.toHaveProperty('bFileSizeInBytes');
      expect(structured(result)).not.toHaveProperty('firstAvailableIndex');
      expect(structured(result).notice).toBe(
        'OEIS publishes no terms for this entry. This entry has no b-file; these are the data-line terms only.',
      );
    });

    it('does not add the past-the-end notice when there are no terms at all', async () => {
      const raw = recordWith({ data: '' }, minimalRecordJson);
      const { result } = await getTerms(
        { aNumber: 'A388000', fromIndex: 5 },
        missing(),
        record(raw),
      );
      expect(String(structured(result).notice)).not.toContain('No terms at n');
    });

    it('reports a b-file that holds only comments as source bfile with no terms', async () => {
      const { result } = await getTerms(
        { aNumber: 'A000045' },
        bFile('# Table of n, a(n)\n# nothing yet\n'),
      );
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({
        source: 'bfile',
        terms: [],
        bFileUrl: FIB_BFILE_URL,
        truncated: false,
        shown: 0,
      });
      expect(structured(result)).not.toHaveProperty('firstAvailableIndex');
      expect(structured(result).notice).toBe('OEIS publishes no terms for this entry.');
    });
  });

  describe('required enrichment', () => {
    it('carries truncated, shown, and cap on the zero-result page', async () => {
      const raw = recordWith({ data: '' }, minimalRecordJson);
      const { result } = await getTerms({ aNumber: 'A388000', limit: 25 }, missing(), record(raw));
      expect(result.isError).toBeUndefined();
      expect(structured(result)).toMatchObject({ terms: [], truncated: false, shown: 0, cap: 25 });
      expect(structured(result).notice).toEqual(expect.any(String));
      expect(textOf(result)).toContain('**truncated:** false');
      expect(textOf(result)).toContain('**shown:** 0');
      expect(textOf(result)).toContain('**cap:** 25');
    });

    it('carries them on the zero-result page of an empty b-file and of a past-the-end start', async () => {
      const emptyBFile = await getTerms({ aNumber: 'A000045' }, bFile('# none\n'));
      expect(structured(emptyBFile.result)).toMatchObject({
        truncated: false,
        shown: 0,
        cap: 100,
      });
      const pastEnd = await getTerms({ aNumber: 'A000045', fromIndex: 500 }, bFile(fibonacciBFile));
      expect(structured(pastEnd.result)).toMatchObject({ truncated: false, shown: 0, cap: 100 });
    });

    it('carries them on an under-cap page', async () => {
      const { result } = await getTerms({ aNumber: 'A000045' }, bFile(fibonacciBFile));
      expect(terms(result)).toHaveLength(15);
      expect(structured(result)).toMatchObject({ truncated: false, shown: 15, cap: 100 });
      expect(structured(result).notice).toBeUndefined();
    });

    it('carries them on a data-line page under the cap', async () => {
      const { result } = await getTerms(
        { aNumber: 'A388000', limit: 7 },
        missing(),
        record(minimalRecordJson),
      );
      expect(structured(result)).toMatchObject({ truncated: false, shown: 3, cap: 7 });
    });

    it('carries them, with cap equal to limit, on a full page', async () => {
      const { result } = await getTerms({ aNumber: 'A000045', limit: 15 }, bFile(fibonacciBFile));
      expect(structured(result)).toMatchObject({ truncated: false, shown: 15, cap: 15 });
    });

    it('renders the enrichment block in content[]', async () => {
      const { result } = await getTerms({ aNumber: 'A000045', limit: 5 }, bFile(fibonacciBFile));
      const text = textOf(result);
      expect(text).toContain('**truncated:** true');
      expect(text).toContain('**shown:** 5');
      expect(text).toContain('**cap:** 5');
      expect(text).toContain('More terms follow; call again with fromIndex 5.');
    });
  });

  describe('upstream failures', () => {
    it('does not fall back to the data line on a b-file edge 403', async () => {
      const { calls, result } = await getTerms(
        { aNumber: 'A000045' },
        res('<html>Attention Required</html>', { status: 403 }),
        record(),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_refused', retryable: false },
      });
      expect(calls).toHaveLength(1);
    });

    it('does not fall back on a b-file 429 and carries retryAfter', async () => {
      const { calls, result } = await getTerms(
        { aNumber: 'A000045' },
        res('slow down', { status: 429, headers: { 'retry-after': '120' } }),
        record(),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { retryAfter: '120' },
      });
      expect(calls).toHaveLength(1);
    });

    it('does not follow a redirect on the b-file path', async () => {
      const { calls, result } = await getTerms(
        { aNumber: 'A000045' },
        res(null, { status: 301, headers: { location: 'https://oeis.org/A000045' } }),
        record(),
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
        const result = await withBackoff(runToolContract(oeisGetTerms, { aNumber: 'A000045' }));
        return { calls, result };
      };

      it('fails on a b-file 5xx after retrying, without trying the record', async () => {
        const { calls, result } = await run([res('oops', { status: 502 })]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { retryAttempts: 3 },
        });
        expect(calls).toHaveLength(3);
        expect(calls.every((call) => call.url === FIB_BFILE_URL)).toBe(true);
      });

      it('recovers when a b-file 503 is followed by the file', async () => {
        const { calls, result } = await run([res('oops', { status: 503 }), bFile(fibonacciBFile)]);
        expect(result.isError).toBeUndefined();
        expect(structured(result)).toMatchObject({ source: 'bfile', shown: 15 });
        expect(calls).toHaveLength(2);
      });

      it('reports an HTML maintenance page in place of a b-file as retryable upstream_unparseable', async () => {
        const { calls, result } = await run([bFile(htmlMaintenanceBody)]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unparseable', retryAttempts: 3 },
        });
        expect(calls).toHaveLength(3);
      });

      it('fails when the record fetch after a b-file 404 hits a 5xx', async () => {
        const { calls, result } = await run([missing(), res('oops', { status: 500 })]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { retryAttempts: 3 },
        });
        expect(calls).toHaveLength(4);
      });

      it('reports a malformed record body after a b-file 404 as upstream_unparseable', async () => {
        const { result } = await run([missing(), res('{"number": 45, "name":', { status: 200 })]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unparseable' },
        });
      });

      it('reports a record missing required fields as non-retryable upstream_unparseable', async () => {
        const { calls, result } = await run([
          missing(),
          res(JSON.stringify({ number: 45, name: 'x' }), { status: 200 }),
        ]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unparseable', retryable: false },
        });
        expect(calls).toHaveLength(2);
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
        oeisGetTerms,
        { aNumber: 'A000045' },
        { context: { signal: controller.signal } },
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    });

    describe('pacer_shed', () => {
      const withShedService = async (steps: ReturnType<typeof res>[], run: () => Promise<void>) => {
        const pacer = createPacer({
          name: 'oeis-terms-tool-test',
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

      it('sheds a queued b-file request through the contract: RateLimited, retryable, with recovery', async () => {
        const calls = await withShedService([bFile(fibonacciBFile)], async () => {
          const first = await runToolContract(oeisGetTerms, { aNumber: 'A000045' });
          expect(first.isError).toBeUndefined();
          const shed = await runToolContract(oeisGetTerms, { aNumber: 'A000108' });
          expect(shed.isError).toBe(true);
          expect(errorOf(shed)).toMatchObject({
            code: JsonRpcErrorCode.RateLimited,
            data: {
              reason: 'pacer_shed',
              retryAfter: expect.anything(),
              recovery: { hint: expect.stringContaining('oeis_get_terms again') },
            },
          });
          expect(textOf(shed)).toContain('reason pacer_shed');
        });
        expect(calls).toHaveLength(1);
      });

      it('fails the call, not the fallback, when the record fetch after a b-file 404 is shed', async () => {
        const calls = await withShedService([missing()], async () => {
          const result = await runToolContract(oeisGetTerms, { aNumber: 'A000045' });
          expect(result.isError).toBe(true);
          expect(errorOf(result)).toMatchObject({
            code: JsonRpcErrorCode.RateLimited,
            data: { reason: 'pacer_shed' },
          });
        });
        expect(calls).toHaveLength(1);
      });
    });

    it('declares sequence_not_found, pacer_shed, and upstream_rate_limited', () => {
      expect(oeisGetTerms.errors).toEqual([
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
          recovery: expect.stringContaining('oeis_get_terms again'),
        }),
      ]);
    });
  });

  describe('format', () => {
    it('carries every output field of a b-file result', async () => {
      const { result } = await getTerms(
        { aNumber: 'A000045', limit: 4 },
        bFile(fibonacciBFile, { 'content-length': String(fibonacciBFile.length) }),
      );
      const text = textOf(result);
      expect(text).toContain('# A000045 terms');
      expect(text).toContain('**Source:** bfile');
      expect(text).toContain('**First available index:** 0');
      expect(text).toContain('**Last available index:** 14');
      expect(text).toContain(`**b-file:** ${FIB_BFILE_URL}`);
      expect(text).toContain(`**b-file size:** ${fibonacciBFile.length} bytes`);
      expect(text).toContain('**b-file cut at 1 MiB:** no');
      expect(text).toContain('**URL:** https://oeis.org/A000045');
      for (const term of terms(result)) expect(text).toContain(`a(${term.n}) = ${term.value}`);
      expect(text).toContain('**Next slice:** call again with fromIndex 4.');
    });

    it('says a cut b-file continues at its URL', async () => {
      const { result } = await getTerms(
        { aNumber: 'A000045' },
        bFilePartial(fibonacciBFile, fibonacciBFile.length + 10_000),
      );
      expect(textOf(result)).toContain(
        '**b-file cut at 1 MiB:** yes, later terms exist at the b-file URL',
      );
    });

    it('renders a data-line result without b-file lines', async () => {
      const { result } = await getTerms(
        { aNumber: 'A388000' },
        missing(),
        record(minimalRecordJson),
      );
      const text = textOf(result);
      expect(text).toContain('**Source:** data');
      expect(text).not.toContain('**b-file:**');
      expect(text).not.toContain('**b-file size:**');
      expect(text).not.toContain('Next slice');
      expect(text).toContain('a(1) = 1');
      expect(text).toContain('a(3) = 3');
    });

    it('renders an entry with no terms as none, with the guidance from the enrichment block', async () => {
      const raw = recordWith({ data: '' }, minimalRecordJson);
      const { result } = await getTerms({ aNumber: 'A388000' }, missing(), record(raw));
      const text = textOf(result);
      expect(text).toContain('**First available index:** none (OEIS publishes no terms)');
      expect(text).not.toContain('**Last available index:**');
      expect(text).toContain('None in this slice.');
      expect(text).toContain('OEIS publishes no terms for this entry.');
    });

    it('flattens CR/LF in every term value of a hand-built output', () => {
      const blocks = oeisGetTerms.format?.({
        aNumber: 'A000001',
        source: 'bfile',
        terms: [
          { n: 0, value: '1\n## heading' },
          { n: 1, value: '2\r\n3' },
        ],
        firstAvailableIndex: 0,
        lastAvailableIndex: 1,
        bFileUrl: FIB_BFILE_URL,
        bFileCut: false,
        url: 'https://oeis.org/A000001',
      });
      const text = blocksText(blocks);
      expect(text).toContain('a(0) = 1 ## heading');
      expect(text).toContain('a(1) = 2 3');
      expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
        '# A000001 terms',
        '## Terms',
      ]);
    });

    it('renders nextFromIndex only when present', () => {
      const base = {
        aNumber: 'A000001',
        source: 'data' as const,
        terms: [],
        bFileCut: false,
        url: 'https://oeis.org/A000001',
      };
      expect(blocksText(oeisGetTerms.format?.(base))).not.toContain('Next slice');
      expect(blocksText(oeisGetTerms.format?.({ ...base, nextFromIndex: 40 }))).toContain(
        '**Next slice:** call again with fromIndex 40.',
      );
    });
  });
});
