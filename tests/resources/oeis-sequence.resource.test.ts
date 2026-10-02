/**
 * @fileoverview Tests for the oeis://sequence/{aNumber} resource over a real OeisService with a
 * scripted fetch: URI matching and A-number normalization, the whole-entry JSON (never outlined, and
 * never cut where the tool cuts a selection), parity with oeis_get_sequence, link-scheme filtering,
 * the sequence_not_found contract for an
 * unknown A-number, malformed A-numbers rejected before any request, and upstream failure classes.
 * @module tests/resources/oeis-sequence.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { UriTemplate } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oeisSequenceResource } from '@/mcp-server/resources/definitions/oeis-sequence.resource.js';
import { oeisGetSequence } from '@/mcp-server/tools/definitions/oeis-get-sequence.tool.js';
import { OeisService } from '@/services/oeis/oeis-service.js';
import {
  fibonacciRecordJson,
  htmlMaintenanceBody,
  minimalRecordJson,
  type RawRecord,
  recordBody,
  recordWith,
  reservedRecordJson,
} from '../fixtures/oeis-upstream.js';
import { res, scriptedFetch } from '../fixtures/scripted-fetch.js';
import { serviceOver, withBackoff } from '../fixtures/tool-service.js';

const paramsSchema = (() => {
  const schema = oeisSequenceResource.params;
  if (!schema) throw new Error('oeis://sequence/{aNumber} must declare params');
  return schema;
})();

const holder = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock('@/services/oeis/oeis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/oeis/oeis-service.js')>()),
  getOeisService: () => holder.service,
}));

const record = (raw: RawRecord = fibonacciRecordJson) =>
  res(recordBody(raw), { status: 200, headers: { 'content-type': 'application/json' } });
const missing = () => res('<html>Not found</html>', { status: 404 });

/**
 * 375 link lines shaped like OEIS's (the count A000108 carries), together far past the
 * 100,000-byte response budget oeis_get_sequence cuts a selection at.
 */
const manyLinks = Array.from(
  { length: 375 },
  (_, i) =>
    `A. Author ${i}, <a href="https://example.org/papers/${i}.pdf">On structure number ${i}, a long descriptive title of the kind OEIS link lines carry</a>, J. Example Math. ${i % 40} (2020), ${i}-${i + 20}.`,
);

/** Reads the resource the way a client would: match the URI, validate params, run the handler. */
async function read(uri: string, ...steps: ReturnType<typeof res>[]) {
  const { calls, service } = serviceOver(...steps);
  holder.service = service;
  const variables = new UriTemplate(oeisSequenceResource.uriTemplate).match(uri);
  if (!variables) throw new Error(`URI did not match the template: ${uri}`);
  const params = paramsSchema.parse(variables);
  const ctx = createMockContext({ errors: oeisSequenceResource.errors, uri: new URL(uri) });
  return { calls, output: await oeisSequenceResource.handler(params, ctx), params };
}

/** Same, expecting the handler to reject; returns the thrown error. */
async function readError(uri: string, ...steps: ReturnType<typeof res>[]): Promise<McpError> {
  const error = await read(uri, ...steps).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

/** Runs the handler for `aNumber` against whatever service is installed. */
async function invoke(aNumber: string): Promise<unknown> {
  return oeisSequenceResource.handler(
    paramsSchema.parse({ aNumber }),
    createMockContext({ errors: oeisSequenceResource.errors }),
  );
}

afterEach(() => {
  holder.service = undefined;
});

describe('oeis://sequence/{aNumber}', () => {
  describe('definition', () => {
    it('is a public, cacheable JSON resource with no list', () => {
      expect(oeisSequenceResource.uriTemplate).toBe('oeis://sequence/{aNumber}');
      expect(oeisSequenceResource.name).toBe('oeis_sequence');
      expect(oeisSequenceResource.mimeType).toBe('application/json');
      expect(oeisSequenceResource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
      expect(oeisSequenceResource.list).toBeUndefined();
    });

    it('declares sequence_not_found as NotFound, and pacer_shed and upstream_rate_limited as retryable RateLimited service errors', () => {
      expect(oeisSequenceResource.errors).toEqual([
        expect.objectContaining({
          reason: 'sequence_not_found',
          code: JsonRpcErrorCode.NotFound,
          recovery: expect.stringContaining('oeis_search_sequences'),
        }),
        expect.objectContaining({
          reason: 'pacer_shed',
          code: JsonRpcErrorCode.RateLimited,
          retryable: true,
          thrownBy: 'service',
          recovery: expect.stringContaining('read this resource again'),
        }),
        expect.objectContaining({
          reason: 'upstream_rate_limited',
          code: JsonRpcErrorCode.RateLimited,
          retryable: true,
          thrownBy: 'service',
          recovery: expect.stringContaining('read this resource again'),
        }),
      ]);
    });
  });

  describe('URI and A-number input', () => {
    it.each([
      ['oeis://sequence/A000108', 'A000108'],
      ['oeis://sequence/A108', 'A000108'],
      ['oeis://sequence/a000108', 'A000108'],
      ['oeis://sequence/108', 'A000108'],
      ['oeis://sequence/A0000108', 'A000108'],
      ['oeis://sequence/A1234567', 'A1234567'],
    ])('reads %s as %s', (uri, expected) => {
      const variables = new UriTemplate(oeisSequenceResource.uriTemplate).match(uri);
      expect(paramsSchema.parse(variables).aNumber).toBe(expected);
    });

    it.each(['M1459', 'N0577', 'abc', 'A12345678', 'A10x', '-5', 'A', '0x10'])(
      'rejects the malformed A-number %j',
      (aNumber) => {
        expect(paramsSchema.safeParse({ aNumber }).success).toBe(false);
      },
    );

    it('rejects a missing aNumber', () => {
      expect(paramsSchema.safeParse({}).success).toBe(false);
    });

    it('does not match a URI with no A-number segment', () => {
      expect(
        new UriTemplate(oeisSequenceResource.uriTemplate).match('oeis://sequence/'),
      ).toBeNull();
      expect(
        new UriTemplate(oeisSequenceResource.uriTemplate).match('oeis://other/A000108'),
      ).toBeNull();
    });

    it('sends no request for a malformed A-number', async () => {
      const { service, calls } = serviceOver(record());
      holder.service = service;
      expect(paramsSchema.safeParse({ aNumber: 'M1459' }).success).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe('known entry', () => {
    it('requests the normalized A-number and returns the whole entry as kind full', async () => {
      const { calls, output, params } = await read('oeis://sequence/A45', record());
      expect(params.aNumber).toBe('A000045');
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]?.url ?? '').pathname).toBe('/A000045');
      expect(new URL(calls[0]?.url ?? '').searchParams.get('fmt')).toBe('json');
      expect(output).toMatchObject({
        kind: 'full',
        aNumber: 'A000045',
        name: 'Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
        offset: '0,4',
        firstIndex: 0,
        keywords: ['nonn', 'core', 'nice', 'easy', 'hear', 'changed'],
        legacyIds: ['M0692', 'N0256'],
        referenceCount: 6162,
        revision: 902,
        url: 'https://oeis.org/A000045',
        bFileUrl: 'https://oeis.org/A000045/b000045.txt',
      });
      expect(output).not.toHaveProperty('sections');
      expect(output).not.toHaveProperty('outlineNotice');
    });

    it('carries every section of the entry', async () => {
      const { output } = await read('oeis://sequence/A000045', record());
      const entry = output as Record<string, unknown>;
      expect(entry.comments).toHaveLength(2);
      expect(entry.formulas).toEqual([
        'G.f.: x/(1 - x - x^2).',
        'a(n) = a(n-1) + a(n-2) for n >= 2.',
      ]);
      expect(entry.examples).toEqual(['F(5) = 5 = F(4) + F(3) = 3 + 2.']);
      expect(entry.programs).toEqual([
        { language: 'Maple', code: expect.stringContaining('A000045 := proc(n)') },
        { language: 'Mathematica', code: 'Fibonacci[Range[0, 40]]' },
        { language: 'PARI', code: 'a(n) = fibonacci(n)' },
        { language: 'Python', code: 'from sympy import fibonacci\ndef a(n): return fibonacci(n)' },
      ]);
      expect(entry.references).toHaveLength(1);
      expect(entry.crossReferences).toEqual(['Cf. A000032, A001045.', 'Row sums of A011973.']);
      expect(entry.extensions).toEqual(['Extended by _Jane Doe_, Jan 01 2020.']);
      expect((entry.links as unknown[]).length).toBe(2);
      expect(entry.author).toBe('_N. J. A. Sloane_, Apr 30 1991');
      expect(entry.created).toBe('1991-04-30T03:00:00-04:00');
      expect(entry.modified).toBe('2026-09-23T16:08:09-04:00');
    });

    it('returns the same entry as oeis_get_sequence for an entry that fits the outline budget', async () => {
      const { output } = await read('oeis://sequence/A000045', record());
      const { service } = serviceOver(record());
      holder.service = service;
      const viaTool = await oeisGetSequence.handler(
        oeisGetSequence.input.parse({ aNumber: 'A45' }),
        createMockContext({ errors: oeisGetSequence.errors }),
      );
      expect(output).toEqual(viaTool);
    });

    it('conforms to the sequence output schema', async () => {
      const { output } = await read('oeis://sequence/A000045', record());
      expect(oeisGetSequence.output.safeParse(output).success).toBe(true);
    });

    it('stays whole past the 24 KB outline budget where oeis_get_sequence outlines', async () => {
      const big = recordWith({ comment: ['x'.repeat(30_000)] }, minimalRecordJson);
      const { output } = await read('oeis://sequence/A388000', record(big));
      expect(output).toMatchObject({ kind: 'full', comments: ['x'.repeat(30_000)] });
      expect(output).not.toHaveProperty('sections');
      expect(output).not.toHaveProperty('outlineNotice');

      const { service } = serviceOver(record(big));
      holder.service = service;
      const viaTool = await oeisGetSequence.handler(
        oeisGetSequence.input.parse({ aNumber: 'A388000' }),
        createMockContext({ errors: oeisGetSequence.errors }),
      );
      expect(viaTool.kind).toBe('outline');
    });

    it('returns every link of an entry whose links overflow the tool response budget', async () => {
      const raw = recordWith({ link: manyLinks }, minimalRecordJson);
      const { output } = await read('oeis://sequence/A388000', record(raw));
      const entry = output as Record<string, unknown> & { links: { text: string }[] };
      expect(entry.kind).toBe('full');
      expect(entry.links).toHaveLength(375);
      expect(entry.links.map((link) => link.text.split(',')[0])).toEqual(
        manyLinks.map((_, i) => `A. Author ${i}`),
      );
      expect(entry).not.toHaveProperty('nextFromItem');
      expect(entry).not.toHaveProperty('notice');
      expect(oeisGetSequence.output.safeParse(output).success).toBe(true);
    });

    it('stays whole where oeis_get_sequence cuts the same links selection between items', async () => {
      const raw = recordWith({ link: manyLinks }, minimalRecordJson);
      const { service } = serviceOver(record(raw));
      holder.service = service;
      const viaTool = await runToolContract(oeisGetSequence, {
        aNumber: 'A388000',
        sections: ['links'],
      });
      const cut = viaTool.structuredContent as { links: unknown[]; nextFromItem?: unknown };
      expect(cut.links.length).toBeLessThan(375);
      expect(cut.nextFromItem).toEqual({ section: 'links', index: cut.links.length });

      const { output } = await read('oeis://sequence/A388000', record(raw));
      expect((output as { links: unknown[] }).links).toHaveLength(375);
      expect(output).not.toHaveProperty('nextFromItem');
    });

    it('serializes to JSON without loss', async () => {
      const { output } = await read('oeis://sequence/A000045', record());
      expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    });

    it('returns empty sections for a record that has none, and omits absent optionals', async () => {
      const { output } = await read('oeis://sequence/A388000', record(minimalRecordJson));
      expect(output).toMatchObject({
        kind: 'full',
        aNumber: 'A388000',
        terms: ['1', '2', '3'],
        offset: '1,2',
        firstIndex: 1,
        comments: [],
        formulas: [],
        examples: [],
        programs: [],
        references: [],
        links: [],
        crossReferences: [],
        extensions: [],
      });
      expect(output).not.toHaveProperty('author');
      expect(output).not.toHaveProperty('legacyIds');
      expect(output).not.toHaveProperty('bFileUrl');
    });

    it('serves a repeated read from the cache', async () => {
      const { service, calls } = serviceOver(record());
      holder.service = service;
      const ctx = createMockContext({ errors: oeisSequenceResource.errors });
      const params = paramsSchema.parse({ aNumber: 'A45' });
      await oeisSequenceResource.handler(params, ctx);
      await oeisSequenceResource.handler(params, ctx);
      expect(calls).toHaveLength(1);
    });
  });

  describe('link schemes', () => {
    it('keeps only http and https URLs from the entry links', async () => {
      const raw = recordWith({
        link: [
          '<a href="javascript:alert(1)">Evil</a>',
          '<a href="data:text/html,<script>alert(1)</script>">Data</a>',
          '<a href="JaVaScRiPt:alert(2)">Mixed case</a>',
          '<a href="mailto:a@b.c">Mail</a>',
          '<a href="ftp://example.com/x">Ftp</a>',
          '<a href="/A000045/b000045.txt">b-file</a>',
          '<a href="https://example.com/ok">Fine</a> and <a href="javascript:x">bad</a>',
          '<a href="http://example.com/plain">Plain</a>',
        ],
      });
      const { output } = await read('oeis://sequence/A000045', record(raw));
      const links = (output as { links: { text: string; urls: string[] }[] }).links;
      expect(links.map((link) => link.urls)).toEqual([
        [],
        [],
        [],
        [],
        [],
        ['https://oeis.org/A000045/b000045.txt'],
        ['https://example.com/ok'],
        ['http://example.com/plain'],
      ]);
      const urls = links.flatMap((link) => link.urls).join(' ');
      expect(urls).not.toMatch(/javascript:|data:|mailto:|ftp:/i);
    });
  });

  describe('reserved entry', () => {
    it('reads a reserved A-number whose record has no offset, without offset or firstIndex', async () => {
      const { output } = await read('oeis://sequence/A397217', record(reservedRecordJson));
      expect(output).toMatchObject({
        kind: 'full',
        aNumber: 'A397217',
        name: 'allocated for Jane Doe',
        terms: [],
        keywords: ['allocated'],
        comments: [],
      });
      expect(output).not.toHaveProperty('offset');
      expect(output).not.toHaveProperty('firstIndex');
    });
  });

  describe('unknown entry', () => {
    it('throws sequence_not_found with the declared recovery when upstream answers 404', async () => {
      const error = await readError('oeis://sequence/A999999', missing());
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({ reason: 'sequence_not_found', aNumber: 'A999999' });
      expect(error.message).toContain('A999999');
    });

    it('normalizes the A-number before asking, so the error names the padded form', async () => {
      const { service, calls } = serviceOver(missing());
      holder.service = service;
      const params = paramsSchema.parse({ aNumber: '999999' });
      const ctx = createMockContext({ errors: oeisSequenceResource.errors });
      await expect(oeisSequenceResource.handler(params, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'sequence_not_found', aNumber: 'A999999' },
      });
      expect(new URL(calls[0]?.url ?? '').pathname).toBe('/A999999');
    });

    it('asks once: a 404 is not retried', async () => {
      const { service, calls } = serviceOver(missing());
      holder.service = service;
      await invoke('A999999').catch(() => undefined);
      expect(calls).toHaveLength(1);
    });
  });

  describe('upstream failures', () => {
    it('sheds a queued read through the pacer_shed contract: RateLimited with retryAfter', async () => {
      const pacer = createPacer({
        name: 'oeis-resource-test',
        minStartGapMs: 10_000,
        maxConcurrent: 1,
      });
      try {
        const { calls, fetch } = scriptedFetch(record());
        holder.service = new OeisService({ fetch, pacer, queueMaxWaitMs: 1_000 });
        await invoke('A45');
        const error = await invoke('A108').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
        expect((error as McpError).data).toMatchObject({
          reason: 'pacer_shed',
          retryAfter: expect.anything(),
        });
        expect(calls).toHaveLength(1);
      } finally {
        pacer.dispose();
      }
    });

    it('fails an edge 403 as upstream_refused, never Forbidden', async () => {
      const error = await readError(
        'oeis://sequence/A000045',
        res('<html>Attention Required</html>', { status: 403 }),
      );
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_refused', retryable: false });
    });

    it('fails a 429 as upstream_rate_limited carrying retryAfter', async () => {
      const error = await readError(
        'oeis://sequence/A000045',
        res('slow', { status: 429, headers: { 'retry-after': '120' } }),
      );
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: '120' });
    });

    it('fails a record missing required fields once, as non-retryable upstream_unparseable', async () => {
      const { service, calls } = serviceOver(res(JSON.stringify({ number: 45 }), { status: 200 }));
      holder.service = service;
      const error = await invoke('A45').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((error as McpError).data).toMatchObject({
        reason: 'upstream_unparseable',
        retryable: false,
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

      const fail = async (steps: ReturnType<typeof res>[]) => {
        const { service, calls } = serviceOver(...steps);
        holder.service = service;
        const settled = invoke('A45').then(
          () => undefined,
          (e: unknown) => e,
        );
        const error = await withBackoff(settled);
        expect(error).toBeInstanceOf(McpError);
        return { calls, error: error as McpError };
      };

      it('retries a 5xx and then fails with ServiceUnavailable and the attempt count', async () => {
        const { calls, error } = await fail([res('oops', { status: 502 })]);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({ retryAttempts: 3 });
        expect(calls).toHaveLength(3);
      });

      it('reports an HTML maintenance page as retryable upstream_unparseable', async () => {
        const { calls, error } = await fail([res(htmlMaintenanceBody, { status: 200 })]);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({ reason: 'upstream_unparseable' });
        expect(calls).toHaveLength(3);
      });

      it('reports a malformed JSON body as upstream_unparseable', async () => {
        const { error } = await fail([res('{"number": 45,', { status: 200 })]);
        expect(error.data).toMatchObject({ reason: 'upstream_unparseable' });
      });

      it('maps a network failure to "oeis.org is unreachable"', async () => {
        const { error } = await fail([new TypeError('fetch failed')]);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toContain('oeis.org is unreachable.');
      });

      it('maps the per-attempt timer firing to Timeout', async () => {
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
          AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
        );
        const { error } = await fail([new DOMException('timed out', 'TimeoutError')]);
        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      });

      it('recovers when a 503 is followed by the record', async () => {
        const { service, calls } = serviceOver(res('oops', { status: 503 }), record());
        holder.service = service;
        const output = await withBackoff(invoke('A45'));
        expect(output).toMatchObject({ kind: 'full', aNumber: 'A000045' });
        expect(calls).toHaveLength(2);
      });
    });
  });
});
