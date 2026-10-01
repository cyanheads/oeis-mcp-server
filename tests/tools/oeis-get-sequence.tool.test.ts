/**
 * @fileoverview Tests for oeis_get_sequence through the tool contract over a real OeisService with
 * a scripted fetch: A-number and sections input, the sequence_not_found and pacer_shed contracts,
 * upstream failure classes, the lifecycle notice, section selection, the 24,000-byte outline,
 * sparse records, link-scheme filtering, and `format()` parity with `structuredContent`.
 * @module tests/tools/oeis-get-sequence.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSequenceOutput,
  oeisGetSequence,
} from '@/mcp-server/tools/definitions/oeis-get-sequence.tool.js';
import { normalizeRecord } from '@/services/oeis/normalize-record.js';
import { OeisService } from '@/services/oeis/oeis-service.js';
import { SECTION_NAMES } from '@/services/oeis/types.js';
import {
  fibonacciRecordJson,
  htmlMaintenanceBody,
  minimalRecordJson,
  type RawRecord,
  recordBody,
  recordWith,
} from '../fixtures/oeis-upstream.js';
import { res, scriptedFetch } from '../fixtures/scripted-fetch.js';
import { blocksText, queryOf, serviceOver, withBackoff } from '../fixtures/tool-service.js';

const holder = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock('@/services/oeis/oeis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/oeis/oeis-service.js')>()),
  getOeisService: () => holder.service,
}));

const ok = (record: RawRecord = fibonacciRecordJson) =>
  res(recordBody(record), { status: 200, headers: { 'content-type': 'application/json' } });

type Result = Awaited<ReturnType<typeof runToolContract>>;
type Input = Parameters<typeof oeisGetSequence.handler>[0];

/** Runs the tool over a scripted upstream; returns the contract result and the captured calls. */
async function fetchSequence(
  input: Record<string, unknown>,
  ...steps: ReturnType<typeof res>[]
): Promise<{ calls: ReturnType<typeof serviceOver>['calls']; result: Result }> {
  const { calls, service } = serviceOver(...steps);
  holder.service = service;
  const result = await runToolContract(oeisGetSequence, input as never);
  return { calls, result };
}

const structured = (result: Result) => result.structuredContent as Record<string, unknown>;
const textOf = (result: Result) =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
const errorOf = (result: Result) =>
  structured(result).error as { code: number; data: Record<string, unknown>; message: string };

/** The record with `n` characters of padding in one comment, so sizing is exact. */
const withComment = (n: number, base: RawRecord = minimalRecordJson) =>
  recordWith({ comment: ['x'.repeat(n)] }, base);

/** JSON length of the eight sections as the outline budget measures them. */
function sectionsLength(raw: RawRecord): number {
  const { comments, formulas, examples, programs, references, links, crossReferences, extensions } =
    normalizeRecord(raw);
  return JSON.stringify({
    comments,
    formulas,
    examples,
    programs,
    references,
    links,
    crossReferences,
    extensions,
  }).length;
}

afterEach(() => {
  holder.service = undefined;
});

describe('oeis_get_sequence', () => {
  describe('input validation', () => {
    it.each([
      ['A000045', 'A000045'],
      ['a000045', 'A000045'],
      ['A45', 'A000045'],
      ['45', 'A000045'],
      ['  A45  ', 'A000045'],
      ['A0000045', 'A000045'],
      ['A1234567', 'A1234567'],
      ['https://oeis.org/A000045', 'A000045'],
      ['http://www.oeis.org/a45?fmt=json', 'A000045'],
      ['oeis.org/A000045/b000045.txt', 'A000045'],
      ['https://oeis.org/A000045#formula', 'A000045'],
    ])('normalizes %j to %s before the request', async (given, canonical) => {
      const { calls, result } = await fetchSequence({ aNumber: given }, ok());
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]?.url ?? '').pathname).toBe(`/${canonical}`);
      expect(queryOf(calls[0]).get('fmt')).toBe('json');
    });

    it.each([
      ['a legacy M-number', 'M1459'],
      ['a legacy N-number', 'N0256'],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['words', 'fibonacci'],
      ['too many digits', 'A12345678'],
      ['a negative number', '-45'],
      ['a decimal', '45.5'],
      ['a different host', 'https://example.org/A000045'],
    ])('rejects %s with invalid_arguments and makes no request', async (_label, aNumber) => {
      const { calls, result } = await fetchSequence({ aNumber }, ok());
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(calls).toHaveLength(0);
    });

    it('rejects a missing aNumber and a null one without a request', async () => {
      for (const input of [{}, { aNumber: null }]) {
        const { calls, result } = await fetchSequence(input, ok());
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(calls).toHaveLength(0);
      }
    });

    it('rejects a number at the schema (the pre-parse never reads one as an A-number)', () => {
      expect(oeisGetSequence.input.safeParse({ aNumber: 45 }).success).toBe(false);
    });

    it('reads blank and empty sections as unset (form clients send "")', () => {
      for (const sections of ['', '   ', undefined, []]) {
        const parsed = oeisGetSequence.input.parse({ aNumber: 'A45', sections });
        expect(parsed.sections === undefined || parsed.sections.length === 0).toBe(true);
      }
    });

    it('rejects an unknown section name and a non-array sections value', async () => {
      for (const sections of [['formula'], ['Formulas'], ['formulas', 'bogus'], 'formulas', 7]) {
        const { calls, result } = await fetchSequence({ aNumber: 'A45', sections }, ok());
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(calls).toHaveLength(0);
      }
    });

    it('accepts every declared section name', () => {
      const parsed = oeisGetSequence.input.parse({ aNumber: 'A45', sections: [...SECTION_NAMES] });
      expect(parsed.sections).toEqual([...SECTION_NAMES]);
    });
  });

  describe('full entry', () => {
    it('returns the core fields, terms as strings, and all eight sections', async () => {
      const { result } = await fetchSequence({ aNumber: 'A000045' }, ok());
      expect(result.isError).toBeUndefined();
      const out = structured(result);
      expect(out).toMatchObject({
        kind: 'full',
        aNumber: 'A000045',
        offset: '0,4',
        firstIndex: 0,
        author: '_N. J. A. Sloane_, Apr 30 1991',
        legacyIds: ['M0692', 'N0256'],
        referenceCount: 6162,
        revision: 902,
        url: 'https://oeis.org/A000045',
        bFileUrl: 'https://oeis.org/A000045/b000045.txt',
      });
      expect(out.terms).toEqual([
        '0',
        '1',
        '1',
        '2',
        '3',
        '5',
        '8',
        '13',
        '21',
        '34',
        '55',
        '89',
        '144',
        '233',
        '377',
      ]);
      for (const name of SECTION_NAMES) expect(out[name]).toBeInstanceOf(Array);
      expect(out.sections).toBeUndefined();
      expect(out.outlineNotice).toBeUndefined();
      expect(out.notice).toBeUndefined();
      expect(out).toEqual(expect.schemaMatching(oeisGetSequence.output.extend({})));
    });

    it('keeps terms beyond 2^53 as exact decimal strings', async () => {
      const big = ['9007199254740993', '-9007199254740993', '123456789012345678901234567890'];
      const { result } = await fetchSequence(
        { aNumber: 'A388000' },
        ok(recordWith({ data: big.join(',') })),
      );
      expect(structured(result).terms).toEqual(big);
      expect(textOf(result)).toContain(big.join(', '));
    });

    it('requests the seven-digit path for a seven-digit A-number', async () => {
      const { calls, result } = await fetchSequence(
        { aNumber: 'A1234567' },
        ok(recordWith({ number: 1234567 })),
      );
      expect(new URL(calls[0]?.url ?? '').pathname).toBe('/A1234567');
      expect(structured(result).aNumber).toBe('A1234567');
    });

    it('serves a repeat request from the service cache without a second fetch', async () => {
      const { calls, service } = serviceOver(ok());
      holder.service = service;
      await runToolContract(oeisGetSequence, { aNumber: 'A45' });
      const again = await runToolContract(oeisGetSequence, { aNumber: 'a000045' });
      expect(again.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
    });
  });

  describe('sparse record', () => {
    it('omits absent optional fields and returns empty sections, never invented values', async () => {
      const { result } = await fetchSequence({ aNumber: 'A388000' }, ok(minimalRecordJson));
      const out = structured(result);
      expect(out).toMatchObject({ kind: 'full', aNumber: 'A388000', terms: ['1', '2', '3'] });
      expect(out.author).toBeUndefined();
      expect(out.legacyIds).toBeUndefined();
      expect(out.bFileUrl).toBeUndefined();
      for (const name of SECTION_NAMES) expect(out[name]).toEqual([]);
    });

    it('renders every empty section as None. and drops the optional labels', async () => {
      const { result } = await fetchSequence({ aNumber: 'A388000' }, ok(minimalRecordJson));
      const text = textOf(result);
      expect(text.match(/\nNone\./g)).toHaveLength(SECTION_NAMES.length);
      expect(text).not.toContain('**Author:**');
      expect(text).not.toContain('**Legacy IDs:**');
      expect(text).not.toContain('**b-file:**');
    });

    it('reports an entry with no data line as "none listed"', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A388000' },
        ok(recordWith({ data: '', keyword: '' }, minimalRecordJson)),
      );
      expect(structured(result)).toMatchObject({ terms: [], keywords: [] });
      expect(textOf(result)).toContain('**Terms:** none listed');
      expect(textOf(result)).toContain('**Keywords:** none');
    });
  });

  describe('sections selection', () => {
    it('returns the core plus exactly the selected sections', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A45', sections: ['formulas', 'programs'] },
        ok(),
      );
      const out = structured(result);
      expect(out.kind).toBe('full');
      expect(out.formulas).toEqual([
        'G.f.: x/(1 - x - x^2).',
        'a(n) = a(n-1) + a(n-2) for n >= 2.',
      ]);
      expect(out.programs).toHaveLength(4);
      for (const name of SECTION_NAMES.filter((s) => s !== 'formulas' && s !== 'programs')) {
        expect(out, name).not.toHaveProperty(name);
      }
      expect(out.terms).toBeInstanceOf(Array);
      const text = textOf(result);
      expect(text).toContain('## Formulas');
      expect(text).toContain('## Programs');
      expect(text).not.toContain('## Comments');
    });

    it('treats [] and "" like an omitted selection', async () => {
      for (const sections of [[], '']) {
        const { result } = await fetchSequence({ aNumber: 'A45', sections }, ok());
        for (const name of SECTION_NAMES) expect(structured(result)[name]).toBeInstanceOf(Array);
      }
    });

    it('returns a selected section that is empty as [] and renders None.', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A388000', sections: ['comments'] },
        ok(minimalRecordJson),
      );
      expect(structured(result).comments).toEqual([]);
      expect(structured(result)).not.toHaveProperty('formulas');
      expect(textOf(result)).toContain('## Comments\n\nNone.');
    });

    it('lists a repeated name once', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A45', sections: ['formulas', 'formulas'] },
        ok(),
      );
      expect(Object.keys(structured(result)).filter((k) => k === 'formulas')).toHaveLength(1);
      expect(textOf(result).match(/## Formulas/g)).toHaveLength(1);
    });

    it('returns a selection whole however large it is, never an outline', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A388000', sections: ['comments'] },
        ok(withComment(60_000)),
      );
      expect(structured(result).kind).toBe('full');
      expect((structured(result).comments as string[])[0]).toHaveLength(60_000);
      expect(structured(result).sections).toBeUndefined();
    });
  });

  describe('outline past the 24,000-byte budget', () => {
    it('returns the core fields and a largest-first section outline instead of the sections', async () => {
      const raw = recordWith({
        comment: ['c'.repeat(15_000)],
        formula: ['f'.repeat(9_000)],
        example: ['e'.repeat(2_000)],
      });
      const { result } = await fetchSequence({ aNumber: 'A45' }, ok(raw));
      expect(result.isError).toBeUndefined();
      const out = structured(result);
      expect(out.kind).toBe('outline');
      expect(out).toMatchObject({ aNumber: 'A000045', offset: '0,4', firstIndex: 0 });
      for (const name of SECTION_NAMES) expect(out, name).not.toHaveProperty(name);
      const sections = out.sections as { bytes: number; name: string }[];
      expect(sections.map((s) => s.name).slice(0, 3)).toEqual(['comments', 'formulas', 'examples']);
      expect(sections.map((s) => s.name).sort()).toEqual([...SECTION_NAMES].sort());
      expect(sections.map((s) => s.bytes)).toEqual(
        [...sections.map((s) => s.bytes)].sort((a, b) => b - a),
      );
      expect(out.outlineNotice).toEqual(expect.stringContaining('sections:['));
      expect(out).toEqual(expect.schemaMatching(oeisGetSequence.output));
    });

    it('renders the core fields and the outline in content[], with every section name', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A45' },
        ok(withComment(30_000, fibonacciRecordJson)),
      );
      const text = textOf(result);
      expect(text).toContain('**Kind:** outline');
      expect(text).toContain('# A000045:');
      expect(text).toContain('sections available');
      for (const name of SECTION_NAMES) expect(text).toContain(`\`${name}\``);
      expect(text).toContain((structured(result).outlineNotice as string).slice(0, 40));
      expect(text).not.toContain('## Comments');
    });

    it('keeps the entry whole at exactly the budget and outlines one character past it', async () => {
      const base = sectionsLength(withComment(0));
      const atBudget = withComment(24_000 - base);
      expect(sectionsLength(atBudget)).toBe(24_000);
      const full = await fetchSequence({ aNumber: 'A388000' }, ok(atBudget));
      expect(structured(full.result).kind).toBe('full');

      const over = withComment(24_000 - base + 1);
      expect(sectionsLength(over)).toBe(24_001);
      const outline = await fetchSequence({ aNumber: 'A388000' }, ok(over));
      expect(structured(outline.result).kind).toBe('outline');
    });

    it('lets the caller pick sections that fit, after seeing the outline', async () => {
      const raw = recordWith({ comment: ['c'.repeat(30_000)] });
      const { service } = serviceOver(ok(raw));
      holder.service = service;
      const first = await runToolContract(oeisGetSequence, { aNumber: 'A45' });
      expect(structured(first).kind).toBe('outline');
      const second = await runToolContract(oeisGetSequence, {
        aNumber: 'A45',
        sections: ['formulas'],
      });
      expect(structured(second).kind).toBe('full');
      expect(structured(second).formulas).toHaveLength(2);
      expect(structured(second).sections).toBeUndefined();
    });

    it('buildSequenceOutput with outline: false returns every section whatever the size', () => {
      const record = normalizeRecord(withComment(40_000, fibonacciRecordJson));
      const out = buildSequenceOutput(record, { outline: false });
      expect(out.kind).toBe('full');
      expect(out.comments?.[0]).toHaveLength(40_000);
      expect(buildSequenceOutput(record, { outline: true }).kind).toBe('outline');
    });
  });

  describe('lifecycle notice', () => {
    const notice = async (keyword: string) => {
      const { result } = await fetchSequence(
        { aNumber: 'A000001' },
        ok(recordWith({ keyword, name: 'Reserved.' }, minimalRecordJson)),
      );
      expect(result.isError).toBeUndefined();
      return { result, notice: structured(result).notice as string | undefined };
    };

    it('points a dead entry at the replacement named in its name', async () => {
      const { notice: text, result } = await notice('dead');
      expect(text).toContain('withdrawn');
      expect(text).toContain('keyword dead');
      expect(textOf(result)).toContain(text as string);
    });

    it.each(['allocated', 'recycled'])(
      'explains a %s A-number has no published sequence',
      async (keyword) => {
        const { notice: text } = await notice(`${keyword},nonn`);
        expect(text).toContain('reserved or recycled');
      },
    );

    it('prefers the withdrawn notice when dead comes with another lifecycle keyword', async () => {
      const { notice: text } = await notice('allocated,dead');
      expect(text).toContain('withdrawn');
    });

    it('adds no notice to an ordinary entry, nor to one whose keyword merely contains the word', async () => {
      expect((await notice('nonn,core')).notice).toBeUndefined();
      expect((await notice('deadline,allocation')).notice).toBeUndefined();
    });
  });

  describe('link URL schemes', () => {
    const hostile = recordWith({
      link: [
        '<a href="javascript:alert(1)">js</a>',
        '<a href="JavaScript:alert(2)">js-mixed</a>',
        '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgzKTwvc2NyaXB0Pg==">data</a>',
        '<a href="java&#9;script:alert(4)">js-tab</a>',
        '<a href="&#106;avascript:alert(5)">js-entity</a>',
        '<a href="  javascript:alert(6)">js-space</a>',
        '<a href="mailto:someone@example.org">mail</a>',
        '<a href="ftp://example.org/file">ftp</a>',
        'Mixed: <a href="javascript:x()">bad</a> and <a href="https://example.org/good">good</a>',
        '<a href="/A000032">relative</a> <a href="http://example.org/plain">http</a>',
      ],
    });

    it('keeps only http: and https: URLs in links[].urls and keeps the text of dropped ones', async () => {
      const { result } = await fetchSequence({ aNumber: 'A45', sections: ['links'] }, ok(hostile));
      const links = structured(result).links as { text: string; urls: string[] }[];
      expect(links).toEqual([
        { text: 'js', urls: [] },
        { text: 'js-mixed', urls: [] },
        { text: 'data', urls: [] },
        { text: 'js-tab', urls: [] },
        { text: 'js-entity', urls: [] },
        { text: 'js-space', urls: [] },
        { text: 'mail', urls: [] },
        { text: 'ftp', urls: [] },
        { text: 'Mixed: bad and good', urls: ['https://example.org/good'] },
        { text: 'relative http', urls: ['https://oeis.org/A000032', 'http://example.org/plain'] },
      ]);
    });

    it('renders each URL as an inline code span and never as a markdown link target', async () => {
      const { result } = await fetchSequence({ aNumber: 'A45', sections: ['links'] }, ok(hostile));
      const text = textOf(result);
      expect(text).toContain('`https://example.org/good`');
      expect(text).toContain('`https://oeis.org/A000032` `http://example.org/plain`');
      expect(text).not.toMatch(/\]\(/);
      expect(text.toLowerCase()).not.toContain('javascript:');
      expect(text).not.toContain('data:text');
      expect(text).not.toContain('mailto:');
      expect(text).toContain('- js\n');
    });

    it('does not let a dropped javascript: href become the b-file URL', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A45', sections: ['links'] },
        ok(recordWith({ link: ['<a href="javascript:/A000045/b000045.txt">b</a>'] })),
      );
      expect(structured(result).bFileUrl).toBeUndefined();
    });
  });

  describe('upstream failures', () => {
    it('maps a 404 to the sequence_not_found contract with the A-number and recovery hint', async () => {
      const { result } = await fetchSequence({ aNumber: 'A999999' }, res('', { status: 404 }));
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'OEIS has no entry A999999.',
        data: {
          reason: 'sequence_not_found',
          aNumber: 'A999999',
          recovery: { hint: expect.stringContaining('oeis_search_sequences') },
        },
      });
      expect(textOf(result)).toContain('reason sequence_not_found');
      expect(textOf(result)).toContain('Recovery:');
    });

    it('does not retry a 404 and does not cache it', async () => {
      const { calls, service } = serviceOver(res('', { status: 404 }));
      holder.service = service;
      await runToolContract(oeisGetSequence, { aNumber: 'A999999' });
      await runToolContract(oeisGetSequence, { aNumber: 'A999999' });
      expect(calls).toHaveLength(2);
    });

    it('surfaces a 403 edge refusal as upstream_refused, never Forbidden, without retrying', async () => {
      const { calls, result } = await fetchSequence(
        { aNumber: 'A45' },
        res('<html>Attention Required</html>', { status: 403 }),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_refused', retryable: false },
      });
      expect(calls).toHaveLength(1);
    });

    it('surfaces a 429 with a long Retry-After as RateLimited without retrying', async () => {
      const { calls, result } = await fetchSequence(
        { aNumber: 'A45' },
        res('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      );
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { retryAfter: '120' },
      });
      expect(calls).toHaveLength(1);
    });

    it('surfaces an unredirected 301 as an invalid request, not a followed redirect', async () => {
      const { calls, result } = await fetchSequence(
        { aNumber: 'A45' },
        res(null, { status: 301, headers: { location: '/A000045' } }),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(calls).toHaveLength(1);
    });

    it('fails a record missing required fields once, as non-retryable upstream_unparseable', async () => {
      const { calls, result } = await fetchSequence(
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
        vi.restoreAllMocks();
      });

      const run = async (steps: ReturnType<typeof res>[]) => {
        const { calls, service } = serviceOver(...steps);
        holder.service = service;
        const result = await withBackoff(runToolContract(oeisGetSequence, { aNumber: 'A45' }));
        return { calls, result };
      };

      it('retries a 5xx and then reports ServiceUnavailable with the attempt count', async () => {
        const { calls, result } = await run([res('oops', { status: 500 })]);
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { retryAttempts: 3 },
        });
        expect(calls).toHaveLength(3);
      });

      it('recovers when a 503 is followed by a good record', async () => {
        const { calls, result } = await run([res('oops', { status: 503 }), ok()]);
        expect(result.isError).toBeUndefined();
        expect(structured(result).aNumber).toBe('A000045');
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

      it.each(['[]', 'null', '"text"', ''])(
        'reports the non-record body %j as upstream_unparseable',
        async (body) => {
          const { result } = await run([res(body, { status: 200 })]);
          expect(errorOf(result).data).toMatchObject({ reason: 'upstream_unparseable' });
        },
      );

      it('maps a network failure to "oeis.org is unreachable"', async () => {
        const { result } = await run([new TypeError('fetch failed')]);
        expect(errorOf(result)).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
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
        const { calls, fetch } = scriptedFetch(ok());
        holder.service = new OeisService({ fetch, pacer, queueMaxWaitMs: 1_000 });
        const first = await runToolContract(oeisGetSequence, { aNumber: 'A45' });
        expect(first.isError).toBeUndefined();
        const shed = await runToolContract(oeisGetSequence, { aNumber: 'A108' });
        expect(shed.isError).toBe(true);
        expect(errorOf(shed)).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'pacer_shed',
            retryAfter: expect.anything(),
            recovery: { hint: expect.stringContaining('oeis_get_sequence again') },
          },
        });
        expect(textOf(shed)).toContain('reason pacer_shed');
        expect(calls).toHaveLength(1);
      } finally {
        pacer.dispose();
      }
    });
  });

  describe('contract plumbing', () => {
    it('attaches the typed ctx.fail so a handler call throws the declared reason', async () => {
      const { service } = serviceOver(res('', { status: 404 }));
      holder.service = service;
      const ctx = createMockContext({ errors: oeisGetSequence.errors }) as unknown as Context;
      const input = oeisGetSequence.input.parse({ aNumber: 'A999999' }) as Input;
      await expect(oeisGetSequence.handler(input, ctx as never)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'sequence_not_found', aNumber: 'A999999' },
      });
    });

    it('declares every contract with the codes the design names', () => {
      expect(oeisGetSequence.errors?.map((e) => [e.reason, e.code])).toEqual([
        ['sequence_not_found', JsonRpcErrorCode.NotFound],
        ['pacer_shed', JsonRpcErrorCode.RateLimited],
        ['upstream_rate_limited', JsonRpcErrorCode.RateLimited],
      ]);
    });
  });

  describe('format', () => {
    it('carries every field of the structured output', async () => {
      const raw = recordWith({
        keyword: 'nonn,core',
        link: [
          '<a href="/A000045/b000045.txt">Table of n, a(n)</a>',
          'Wikipedia, <a href="https://en.wikipedia.org/wiki/Fibonacci_number">Fibonacci number</a>',
        ],
      });
      const { result } = await fetchSequence({ aNumber: 'A45' }, ok(raw));
      const out = structured(result) as Record<string, unknown> & {
        links: { text: string; urls: string[] }[];
        programs: { code: string; language?: string }[];
      };
      const text = textOf(result);
      for (const value of [
        out.aNumber,
        out.name,
        out.offset,
        out.author,
        out.created,
        out.modified,
        out.url,
        out.bFileUrl,
        String(out.referenceCount),
        String(out.revision),
        String(out.firstIndex),
        ...(out.terms as string[]),
        ...(out.legacyIds as string[]),
        ...(out.keywords as string[]),
        ...(out.comments as string[]),
        ...(out.formulas as string[]),
        ...(out.examples as string[]),
        ...(out.references as string[]),
        ...(out.crossReferences as string[]),
        ...(out.extensions as string[]),
        ...out.links.flatMap((link) => [link.text, ...link.urls]),
        ...out.programs.flatMap((p) => [p.code, p.language ?? 'Untagged']),
      ]) {
        expect(text, String(value)).toContain(String(value));
      }
    });

    it('renders comment-like sections as one blockquote per line and examples and programs as fences', async () => {
      const { result } = await fetchSequence({ aNumber: 'A45' }, ok());
      const text = textOf(result);
      expect(text).toContain("## Comments\n\n> Also sometimes called Lamé's sequence.");
      expect(text).toContain('## Examples\n\n```\nF(5) = 5 = F(4) + F(3) = 3 + 2.\n```');
      expect(text).toContain(
        '### Python\n\n```\nfrom sympy import fibonacci\ndef a(n): return fibonacci(n)\n```',
      );
      expect(text).toContain('### PARI\n\n```\na(n) = fibonacci(n)\n```');
    });

    it('keeps CR/LF in upstream text out of inline slots, so injected headings stay inert', async () => {
      const inject = '\r\n## Injected heading\n# Another';
      const raw = recordWith({
        name: `Name${inject}`,
        author: `Author${inject}`,
        keyword: `nonn,odd${inject}`,
        offset: `0,4${inject}`,
        created: `2020${inject}`,
        time: `2021${inject}`,
        link: [`Link text${inject} <a href="https://example.org/x">x</a>`],
        comment: [`Comment line${inject}`],
        formula: [`Formula${inject}`],
        reference: [`Reference${inject}`],
        xref: [`Xref${inject}`],
        ext: [`Ext${inject}`],
        example: [`Example${inject}`],
        maple: [`Maple code${inject}`],
      });
      const { result } = await fetchSequence({ aNumber: 'A45' }, ok(raw));
      expect(result.isError).toBeUndefined();
      const lines = textOf(result).split('\n');
      let fenced = false;
      const outsideFences = lines.filter((line) => {
        if (line.startsWith('```')) {
          fenced = !fenced;
          return false;
        }
        return !fenced;
      });
      expect(fenced).toBe(false);
      // Outside fences, the only heading-shaped lines are the tool's own.
      expect(outsideFences.filter((line) => /^#{1,6} /.test(line))).toEqual([
        '# A000045: Name ## Injected heading # Another',
        '## Comments',
        '## Formulas',
        '## Examples',
        '## Programs',
        '### Maple',
        '### Mathematica',
        '### PARI',
        '### Python',
        '## References',
        '## Links',
        '## Cross-references',
        '## Extensions',
      ]);
      const inlineSlots = lines.filter((line) =>
        /^\*\*(Author|Keywords|Offset|Created|Modified):/.test(line),
      );
      expect(inlineSlots).toHaveLength(5);
      for (const slot of inlineSlots) expect(slot).toContain('Injected heading');
      expect(lines.find((line) => line.startsWith('- Link text'))).toContain('Injected heading');
      for (const section of ['Comment line', 'Formula', 'Reference', 'Xref', 'Ext']) {
        expect(lines).toContain(`> ${section}`);
      }
      expect(lines.filter((line) => line === '> ## Injected heading')).toHaveLength(5);
      expect(lines.filter((line) => line === '> # Another')).toHaveLength(5);
      expect(structured(result).name).toBe(`Name${inject}`);
    });

    it('lengthens the fence past any backtick run in example and program text', async () => {
      const raw = recordWith({
        example: ['before ``` inside ```` after', '```'],
        maple: ['x := `y`;'],
      });
      const { result } = await fetchSequence({ aNumber: 'A45' }, ok(raw));
      const text = textOf(result);
      expect(text).toContain('`````\nbefore ``` inside ```` after\n```\n`````');
      expect(text).toContain('```\nx := `y`;\n```');
    });

    it('renders a link URL containing backticks inside a code span longer than the run', () => {
      const blocks = oeisGetSequence.format?.({
        kind: 'full',
        aNumber: 'A000001',
        name: 'Backticks.',
        terms: ['1'],
        offset: '1,1',
        firstIndex: 1,
        keywords: ['nonn'],
        referenceCount: 1,
        revision: 1,
        url: 'https://oeis.org/A000001',
        links: [{ text: 't', urls: ['https://example.org/a``b', 'https://example.org/`c'] }],
      });
      const text = blocksText(blocks);
      expect(text).toContain('- t — ```https://example.org/a``b``` ``https://example.org/`c``');
    });

    it('percent-encodes a backtick in a link URL, so none survives normalization', async () => {
      const { result } = await fetchSequence(
        { aNumber: 'A45', sections: ['links'] },
        ok(recordWith({ link: ['<a href="https://example.org/a``b">t</a>'] })),
      );
      expect(structured(result).links).toEqual([
        { text: 't', urls: ['https://example.org/a%60%60b'] },
      ]);
    });

    it('formats a hand-built output with only the core fields', () => {
      const blocks = oeisGetSequence.format?.({
        kind: 'full',
        aNumber: 'A000001',
        name: 'Core only.',
        terms: ['1'],
        offset: '1,1',
        firstIndex: 1,
        keywords: ['nonn'],
        referenceCount: 1,
        revision: 1,
        url: 'https://oeis.org/A000001',
      });
      const text = blocksText(blocks);
      expect(text).toContain('# A000001: Core only.');
      expect(text).not.toContain('## Comments');
      expect(blocks).toHaveLength(1);
    });
  });
});
