/**
 * @fileoverview Tests for OeisService through its constructor seams (`fetch`, `now`, `pacer`,
 * `queueMaxWaitMs`, `userAgent`): per-path accept lists, redirect handling, 403 split, timeout and
 * network mapping, caller abort, revalidation, cache TTLs, search URL building, and b-file reads.
 * @module tests/services/oeis/oeis-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeOeisService,
  getOeisService,
  initOeisService,
  OeisService,
} from '@/services/oeis/oeis-service.js';
import {
  bFileText,
  capturedSearchRecords,
  FIBONACCI_LAST_MODIFIED,
  fibonacciBFile,
  fibonacciRecordJson,
  htmlMaintenanceBody,
  LUCAS_ETAG,
  longLineBFile,
  lucasBFile,
  minimalRecordJson,
  noResultsSearchPage,
  oversizedBFile,
  recordBody,
  recordWith,
  resultsSearchPage,
  SIGMA_ETAG,
  searchPageText,
  sigmaBFile,
  sigmaOf,
  signInRefusalBody,
  steppedBFile,
  synthesizedBFile,
  tooManySearchPage,
} from '../../fixtures/oeis-upstream.js';
import {
  type FetchStep,
  hang,
  hangingFetch,
  rangedFile,
  res,
  scriptedFetch,
} from '../../fixtures/scripted-fetch.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RECORD_URL = 'https://oeis.org/A000045?fmt=json';
const BFILE_URL = 'https://oeis.org/A000045/b000045.txt';
const USER_AGENT = 'oeis-test/1.0 (+https://example.test)';

/** A pacer that runs every task at once, so a test never waits out the 10 s start gap. */
function immediatePacer(): Pacer & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(
    (task: (signal: AbortSignal) => Promise<unknown>, options?: { signal?: AbortSignal }) =>
      task(options?.signal ?? new AbortController().signal),
  );
  return {
    cooldown: { consecutive: 0, remainingMs: 0 },
    dispose: vi.fn(),
    run: run as unknown as Pacer['run'] & ReturnType<typeof vi.fn>,
    [Symbol.dispose]: vi.fn(),
  } as unknown as Pacer & { run: ReturnType<typeof vi.fn> };
}

const json = (record = fibonacciRecordJson, headers: Record<string, string> = {}): FetchStep =>
  res(recordBody(record), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'last-modified': FIBONACCI_LAST_MODIFIED,
      ...headers,
    },
  });

interface Harness {
  clock: { now: number };
  ctx: Context;
  fetchCalls: ReturnType<typeof scriptedFetch>['calls'];
  fn: ReturnType<typeof scriptedFetch>['fn'];
  pacer: ReturnType<typeof immediatePacer>;
  service: OeisService;
}

function harness(steps: FetchStep[], ctx: Context = createMockContext()): Harness {
  const clock = { now: 1_800_000_000_000 };
  const pacer = immediatePacer();
  const { calls, fetch, fn } = scriptedFetch(...steps);
  const service = new OeisService({ fetch, now: () => clock.now, pacer, userAgent: USER_AGENT });
  return { clock, ctx, fetchCalls: calls, fn, pacer, service };
}

/** Runs a promise to settlement while fake timers advance past every retry backoff. */
async function withBackoff<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  const outcome = await settled;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * A body streamed in 64 KiB chunks as the reader asks for them, recording the most bytes any one
 * response handed over and whether a reader cancelled the stream.
 */
function streamedBody(text: string, init: ResponseInit) {
  const bytes = new TextEncoder().encode(text);
  const seen = { pulled: 0, cancelled: false };
  const step: FetchStep = () => {
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        const chunk = bytes.subarray(at, at + 65_536);
        at += chunk.length;
        seen.pulled = Math.max(seen.pulled, at);
        controller.enqueue(chunk);
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    return new Response(stream, init);
  };
  return { seen, size: bytes.length, step };
}

async function caught(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected the call to reject.');
}

describe('OeisService.getRecord', () => {
  it('fetches /A######?fmt=json with the User-Agent, no conditional header, and redirect: manual', async () => {
    const h = harness([json()]);
    const record = await h.service.getRecord('A000045', h.ctx);
    expect(record).toMatchObject({ aNumber: 'A000045', bFileUrl: BFILE_URL });
    expect(h.fetchCalls).toHaveLength(1);
    const [call] = h.fetchCalls;
    expect(call?.url).toBe(RECORD_URL);
    expect(call?.init.redirect).toBe('manual');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.headers.get('user-agent')).toBe(USER_AGENT);
    expect(call?.headers.has('if-modified-since')).toBe(false);
  });

  it('sends the default User-Agent when none is configured', async () => {
    const { calls, fetch } = scriptedFetch(json());
    const service = new OeisService({ fetch, pacer: immediatePacer() });
    await service.getRecord('A000045', createMockContext());
    expect(calls[0]?.headers.get('user-agent')).toBe(
      'oeis-mcp-server (+https://github.com/cyanheads/oeis-mcp-server)',
    );
  });

  it('runs every request through the pacer, signal and queue cap included', async () => {
    const h = harness([json()]);
    await h.service.getRecord('A000045', h.ctx);
    expect(h.pacer.run).toHaveBeenCalledTimes(1);
    const options = h.pacer.run.mock.calls[0]?.[1] as { maxWaitMs: number; signal: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.maxWaitMs).toBe(30_000);
  });

  it('caps the pacer queue wait at what the deadline can absorb and at queueMaxWaitMs', async () => {
    const pacer = immediatePacer();
    const { fetch } = scriptedFetch(json());
    const service = new OeisService({ fetch, pacer, queueMaxWaitMs: 4_000 });
    await service.getRecord('A000045', createMockContext());
    expect(pacer.run.mock.calls[0]?.[1]).toMatchObject({ maxWaitMs: 4_000 });

    const tight = immediatePacer();
    const second = new OeisService({ fetch: scriptedFetch(json()).fetch, pacer: tight });
    await second.getRecord('A000045', createMockContext(), { deadlineMs: 20_000 });
    // withRetry measures remainingMs on the real clock, so a millisecond can pass before the pacer call.
    const options = tight.run.mock.calls[0]?.[1] as { maxWaitMs: number };
    expect(options.maxWaitMs).toBeLessThanOrEqual(5_000);
    expect(options.maxWaitMs).toBeGreaterThan(4_900);
  });

  describe('caching', () => {
    it('serves a record younger than 24 h from cache without a request', async () => {
      const h = harness([json()]);
      const first = await h.service.getRecord('A000045', h.ctx);
      h.clock.now += DAY - 1;
      const second = await h.service.getRecord('A000045', h.ctx);
      expect(second).toBe(first);
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('revalidates at exactly 24 h with If-Modified-Since and refreshes the TTL on a 304', async () => {
      const h = harness([json(), res(null, { status: 304 })]);
      const first = await h.service.getRecord('A000045', h.ctx);
      h.clock.now += DAY;
      const second = await h.service.getRecord('A000045', h.ctx);
      expect(second).toEqual(first);
      expect(h.fetchCalls).toHaveLength(2);
      expect(h.fetchCalls[1]?.headers.get('if-modified-since')).toBe(FIBONACCI_LAST_MODIFIED);

      h.clock.now += DAY - 1;
      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls).toHaveLength(2);

      h.clock.now += 1;
      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls).toHaveLength(3);
      expect(h.fetchCalls[2]?.headers.get('if-modified-since')).toBe(FIBONACCI_LAST_MODIFIED);
    });

    it('replaces the cached record when revalidation answers 200 with a new revision', async () => {
      const newer = recordWith({ revision: 903, name: 'Renamed.' });
      const h = harness([
        json(),
        json(newer, { 'last-modified': 'Wed, 24 Sep 2026 00:00:00 GMT' }),
      ]);
      await h.service.getRecord('A000045', h.ctx);
      h.clock.now += DAY;
      const updated = await h.service.getRecord('A000045', h.ctx);
      expect(updated).toMatchObject({ revision: 903, name: 'Renamed.' });
      expect(h.service.getCachedRecord('A000045')).toMatchObject({ revision: 903 });

      h.clock.now += DAY;
      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls[2]?.headers.get('if-modified-since')).toBe(
        'Wed, 24 Sep 2026 00:00:00 GMT',
      );
    });

    it('sends no conditional header when the cached copy came without a Last-Modified', async () => {
      const bare = res(recordBody(), { status: 200 });
      const h = harness([bare, json()]);
      await h.service.getRecord('A000045', h.ctx);
      h.clock.now += DAY;
      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls[1]?.headers.has('if-modified-since')).toBe(false);
    });

    it('keeps records per A-number', async () => {
      const h = harness([json(), json(minimalRecordJson)]);
      await h.service.getRecord('A000045', h.ctx);
      const other = await h.service.getRecord('A388000', h.ctx);
      expect(other?.aNumber).toBe('A388000');
      expect(h.fetchCalls.map((c) => c.url)).toEqual([
        RECORD_URL,
        'https://oeis.org/A388000?fmt=json',
      ]);
    });

    it('rejects a 304 with no cached copy as upstream_unparseable and does not retry it', async () => {
      const h = harness([res(null, { status: 304 })]);
      const error = await caught(h.service.getRecord('A000045', h.ctx));
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unparseable' },
      });
      expect(h.fetchCalls).toHaveLength(1);
    });
  });

  describe('getCachedRecord', () => {
    it('returns undefined before any fetch and makes no request', () => {
      const h = harness([json()]);
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();
      expect(h.fetchCalls).toHaveLength(0);
    });

    it('returns the record while it is fresh, and nothing once it is stale', async () => {
      const h = harness([json()]);
      const record = await h.service.getRecord('A000045', h.ctx);
      h.clock.now += DAY - 1;
      expect(h.service.getCachedRecord('A000045')).toBe(record);
      h.clock.now += 1;
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('returns nothing for an A-number OEIS answered 404', async () => {
      const h = harness([res('gone', { status: 404 })]);
      await h.service.getRecord('A999999', h.ctx);
      expect(h.service.getCachedRecord('A999999')).toBeUndefined();
    });

    it('does not mistake a cached search or b-file for a record', async () => {
      const h = harness([res(fibonacciBFile, { status: 200 })]);
      await h.service.getBFile('A000045', h.ctx);
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();
    });
  });

  describe('404', () => {
    it('returns undefined without retrying', async () => {
      const h = harness([res(htmlMaintenanceBody, { status: 404 })]);
      await expect(h.service.getRecord('A999999', h.ctx)).resolves.toBeUndefined();
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('drops a stale cached record when OEIS now answers 404', async () => {
      const h = harness([json(), res('gone', { status: 404 })]);
      await h.service.getRecord('A000045', h.ctx);
      h.clock.now += DAY;
      await expect(h.service.getRecord('A000045', h.ctx)).resolves.toBeUndefined();
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();
      await expect(h.service.getRecord('A000045', h.ctx)).resolves.toBeUndefined();
      expect(h.fetchCalls).toHaveLength(2);
    });

    it('remembers a 404 for an hour, so repeating a missing A-number makes one request', async () => {
      const h = harness([res('gone', { status: 404 })]);
      await expect(h.service.getRecord('A999999', h.ctx)).resolves.toBeUndefined();
      h.clock.now += HOUR - 1;
      await expect(h.service.getRecord('A999999', h.ctx)).resolves.toBeUndefined();
      await expect(h.service.getRecord('A999999', h.ctx)).resolves.toBeUndefined();
      expect(h.fetchCalls).toHaveLength(1);

      h.clock.now += 1;
      await expect(h.service.getRecord('A999999', h.ctx)).resolves.toBeUndefined();
      expect(h.fetchCalls).toHaveLength(2);
      expect(h.fetchCalls[1]?.headers.has('if-modified-since')).toBe(false);
    });

    it('serves a record once a remembered 404 has expired and OEIS answers 200', async () => {
      const h = harness([res('gone', { status: 404 }), json()]);
      await h.service.getRecord('A000045', h.ctx);
      h.clock.now += HOUR;
      await expect(h.service.getRecord('A000045', h.ctx)).resolves.toMatchObject({
        aNumber: 'A000045',
      });
      expect(h.service.getCachedRecord('A000045')).toMatchObject({ aNumber: 'A000045' });
    });
  });

  describe('non-listed statuses', () => {
    it('does not follow a redirect: a 301 is an InvalidRequest and is not retried', async () => {
      const h = harness([res(null, { status: 301, headers: { location: '/A000045' } })]);
      const error = await caught(h.service.getRecord('A45', h.ctx));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('maps a 403 on the record path to upstream_refused, never Forbidden, and does not retry', async () => {
      const h = harness([res('<html>Attention Required</html>', { status: 403 })]);
      const error = await caught(h.service.getRecord('A000045', h.ctx));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_refused', retryable: false });
      expect(error.message).toContain('HTTP 403');
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('maps a 429 with a Retry-After beyond the backoff cap to upstream_rate_limited without retrying', async () => {
      const h = harness([res('slow down', { status: 429, headers: { 'retry-after': '120' } })]);
      const error = await caught(h.service.getRecord('A000045', h.ctx));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: '120' });
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('gives no other status the upstream_rate_limited reason', async () => {
      const h = harness([res('oops', { status: 501 })]);
      const error = await caught(h.service.getRecord('A000045', h.ctx));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).not.toHaveProperty('reason');
    });

    it('classifies an unlisted 4xx as a non-retried client error', async () => {
      const h = harness([res('bad', { status: 400 })]);
      const error = await caught(h.service.getRecord('A000045', h.ctx));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(h.fetchCalls).toHaveLength(1);
    });
  });

  describe('retried failures', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('retries a 429 after the Retry-After the upstream names', async () => {
      const h = harness([
        res('slow down', { status: 429, headers: { 'retry-after': '1' } }),
        json(),
      ]);
      const record = await withBackoff(h.service.getRecord('A000045', h.ctx));
      expect(record?.aNumber).toBe('A000045');
      expect(h.fetchCalls).toHaveLength(2);
    });

    it('surfaces a 429 with no Retry-After as upstream_rate_limited, with no retryAfter, once retries are spent', async () => {
      const h = harness([res('slow down', { status: 429 })]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAttempts: 3 });
      expect(error.data).not.toHaveProperty('retryAfter');
      expect(h.fetchCalls).toHaveLength(3);
    });

    it('retries a 5xx, re-queueing each attempt at the pacer, then succeeds', async () => {
      const h = harness([res('oops', { status: 502 }), res('oops', { status: 503 }), json()]);
      const record = await withBackoff(h.service.getRecord('A000045', h.ctx));
      expect(record?.aNumber).toBe('A000045');
      expect(h.fetchCalls).toHaveLength(3);
      expect(h.pacer.run).toHaveBeenCalledTimes(3);
    });

    it('gives up after three attempts on a persistent 5xx with the attempt count in the error', async () => {
      const h = harness([res('oops', { status: 500 })]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ retryAttempts: 3 });
      expect(h.fetchCalls).toHaveLength(3);
    });

    it('classifies a 503 from its status and headers alone: no body text or reason phrase reaches the error', async () => {
      const page = streamedBody(
        '<!doctype html><html><body><h1>db01 is down</h1><pre>at Backend.query</pre></body></html>',
        { status: 503, statusText: 'Backend db01 unavailable', headers: { 'retry-after': '1' } },
      );
      const h = harness([page.step]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe('OEIS returned HTTP 503. (failed after 3 attempts)');
      expect(error.data).toMatchObject({ status: 503, retryAfter: '1', retryAttempts: 3 });
      expect(error.data).not.toHaveProperty('body');
      expect(error.data).not.toHaveProperty('responseBody');
      expect(JSON.stringify(error.data)).not.toContain('db01');
    });

    it('stops reading a record body past 4 MiB and fails it as unparseable', async () => {
      const comment = 'x'.repeat(5 * 1_048_576);
      const body = streamedBody(recordBody(recordWith({ comment: [comment] })), { status: 200 });
      const h = harness([body.step]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unparseable' },
      });
      expect(body.seen.cancelled).toBe(true);
      expect(body.seen.pulled).toBeLessThan(4 * 1_048_576 + 3 * 65_536);
      expect(body.size).toBeGreaterThan(5 * 1_048_576);
    });

    it('maps a network failure to "oeis.org is unreachable" and retries it', async () => {
      const h = harness([new TypeError('fetch failed')]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toContain('oeis.org is unreachable.');
      expect(h.fetchCalls).toHaveLength(3);
    });

    it('recovers when a network failure is followed by a good response', async () => {
      const h = harness([new TypeError('fetch failed'), json()]);
      await expect(withBackoff(h.service.getRecord('A000045', h.ctx))).resolves.toMatchObject({
        aNumber: 'A000045',
      });
    });

    it('maps the per-attempt timer firing to a Timeout naming the seconds, and retries it', async () => {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
        AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
      );
      const h = harness([new DOMException('timed out', 'TimeoutError')]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.message).toContain('OEIS did not answer within 15 s.');
      expect(h.fetchCalls).toHaveLength(3);
    });

    it('treats a body that is not a JSON record as retryable upstream_unparseable', async () => {
      const h = harness([res(htmlMaintenanceBody, { status: 200 })]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryAttempts: 3 });
      expect(h.fetchCalls).toHaveLength(3);
    });

    it.each(['[]', 'null', '"text"', '42', ''])(
      'treats the JSON-or-not body %j as upstream_unparseable',
      async (body) => {
        const h = harness([res(body, { status: 200 })]);
        const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
        expect(error.data).toMatchObject({ reason: 'upstream_unparseable' });
      },
    );

    it('fails a record with missing required fields once, non-retryable', async () => {
      const h = harness([res(JSON.stringify({ number: 45 }), { status: 200 })]);
      const error = await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('does not cache a failed fetch', async () => {
      const html = res(htmlMaintenanceBody, { status: 200 });
      const h = harness([html, html, html, json()]);
      await caught(withBackoff(h.service.getRecord('A000045', h.ctx)));
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();
      await expect(h.service.getRecord('A000045', h.ctx)).resolves.toMatchObject({
        aNumber: 'A000045',
      });
    });

    it('stops at the deadline with a Timeout instead of waiting out every backoff', async () => {
      const h = harness([res('oops', { status: 500 })]);
      const error = await caught(
        withBackoff(h.service.getRecord('A000045', h.ctx, { deadlineMs: 1_000 })),
      );
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 1_000 });
    });
  });

  describe('caller abort', () => {
    it('rethrows the caller abort reason unchanged, without relabelling or retrying', async () => {
      const controller = new AbortController();
      const hang = hangingFetch();
      const service = new OeisService({ fetch: hang.fetch, pacer: immediatePacer() });
      const pending = service.getRecord(
        'A000045',
        createMockContext({ signal: controller.signal }),
      );
      const outcome = pending.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await hang.started;
      const reason = new Error('client went away');
      controller.abort(reason);
      const { error } = await outcome;
      expect(error).toBe(reason);
      expect(error).not.toBeInstanceOf(McpError);
      expect(hang.calls).toHaveLength(1);
    });
  });
});

describe('OeisService.search', () => {
  const ctx = createMockContext();

  it('omits sort for relevance and start at 0, and percent-encodes the query', async () => {
    const h = harness([res(resultsSearchPage, { status: 200 })]);
    await h.service.search({ q: '1,2,5,14', sort: 'relevance', start: 0 }, ctx);
    expect(h.fetchCalls[0]?.url).toBe('https://oeis.org/search?q=1%2C2%2C5%2C14&fmt=text');
    expect(h.fetchCalls[0]?.init.redirect).toBe('manual');
    expect(h.fetchCalls[0]?.headers.get('user-agent')).toBe(USER_AGENT);
  });

  it.each(['number', 'created', 'modified'] as const)('sends sort=%s', async (sort) => {
    const h = harness([res(resultsSearchPage, { status: 200 })]);
    await h.service.search({ q: 'fibonacci', sort, start: 0 }, ctx);
    expect(h.fetchCalls[0]?.url).toBe(`https://oeis.org/search?q=fibonacci&fmt=text&sort=${sort}`);
  });

  it('sends start for a non-zero offset and both parameters together', async () => {
    const h = harness([res(resultsSearchPage, { status: 200 })]);
    await h.service.search({ q: 'fibonacci', sort: 'modified', start: 20 }, ctx);
    expect(h.fetchCalls[0]?.url).toBe(
      'https://oeis.org/search?q=fibonacci&fmt=text&start=20&sort=modified',
    );
  });

  it('encodes operators, quotes, ampersands and spaces so they stay inside q', async () => {
    const h = harness([res(resultsSearchPage, { status: 200 })]);
    await h.service.search(
      { q: 'id:A000045|id:A000108 "a&b=c" -x', sort: 'relevance', start: 0 },
      ctx,
    );
    const url = new URL(h.fetchCalls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('id:A000045|id:A000108 "a&b=c" -x');
    expect([...url.searchParams.keys()]).toEqual(['q', 'fmt']);
  });

  it('returns the parsed page', async () => {
    const h = harness([res(resultsSearchPage, { status: 200 })]);
    const page = await h.service.search({ q: '1,2,5', sort: 'relevance', start: 0 }, ctx);
    expect(page).toMatchObject({ status: 'results', total: 26 });
    expect(page.rows).toHaveLength(2);
  });

  it('returns none and too_many pages as results, not errors', async () => {
    const none = harness([res(noResultsSearchPage, { status: 200 })]);
    await expect(
      none.service.search({ q: 'id:axyz', sort: 'relevance', start: 0 }, ctx),
    ).resolves.toMatchObject({
      status: 'none',
      total: 0,
    });
    const many = harness([res(tooManySearchPage, { status: 200 })]);
    await expect(
      many.service.search({ q: 'prime', sort: 'relevance', start: 0 }, ctx),
    ).resolves.toMatchObject({
      status: 'too_many',
    });
  });

  describe('caching', () => {
    it('serves the same query from cache for 1 h, then refetches', async () => {
      const h = harness([res(resultsSearchPage, { status: 200 })]);
      const params = { q: '1,2,5', sort: 'relevance', start: 0 } as const;
      const first = await h.service.search(params, ctx);
      h.clock.now += HOUR - 1;
      expect(await h.service.search(params, ctx)).toBe(first);
      expect(h.fetchCalls).toHaveLength(1);
      h.clock.now += 1;
      await h.service.search(params, ctx);
      expect(h.fetchCalls).toHaveLength(2);
    });

    it('keys the cache on query, sort and start', async () => {
      const h = harness([res(resultsSearchPage, { status: 200 })]);
      await h.service.search({ q: 'a', sort: 'relevance', start: 0 }, ctx);
      await h.service.search({ q: 'b', sort: 'relevance', start: 0 }, ctx);
      await h.service.search({ q: 'a', sort: 'number', start: 0 }, ctx);
      await h.service.search({ q: 'a', sort: 'relevance', start: 10 }, ctx);
      expect(h.fetchCalls).toHaveLength(4);
      await h.service.search({ q: 'a', sort: 'relevance', start: 10 }, ctx);
      expect(h.fetchCalls).toHaveLength(4);
    });

    it('caches a none page like any other', async () => {
      const h = harness([res(noResultsSearchPage, { status: 200 })]);
      const params = { q: 'id:axyz', sort: 'relevance', start: 0 } as const;
      await h.service.search(params, ctx);
      await h.service.search(params, ctx);
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('does not cache a failure', async () => {
      const h = harness([res('refused', { status: 403 }), res(resultsSearchPage, { status: 200 })]);
      const params = { q: '1,2,5', sort: 'relevance', start: 0 } as const;
      await caught(h.service.search(params, ctx));
      await expect(h.service.search(params, ctx)).resolves.toMatchObject({ status: 'results' });
    });
  });

  describe('rows against the cached record', () => {
    const params = { q: 'keyword:core', sort: 'modified', start: 0 } as const;
    /** A search page whose one row is A000045 with the given `%I` timestamp, or no `%I` line. */
    const pageEditedAt = (time: string | undefined) =>
      res(
        searchPageText({
          query: 'keyword:core',
          status: 'Showing 1-1 of 1',
          records: [
            capturedSearchRecords.A000045.replace(
              '%I A000045 M0692 N0256 #2594 Sep 23 2026 16:08:09',
              time === undefined ? '' : `%I A000045 M0692 N0256 #2595 ${time}`,
            ),
          ],
        }),
        { status: 200 },
      );
    const newerRecord = recordWith({ revision: 903, time: '2026-10-01T18:00:00-04:00' });

    it('makes the next record read revalidate when a row shows a later edit, with no request at search time', async () => {
      const h = harness([
        json(),
        pageEditedAt('Oct 01 2026 18:00:00'),
        json(newerRecord, { 'last-modified': 'Thu, 01 Oct 2026 22:00:00 GMT' }),
      ]);
      await h.service.getRecord('A000045', h.ctx);
      const page = await h.service.search(params, ctx);
      expect(page.rows[0]?.modified).toBe('2026-10-01T18:00:00-04:00');
      expect(h.fetchCalls).toHaveLength(2);
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();

      const record = await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls).toHaveLength(3);
      expect(h.fetchCalls[2]?.url).toBe(RECORD_URL);
      expect(h.fetchCalls[2]?.headers.get('if-modified-since')).toBe(FIBONACCI_LAST_MODIFIED);
      expect(record).toMatchObject({ revision: 903, modified: '2026-10-01T18:00:00-04:00' });

      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls).toHaveLength(3);
    });

    it.each([
      ['the same edit time', 'Sep 23 2026 16:08:09'],
      ['an earlier edit time', 'Sep 20 2026 09:00:00'],
      ['no %I line', undefined],
    ])('keeps serving the cached record for a row with %s', async (_shape, time) => {
      const h = harness([json(), pageEditedAt(time)]);
      const first = await h.service.getRecord('A000045', h.ctx);
      await h.service.search(params, ctx);
      expect(await h.service.getRecord('A000045', h.ctx)).toBe(first);
      expect(h.fetchCalls).toHaveLength(2);
    });

    it('keeps serving a cached record that has no edit time, whatever the row shows', async () => {
      const h = harness([
        json(recordWith({ time: undefined })),
        pageEditedAt('Oct 01 2026 18:00:00'),
      ]);
      const first = await h.service.getRecord('A000045', h.ctx);
      expect(first?.modified).toBeUndefined();
      await h.service.search(params, ctx);
      expect(await h.service.getRecord('A000045', h.ctx)).toBe(first);
      expect(h.fetchCalls).toHaveLength(2);
    });

    it('compares instants: a fall-back-hour row at 01:40 -04:00 is earlier than a record at 01:30 -05:00', async () => {
      const h = harness([
        json(recordWith({ time: '2026-11-01T01:30:00-05:00' })),
        pageEditedAt('Nov 01 2026 01:40:00'),
      ]);
      const first = await h.service.getRecord('A000045', h.ctx);
      const page = await h.service.search(params, ctx);
      expect(page.rows[0]?.modified).toBe('2026-11-01T01:40:00-04:00');
      expect(await h.service.getRecord('A000045', h.ctx)).toBe(first);
      expect(h.fetchCalls).toHaveLength(2);
    });

    it('does not mark the record again from a search page served from cache', async () => {
      const h = harness([json(), pageEditedAt('Oct 01 2026 18:00:00'), res(null, { status: 304 })]);
      await h.service.getRecord('A000045', h.ctx);
      await h.service.search(params, ctx);
      // The revalidation answers 304, so the record stays older than the cached page's row.
      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls).toHaveLength(3);

      await h.service.search(params, ctx);
      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls).toHaveLength(3);
    });

    it('marks nothing and requests nothing more when no record is cached', async () => {
      const h = harness([pageEditedAt('Oct 01 2026 18:00:00'), json()]);
      await h.service.search(params, ctx);
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();
      await h.service.getRecord('A000045', h.ctx);
      expect(h.fetchCalls).toHaveLength(2);
      expect(h.fetchCalls[1]?.headers.has('if-modified-since')).toBe(false);
    });

    it.each([
      ['an edit time', 'Oct 01 2026 18:00:00'],
      ['no %I line', undefined],
    ])(
      'forgets a remembered 404 once a row with %s shows the entry exists',
      async (_shape, time) => {
        const h = harness([res('gone', { status: 404 }), pageEditedAt(time), json()]);
        expect(await h.service.getRecord('A000045', h.ctx)).toBeUndefined();
        await h.service.search(params, ctx);
        expect(await h.service.getRecord('A000045', h.ctx)).toMatchObject({ aNumber: 'A000045' });
        expect(h.fetchCalls).toHaveLength(3);
      },
    );
  });

  describe('403 split', () => {
    const params = { q: 'keyword:core', sort: 'relevance', start: 100 } as const;

    it('reads the anonymous paging cap as result_window_exceeded, a validation error, not retried', async () => {
      const h = harness([
        res(signInRefusalBody, { status: 403, headers: { 'content-type': 'text/plain' } }),
      ]);
      const error = await caught(h.service.search(params, ctx));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'result_window_exceeded' });
      expect(error.message).toContain('110');
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('ignores leading whitespace before the sign-in text', async () => {
      const h = harness([res(`\n  ${signInRefusalBody}`, { status: 403 })]);
      const error = await caught(h.service.search(params, ctx));
      expect(error.data).toMatchObject({ reason: 'result_window_exceeded' });
    });

    it('reads any other 403 body as upstream_refused with retryable false, never Forbidden', async () => {
      const h = harness([
        res('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 }),
      ]);
      const error = await caught(h.service.search(params, ctx));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_refused', retryable: false });
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('reads an empty 403 body as upstream_refused', async () => {
      const h = harness([res(null, { status: 403 })]);
      const error = await caught(h.service.search(params, ctx));
      expect(error.data).toMatchObject({ reason: 'upstream_refused' });
    });

    it('stops reading a 403 body past 64 KiB and reads it as upstream_refused', async () => {
      const body = streamedBody(`${signInRefusalBody}\n${'x'.repeat(1_048_576)}`, { status: 403 });
      const h = harness([body.step]);
      const error = await caught(h.service.search(params, ctx));
      expect(error.data).toMatchObject({ reason: 'upstream_refused', retryable: false });
      expect(body.seen.cancelled).toBe(true);
      expect(body.seen.pulled).toBeLessThan(65_536 + 3 * 65_536);
    });
  });

  describe('accept list', () => {
    it('does not follow a redirect from /search (a blank q answers 301)', async () => {
      const h = harness([res(null, { status: 301, headers: { location: '/' } })]);
      const error = await caught(h.service.search({ q: '', sort: 'relevance', start: 0 }, ctx));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('treats 404 and 304 as errors on /search, where only 200 and 403 are results', async () => {
      const notFound = harness([res('nope', { status: 404 })]);
      expect(
        (await caught(notFound.service.search({ q: 'x', sort: 'relevance', start: 0 }, ctx))).code,
      ).toBe(JsonRpcErrorCode.NotFound);
      const notModified = harness([res(null, { status: 304 })]);
      expect(
        (await caught(notModified.service.search({ q: 'x', sort: 'relevance', start: 0 }, ctx)))
          .code,
      ).toBe(JsonRpcErrorCode.InvalidRequest);
    });

    it('maps a 429 to upstream_rate_limited carrying retryAfter', async () => {
      const h = harness([res('slow', { status: 429, headers: { 'retry-after': '90' } })]);
      const error = await caught(h.service.search({ q: 'x', sort: 'relevance', start: 0 }, ctx));
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'upstream_rate_limited', retryAfter: '90' },
      });
    });
  });

  describe('unparseable bodies', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('treats an HTML body as retryable upstream_unparseable', async () => {
      const h = harness([res(htmlMaintenanceBody, { status: 200 })]);
      const error = await caught(
        withBackoff(h.service.search({ q: 'x', sort: 'relevance', start: 0 }, ctx)),
      );
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryAttempts: 3 });
      expect(h.fetchCalls).toHaveLength(3);
    });

    it('treats an unknown status line as non-retryable', async () => {
      const h = harness([res('Search: x\nSurprise.\n', { status: 200 })]);
      const error = await caught(
        withBackoff(h.service.search({ q: 'x', sort: 'relevance', start: 0 }, ctx)),
      );
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('stops reading a search page past 16 MiB and fails it as unparseable', async () => {
      const head =
        'Search: x\n\nShowing 1-1 of 1\n\n%N A000045 Fibonacci numbers.\n%O A000045 0,4\n';
      const filler = `%C A000045 ${'x'.repeat(1_000)}\n`.repeat(17 * 1_048);
      const body = streamedBody(head + filler, { status: 200 });
      const h = harness([body.step]);
      const error = await caught(
        withBackoff(h.service.search({ q: 'x', sort: 'relevance', start: 0 }, ctx)),
      );
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable' });
      expect(body.seen.cancelled).toBe(true);
      expect(body.seen.pulled).toBeLessThan(16 * 1_048_576 + 3 * 65_536);
      expect(body.size).toBeGreaterThan(16 * 1_048_576);
    });
  });
});

describe('OeisService.getBFile', () => {
  const ctx = createMockContext();
  const partial = (body: string, total: number | string): FetchStep =>
    res(body, {
      status: 206,
      headers: { 'content-range': `bytes 0-${body.length - 1}/${total}` },
    });

  it('requests the first 1 MiB by Range from the canonical path', async () => {
    const h = harness([partial(fibonacciBFile, fibonacciBFile.length)]);
    await h.service.getBFile('A000045', ctx);
    expect(h.fetchCalls[0]?.url).toBe(BFILE_URL);
    expect(h.fetchCalls[0]?.headers.get('range')).toBe('bytes=0-1048575');
    expect(h.fetchCalls[0]?.headers.get('if-range')).toBeNull();
    expect(h.fetchCalls[0]?.init.redirect).toBe('manual');
  });

  it('reads a complete 206: pairs in order, comments skipped, size from Content-Range, not cut', async () => {
    const h = harness([partial(fibonacciBFile, fibonacciBFile.length)]);
    const read = await h.service.getBFile('A000045', ctx);
    expect(read).toMatchObject({ status: 'ok', cut: false, sizeInBytes: fibonacciBFile.length });
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.terms).toHaveLength(15);
    expect(read.terms.slice(0, 4)).toEqual([
      { n: 0, value: '0' },
      { n: 1, value: '1' },
      { n: 2, value: '1' },
      { n: 3, value: '2' },
    ]);
    expect(read.terms.at(-1)).toEqual({ n: 14, value: '377' });
  });

  it('marks a 206 whose Content-Range total exceeds the body as cut and drops the trailing partial line', async () => {
    const body = '0 0\n1 1\n2 1\n3 2\n4 3\n5 5\n6 8\n7 1';
    const h = harness([partial(body, 429_385)]);
    const read = await h.service.getBFile('A000045', ctx);
    expect(read).toMatchObject({ status: 'ok', cut: true, sizeInBytes: 429_385 });
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.terms.map((t) => t.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps every line of a cut body that ends on a newline', async () => {
    const body = '0 0\n1 1\n2 1\n';
    const h = harness([partial(body, 429_385)]);
    const read = await h.service.getBFile('A000045', ctx);
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.cut).toBe(true);
    expect(read.terms).toHaveLength(3);
  });

  it('does not drop the last line of a complete body with no final newline', async () => {
    const body = '0 0\n1 1\n2 1';
    const h = harness([partial(body, body.length)]);
    const read = await h.service.getBFile('A000045', ctx);
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.cut).toBe(false);
    expect(read.terms).toHaveLength(3);
  });

  it('reads a 200: sizeInBytes from Content-Length, not cut when it fits', async () => {
    const h = harness([
      res(fibonacciBFile, {
        status: 200,
        headers: { 'content-length': String(fibonacciBFile.length) },
      }),
    ]);
    const read = await h.service.getBFile('A000045', ctx);
    expect(read).toMatchObject({ status: 'ok', cut: false, sizeInBytes: fibonacciBFile.length });
  });

  it('omits sizeInBytes when upstream states no size', async () => {
    const h = harness([res(fibonacciBFile, { status: 200 })]);
    const read = await h.service.getBFile('A000045', ctx);
    expect(read.status).toBe('ok');
    expect(read).not.toHaveProperty('sizeInBytes');
    expect(read).toMatchObject({ cut: false });
  });

  it('ignores an unparseable Content-Range total', async () => {
    const h = harness([partial('0 0\n1 1\n', '*')]);
    const read = await h.service.getBFile('A000045', ctx);
    expect(read).not.toHaveProperty('sizeInBytes');
  });

  it('reads the first 1 MiB of a larger 200, cuts it, and drops the trailing partial line', async () => {
    const { lines, text } = oversizedBFile();
    let cancelled = false;
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 65_536) {
          controller.enqueue(bytes.subarray(at, Math.min(at + 65_536, bytes.length)));
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const h = harness([
      res(stream, { status: 200, headers: { 'content-length': String(bytes.length) } }),
    ]);
    const read = await h.service.getBFile('A000045', ctx);
    if (read.status !== 'ok') throw new Error('expected ok');

    let cumulative = 0;
    let complete = 0;
    for (const line of lines) {
      cumulative += line.length;
      if (cumulative > 1_048_576) break;
      complete++;
    }
    expect(read.cut).toBe(true);
    expect(read.sizeInBytes).toBe(bytes.length);
    expect(read.terms).toHaveLength(complete);
    const last = lines[complete - 1]?.trim().split(' ');
    expect(read.terms.at(-1)).toEqual({ n: Number(last?.[0]), value: last?.[1] });
    expect(complete).toBeLessThan(lines.length);
    expect(cancelled).toBe(true);
  });

  it('skips comments, blank lines and malformed lines, and reads CRLF, negatives and big values', async () => {
    const body = [
      '# comment',
      '',
      'not a pair',
      '1 -5',
      '  2   123456789012345678901234567890  ',
      '3 4 5',
      '-1 7',
      '9007199254740993 1',
      '4 x',
      '',
    ].join('\r\n');
    const h = harness([res(body, { status: 200 })]);
    const read = await h.service.getBFile('A000045', ctx);
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.terms).toEqual([
      { n: 1, value: '-5' },
      { n: 2, value: '123456789012345678901234567890' },
      { n: -1, value: '7' },
    ]);
  });

  it('reads an empty 200 body as no terms', async () => {
    const h = harness([res('', { status: 200 })]);
    await expect(h.service.getBFile('A000045', ctx)).resolves.toMatchObject({
      status: 'ok',
      terms: [],
      cut: false,
    });
  });

  describe('404 and caching', () => {
    it('returns { status: "missing" } on 404 without retrying, and caches it', async () => {
      const h = harness([res(htmlMaintenanceBody, { status: 404 })]);
      await expect(h.service.getBFile('A388000', ctx)).resolves.toEqual({ status: 'missing' });
      await expect(h.service.getBFile('A388000', ctx)).resolves.toEqual({ status: 'missing' });
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('reads a file OEIS synthesized from the data line as missing, and caches that', async () => {
      const h = harness([res(synthesizedBFile('A181630', ['1', '1', '2', '5']), { status: 200 })]);
      await expect(h.service.getBFile('A181630', ctx)).resolves.toEqual({ status: 'missing' });
      await expect(h.service.getBFile('A181630', ctx)).resolves.toEqual({ status: 'missing' });
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('reads the marker-only file of a reserved A-number as missing, on a 206 too', async () => {
      const body = synthesizedBFile('A397217', []);
      expect(body).toHaveLength(51);
      const h = harness([
        res(body, { status: 206, headers: { 'content-range': 'bytes 0-50/51' } }),
      ]);
      await expect(h.service.getBFile('A397217', ctx)).resolves.toEqual({ status: 'missing' });
    });

    it('reads a b-file as one when the marker phrase is not its first line', async () => {
      const body =
        '# Table of n, a(n)\n# A000045 (b-file synthesized from sequence entry)\n0 0\n1 1\n';
      const h = harness([res(body, { status: 200 })]);
      await expect(h.service.getBFile('A000045', ctx)).resolves.toMatchObject({
        status: 'ok',
        terms: [
          { n: 0, value: '0' },
          { n: 1, value: '1' },
        ],
      });
    });

    it('caches reads for 7 days, then refetches', async () => {
      const h = harness([res(fibonacciBFile, { status: 200 })]);
      const first = await h.service.getBFile('A000045', ctx);
      h.clock.now += 7 * DAY - 1;
      expect(await h.service.getBFile('A000045', ctx)).toBe(first);
      expect(h.fetchCalls).toHaveLength(1);
      h.clock.now += 1;
      await h.service.getBFile('A000045', ctx);
      expect(h.fetchCalls).toHaveLength(2);
    });

    it('uses the seven-digit path for a seven-digit A-number', async () => {
      const h = harness([res(bFileText(['1', '2']), { status: 200 })]);
      await h.service.getBFile('A1234567', ctx);
      expect(h.fetchCalls[0]?.url).toBe('https://oeis.org/A1234567/b1234567.txt');
    });
  });

  describe('failures', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ['a doctype page', htmlMaintenanceBody],
      ['an <html> page', '  <HTML><body>down</body></HTML>'],
    ])('reads %s as retryable upstream_unparseable', async (_label, body) => {
      const h = harness([res(body, { status: 200 })]);
      const error = await caught(withBackoff(h.service.getBFile('A000045', ctx)));
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryAttempts: 3 });
      expect(h.fetchCalls).toHaveLength(3);
    });

    it('does not cache an HTML body', async () => {
      const html = res(htmlMaintenanceBody, { status: 200 });
      const h = harness([html, html, html, res(fibonacciBFile, { status: 200 })]);
      await caught(withBackoff(h.service.getBFile('A000045', ctx)));
      await expect(h.service.getBFile('A000045', ctx)).resolves.toMatchObject({ status: 'ok' });
    });

    it('maps an edge 403 on the b-file path to upstream_refused', async () => {
      const h = harness([res('blocked', { status: 403 })]);
      const error = await caught(h.service.getBFile('A000045', ctx));
      expect(error.data).toMatchObject({ reason: 'upstream_refused', retryable: false });
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('does not follow a redirect', async () => {
      const h = harness([res(null, { status: 302, headers: { location: '/A000045' } })]);
      const error = await caught(h.service.getBFile('A000045', ctx));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(h.fetchCalls).toHaveLength(1);
    });

    it('retries a 5xx', async () => {
      const h = harness([res('oops', { status: 500 }), res(fibonacciBFile, { status: 200 })]);
      await expect(withBackoff(h.service.getBFile('A000045', ctx))).resolves.toMatchObject({
        status: 'ok',
      });
      expect(h.fetchCalls).toHaveLength(2);
    });
  });
});

describe('OeisService.getBFile past the first 1 MiB', () => {
  const SIGMA_URL = 'https://oeis.org/A000203/b000203.txt';
  const PAGE0_LAST = 87_084;
  const sigma = () => rangedFile({ body: sigmaBFile(), etag: SIGMA_ETAG });
  const ok = (read: Awaited<ReturnType<OeisService['getBFile']>>) => {
    if (read.status !== 'ok') throw new Error('expected an ok read');
    return read;
  };
  /** Every pair of a read is the file's own line: sigma(n) at n, n consecutive. */
  const expectSigmaRun = (pairs: readonly { n: number; value: string }[]) => {
    expect(pairs.length).toBeGreaterThan(0);
    pairs.forEach((pair, i) => {
      expect(pair).toEqual({ n: (pairs[0]?.n ?? 0) + i, value: sigmaOf(pair.n) });
    });
  };

  it('reads the page holding fromIndex with Range and If-Range, and reports the true last index', async () => {
    const h = harness([sigma().step]);
    const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.fetchCalls[1]?.url).toBe(SIGMA_URL);
    expect(h.fetchCalls[1]?.headers.get('range')).toBe('bytes=1044480-1214181');
    expect(h.fetchCalls[1]?.headers.get('if-range')).toBe(SIGMA_ETAG);
    expect(h.fetchCalls[1]?.init.redirect).toBe('manual');
    expect(read).toMatchObject({
      cut: false,
      firstIndex: 1,
      lastIndex: 100_000,
      sizeInBytes: 1_214_182,
    });
    expect(read).not.toHaveProperty('nextIndex');
    expect(read.terms[0]?.n).toBe(86_765);
    expect(read.terms.at(-1)).toEqual({ n: 100_000, value: '246078' });
    expectSigmaRun(read.terms);
  });

  it('makes no request past the first 1 MiB for a fromIndex inside it, and offers the next index', async () => {
    const h = harness([sigma().step]);
    for (const fromIndex of [undefined, 1, PAGE0_LAST]) {
      const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex }));
      expect(read).toMatchObject({
        cut: true,
        firstIndex: 1,
        lastIndex: PAGE0_LAST,
        nextIndex: PAGE0_LAST + 1,
      });
      expect(read.terms).toHaveLength(PAGE0_LAST);
    }
    expect(h.fetchCalls).toHaveLength(1);
  });

  it('reports the furthest page read so far when a later call answers from the first page', async () => {
    const h = harness([sigma().step]);
    ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
    for (const fromIndex of [undefined, 1, PAGE0_LAST]) {
      const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex }));
      expect(read).toMatchObject({
        cut: false,
        firstIndex: 1,
        lastIndex: 100_000,
        nextIndex: PAGE0_LAST + 1,
      });
      expect(read.terms).toHaveLength(PAGE0_LAST);
    }
    expect(h.fetchCalls).toHaveLength(2);
  });

  it("never takes a page's first line for a term, even when its fragment reads as a pair", async () => {
    const body = `${'#'.repeat(11)}\n${sigmaBFile()}`;
    // Page 1 starts 4 KiB before 1 MiB, inside the line `86763 115688`.
    const opening = new TextDecoder().decode(new TextEncoder().encode(body).subarray(1_044_480));
    expect(opening.slice(0, 12)).toBe('6763 115688\n');
    const h = harness([rangedFile({ body, etag: '"prefixed"' }).step]);
    const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
    expect(h.fetchCalls[1]?.headers.get('range')).toBe('bytes=1044480-1214193');
    expect(read.terms[0]).toEqual({ n: 86_764, value: sigmaOf(86_764) });
    expect(read.terms.some((pair) => pair.n === 6_763)).toBe(false);
    expectSigmaRun(read.terms);
  });

  it('stops after two page reads with unreached, and the next call reads on from the pages cached', async () => {
    const { body, lastN } = steppedBFile();
    const h = harness([rangedFile({ body, etag: '"stepped"' }).step]);
    const target = lastN - 20;

    const first = ok(await h.service.getBFile('A000001', h.ctx, { fromIndex: target }));
    expect(first).toMatchObject({ terms: [], cut: true, unreached: true });
    expect(first.lastIndex).toBeLessThan(target);
    expect(first).not.toHaveProperty('nextIndex');
    expect(h.fetchCalls.map((call) => call.headers.get('range'))).toEqual([
      'bytes=0-1048575',
      'bytes=1044480-2097151',
      'bytes=2093056-3145727',
    ]);

    const second = ok(await h.service.getBFile('A000001', h.ctx, { fromIndex: target }));
    expect(h.fetchCalls).toHaveLength(4);
    expect(h.fetchCalls[3]?.headers.get('range')).toBe('bytes=5238784-6291455');
    expect(second).not.toHaveProperty('unreached');
    expect(second.terms.find((pair) => pair.n === target)).toEqual({
      n: target,
      value: '9'.repeat(990),
    });
    const start = second.terms[0]?.n ?? Number.NaN;
    expect(second.terms.map((pair) => pair.n)).toEqual(second.terms.map((_, i) => start + i));
  });

  it('skips a line longer than the overlap that neither page holds whole, and starts at the next n', async () => {
    const { body, longN } = longLineBFile();
    const h = harness([rangedFile({ body, etag: '"long"' }).step]);

    const read = ok(await h.service.getBFile('A000001', h.ctx, { fromIndex: longN }));
    expect(read).toMatchObject({ skippedLine: true, cut: false });
    expect(read.terms[0]).toEqual({ n: longN + 1, value: String((longN + 1) * 3) });
    expect(h.fetchCalls).toHaveLength(2);

    const before = ok(await h.service.getBFile('A000001', h.ctx, { fromIndex: longN - 1 }));
    expect(before.terms.at(-1)).toEqual({ n: longN - 1, value: String((longN - 1) * 3) });
    const after = ok(await h.service.getBFile('A000001', h.ctx, { fromIndex: longN + 1 }));
    for (const held of [before, after]) expect(held).not.toHaveProperty('skippedLine');
    expect(h.fetchCalls).toHaveLength(2);
  });

  it('knows the file ends when its final page holds only pairs the page before already has', async () => {
    const line = (n: number) => `${n} ${String(n).padStart(9, '0')}\n`;
    let body = '';
    let last = 0;
    while (body.length + line(last + 1).length <= 2 * 1_048_576 - 3) body += line(++last);
    // Blank lines run from just before 2 MiB past it, so the final page adds no pair.
    body += '\n'.repeat(2 * 1_048_576 - body.length + 5);
    const h = harness([rangedFile({ body, etag: '"trailing"' }).step]);
    await h.service.getBFile('A000001', h.ctx, { fromIndex: last - 2 });
    const past = ok(await h.service.getBFile('A000001', h.ctx, { fromIndex: last + 1 }));
    expect(past).toMatchObject({ lastIndex: last, cut: false });
    expect(past).not.toHaveProperty('unreached');
    expect(h.fetchCalls).toHaveLength(3);
  });

  it('returns missing when the file is gone by the time a page is requested, and caches that', async () => {
    const h = harness([sigma().step, res('<html>Not found</html>', { status: 404 })]);
    await expect(h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 })).resolves.toEqual({
      status: 'missing',
    });
    await expect(h.service.getBFile('A000203', h.ctx)).resolves.toEqual({ status: 'missing' });
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.fetchCalls[1]?.headers.get('if-range')).toBe(SIGMA_ETAG);
  });

  /** A response from a {@link rangedFile} step with its headers edited. */
  const reheadered =
    (edit: (headers: Headers) => void): FetchStep =>
    (call) => {
      const answer = sigma().step(call);
      const headers = new Headers(answer.headers);
      edit(headers);
      return new Response(answer.body, { status: answer.status, headers });
    };

  it.each([
    ['no ETag', reheadered((headers) => headers.delete('etag'))],
    ['a weak ETag', reheadered((headers) => headers.set('etag', `W/${SIGMA_ETAG}`))],
    [
      'a 200 without Accept-Ranges',
      res(sigmaBFile(), {
        status: 200,
        headers: { etag: SIGMA_ETAG, 'content-length': String(sigmaBFile().length) },
      }),
    ],
  ])(
    'reads only the first 1 MiB of a file served with %s, in one request',
    async (_label, step) => {
      const h = harness([step]);
      const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
      expect(read).toMatchObject({
        cut: true,
        firstMibOnly: true,
        lastIndex: PAGE0_LAST,
        sizeInBytes: 1_214_182,
      });
      expect(read).not.toHaveProperty('nextIndex');
      expect(read).not.toHaveProperty('unreached');
      expect(read.terms).toHaveLength(PAGE0_LAST);
      expect(h.fetchCalls).toHaveLength(1);
    },
  );

  describe('a three-page file', () => {
    const lucas = () => rangedFile({ body: lucasBFile(), etag: LUCAS_ETAG });
    const lucasPairs = () =>
      lucasBFile()
        .split('\n')
        .map((line) => {
          const [n, value] = line.split(' ');
          return { n: Number(n), value };
        });

    it('walks every page with nextIndex, n consecutive across both joins', async () => {
      const h = harness([lucas().step]);
      const seen: { n: number; value: string | undefined }[] = [];
      let fromIndex: number | undefined;
      for (let call = 0; call < 5; call++) {
        const read = ok(await h.service.getBFile('A000032', h.ctx, { fromIndex }));
        const from = fromIndex;
        seen.push(...read.terms.filter((pair) => from === undefined || pair.n >= from));
        fromIndex = read.nextIndex;
        if (fromIndex === undefined) break;
      }
      expect(fromIndex).toBeUndefined();
      expect(seen).toEqual(lucasPairs());
      expect(h.fetchCalls.map((call) => call.headers.get('range'))).toEqual([
        'bytes=0-1048575',
        'bytes=1044480-2097151',
        'bytes=2093056-2412956',
      ]);
    });

    // Each target starts cold, so every one reads the first page again: about 100 targets, 3 s.
    it('reaches fromIndex values across both later pages with at most two page reads each', {
      timeout: 30_000,
    }, async () => {
      const pairs = lucasPairs();
      const file = lucas();
      const targets = [4_449, 4_450, 4_775];
      for (let n = 3_138; n <= 4_775; n += 16) targets.push(n);
      const pageReads = new Map<number, number>();
      for (const n of targets) {
        const h = harness([file.step]);
        const read = ok(await h.service.getBFile('A000032', h.ctx, { fromIndex: n }));
        expect(read.terms.find((pair) => pair.n === n)).toEqual(pairs[n]);
        const reads = h.fetchCalls.length - 1;
        pageReads.set(reads, (pageReads.get(reads) ?? 0) + 1);
      }
      expect([...pageReads.keys()].sort((x, y) => x - y)).toEqual([1, 2]);
    });
  });

  describe('ETag-keyed pages', () => {
    const SIGMA_V2_ETAG = '"sigma-v2"';
    /** The next version of A000203's b-file: every value with a 0 appended. */
    const sigmaV2 = () => sigmaBFile().replace(/^\d+ \d+$/gm, (line) => `${line}0`);
    const expectSigmaV2Run = (pairs: readonly { n: number; value: string }[]) => {
      expect(pairs.length).toBeGreaterThan(0);
      pairs.forEach((pair, i) => {
        expect(pair).toEqual({ n: (pairs[0]?.n ?? 0) + i, value: `${sigmaOf(pair.n)}0` });
      });
    };

    /** Reads page 0 at the start, page 1 a day later, then lets 6 more days pass: page 0 is stale. */
    async function cachedThenStale(h: Harness) {
      await h.service.getBFile('A000203', h.ctx);
      h.clock.now += DAY;
      await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 });
      h.clock.now += 6 * DAY;
    }

    it('reads a later page again under the new ETag once the first page is re-read for a changed file', async () => {
      const file = sigma();
      const h = harness([file.step]);
      await cachedThenStale(h);
      file.state.version = { body: sigmaV2(), etag: SIGMA_V2_ETAG };

      const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
      expect(h.fetchCalls.map((call) => call.headers.get('if-range'))).toEqual([
        null,
        SIGMA_ETAG,
        null,
        SIGMA_V2_ETAG,
      ]);
      expect(read).toMatchObject({ lastIndex: 100_000, sizeInBytes: 1_314_182, cut: false });
      expectSigmaV2Run(read.terms);
    });

    it('reuses a cached later page when the re-read first page carries the same ETag', async () => {
      const h = harness([sigma().step]);
      await cachedThenStale(h);
      const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
      expect(h.fetchCalls).toHaveLength(3);
      expect(h.fetchCalls[2]?.headers.get('range')).toBe('bytes=0-1048575');
      expect(read.terms.at(-1)).toEqual({ n: 100_000, value: '246078' });
      expectSigmaRun(read.terms);
    });

    it('starts over from the new first page when a page request finds the file changed', async () => {
      const file = sigma();
      const h = harness([
        file.step,
        (call) => {
          file.state.version = { body: sigmaV2(), etag: SIGMA_V2_ETAG };
          return file.step(call);
        },
        file.step,
      ]);
      const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
      expect(h.fetchCalls.map((call) => call.headers.get('if-range'))).toEqual([
        null,
        SIGMA_ETAG,
        SIGMA_V2_ETAG,
      ]);
      expect(h.fetchCalls[2]?.headers.get('range')).toBe('bytes=1044480-1314181');
      expect(read).toMatchObject({ lastIndex: 100_000, sizeInBytes: 1_314_182, cut: false });
      expectSigmaV2Run(read.terms);

      const head = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 1 }));
      expectSigmaV2Run(head.terms);
      expect(h.fetchCalls).toHaveLength(3);
    });
  });

  describe('page request failures', () => {
    it('fails a page request answered 429 as upstream_rate_limited, with its Retry-After', async () => {
      const h = harness([
        sigma().step,
        res('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      ]);
      const error = await caught(h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: '120' });
      expect(h.fetchCalls).toHaveLength(2);
      expect(h.fetchCalls[1]?.headers.get('if-range')).toBe(SIGMA_ETAG);
    });

    it.each([
      [
        'another range',
        (headers: Headers) => headers.set('content-range', 'bytes 1040384-1210085/1214182'),
      ],
      ['another ETag', (headers: Headers) => headers.set('etag', '"sigma-v2"')],
    ])(
      'rejects a 206 page from %s without retrying, and reads the first page again on the next call',
      async (_label, edit) => {
        const h = harness([sigma().step, reheadered(edit), sigma().step]);
        const error = await caught(h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
        expect(h.fetchCalls).toHaveLength(2);

        const read = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
        expect(h.fetchCalls.map((call) => call.headers.get('range'))).toEqual([
          'bytes=0-1048575',
          'bytes=1044480-1214181',
          'bytes=0-1048575',
          'bytes=1044480-1214181',
        ]);
        expect(read.terms.at(-1)).toEqual({ n: 100_000, value: '246078' });
        expectSigmaRun(read.terms);
      },
    );

    it('sheds a page request the queue cannot start in time, after the first page', async () => {
      const pacer = createPacer({ name: 'oeis-test', minStartGapMs: 10_000, maxConcurrent: 1 });
      try {
        const { calls, fetch } = scriptedFetch(sigma().step);
        const service = new OeisService({ fetch, pacer, queueMaxWaitMs: 1_000 });
        const error = await caught(
          service.getBFile('A000203', createMockContext(), { fromIndex: 99_990 }),
        );
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_projected' });
        expect(error.data?.retryAfter).toBeDefined();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.headers.get('if-range')).toBeNull();
      } finally {
        pacer.dispose();
      }
    });

    it('rethrows a caller abort during a page request, caches nothing from it, and lets a concurrent call finish', async () => {
      const file = sigma();
      const aStarted = Promise.withResolvers<void>();
      const bStarted = Promise.withResolvers<void>();
      const bGate = Promise.withResolvers<void>();
      const h = harness([
        file.step,
        (call) => {
          aStarted.resolve();
          return hang(call.init.signal);
        },
        async (call) => {
          bStarted.resolve();
          await bGate.promise;
          return file.step(call);
        },
        file.step,
      ]);
      const controller = new AbortController();
      const a = h.service
        .getBFile('A000203', createMockContext({ signal: controller.signal }), {
          fromIndex: 99_990,
        })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      await aStarted.promise;
      const b = h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 });
      await bStarted.promise;

      const reason = new Error('client went away');
      controller.abort(reason);
      const { error } = await a;
      expect(error).toBe(reason);
      expect(error).not.toBeInstanceOf(McpError);

      const after = ok(await h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 }));
      expect(h.fetchCalls).toHaveLength(4);
      expectSigmaRun(after.terms);

      bGate.resolve();
      const concurrent = ok(await b);
      expect(concurrent.terms.at(-1)).toEqual({ n: 100_000, value: '246078' });
      expectSigmaRun(concurrent.terms);
      expect(h.fetchCalls.slice(1).map((call) => call.headers.get('if-range'))).toEqual([
        SIGMA_ETAG,
        SIGMA_ETAG,
        SIGMA_ETAG,
      ]);
    });

    describe('retried', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it.each([
        ['short', -100],
        ['long', 100],
      ])(
        'fails a 206 page body 100 bytes too %s as upstream_unparseable after three attempts',
        async (_label, delta) => {
          const file = sigma();
          const misSized: FetchStep = async (call) => {
            const answer = file.step(call);
            const bytes = new Uint8Array(await answer.arrayBuffer());
            const body = new Uint8Array(bytes.length + delta);
            body.set(bytes.subarray(0, Math.min(bytes.length, body.length)));
            return new Response(body, { status: answer.status, headers: answer.headers });
          };
          const h = harness([file.step, misSized]);
          const error = await caught(
            withBackoff(h.service.getBFile('A000203', h.ctx, { fromIndex: 99_990 })),
          );
          expect(error).toMatchObject({
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { reason: 'upstream_unparseable', retryAttempts: 3 },
          });
          expect(h.fetchCalls).toHaveLength(4);
          for (const call of h.fetchCalls.slice(1)) {
            expect(call.headers.get('range')).toBe('bytes=1044480-1214181');
            expect(call.headers.get('if-range')).toBe(SIGMA_ETAG);
          }
        },
      );
    });
  });

  it('parses a page in time linear in its size', async () => {
    /** Page 0 holds one pair, then a comment line runs past 1 MiB, so page 1 is mostly the tail. */
    const head = `0 0\n${'#'.repeat(1_048_576 + 100)}\n`;
    /** Half newlines, half one digit run that fails the pair pattern at its very end. */
    const tail = (bytes: number) => `1 1\n${'\n'.repeat(bytes / 2)}2 ${'9'.repeat(bytes / 2)} x`;
    const sizes = [16_000, 64_000, 256_000, 1_024_000];
    const SPAN = 64;
    const SAMPLES = 5;
    const files = sizes.map((bytes) => rangedFile({ body: head + tail(bytes), etag: '"t"' }));
    const aNumber = (size: number, sample: number) =>
      `A${String(1 + size * SAMPLES + sample).padStart(6, '0')}`;
    const { calls, fetch } = scriptedFetch((call) => {
      const id = Number(/\/A(\d+)\//.exec(call.url)?.[1]);
      const file = files[Math.floor((id - 1) / SAMPLES)];
      if (!file) throw new Error(`no file for ${call.url}`);
      return file.step(call);
    });
    const service = new OeisService({ fetch, pacer: immediatePacer() });
    const ctx = createMockContext();
    for (let size = 0; size < sizes.length; size++) {
      for (let sample = 0; sample < SAMPLES; sample++) {
        await service.getBFile(aNumber(size, sample), ctx);
      }
    }
    expect(calls).toHaveLength(sizes.length * SAMPLES);

    /** Thread CPU microseconds of each page read, per size; other processes' load stays out. */
    const spent = sizes.map((): number[] => []);
    for (let sample = 0; sample < SAMPLES; sample++) {
      for (let size = 0; size < sizes.length; size++) {
        const started = process.threadCpuUsage();
        const read = ok(await service.getBFile(aNumber(size, sample), ctx, { fromIndex: 1 }));
        const used = process.threadCpuUsage(started);
        spent[size]?.push(used.user + used.system);
        expect(read.terms).toEqual([{ n: 1, value: '1' }]);
      }
    }
    expect(calls).toHaveLength(2 * sizes.length * SAMPLES);

    const fastest = spent.map((samples) => Math.min(...samples));
    const smallest = fastest[0] ?? Number.NaN;
    const largest = fastest.at(-1) ?? Number.NaN;
    // Linear growth keeps the ratio at or under SPAN; quadratic growth would put it near SPAN².
    expect(largest / smallest).toBeLessThan(SPAN * 2);
    expect(largest).toBeLessThan(1_000_000);
  });
});

describe('queueing through a real pacer', () => {
  let pacer: Pacer;
  afterEach(() => pacer.dispose());

  it('sheds a call whose projected queue wait exceeds queueMaxWaitMs, with retryAfter, and does not retry it', async () => {
    pacer = createPacer({ name: 'oeis-test', minStartGapMs: 10_000, maxConcurrent: 1 });
    const { calls, fetch } = scriptedFetch(json());
    const service = new OeisService({ fetch, pacer, queueMaxWaitMs: 1_000 });
    const ctx = createMockContext();
    await service.getRecord('A000045', ctx);
    const error = await caught(service.getRecord('A000108', ctx));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_projected' });
    expect(error.data?.retryAfter).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('sheds at enqueue when the deadline cannot absorb the wait, even with a generous queue cap', async () => {
    pacer = createPacer({ name: 'oeis-test', minStartGapMs: 10_000, maxConcurrent: 1 });
    const { calls, fetch } = scriptedFetch(json());
    const service = new OeisService({ fetch, pacer, queueMaxWaitMs: 60_000 });
    const ctx = createMockContext();
    await service.getRecord('A000045', ctx);
    const error = await caught(service.getRecord('A000108', ctx, { deadlineMs: 20_000 }));
    expect(error.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_projected' });
    expect(calls).toHaveLength(1);
  });

  it('serves a cache hit without entering the pacer', async () => {
    pacer = createPacer({ name: 'oeis-test', minStartGapMs: 10_000, maxConcurrent: 1 });
    const run = vi.spyOn(pacer, 'run');
    const service = new OeisService({
      fetch: scriptedFetch(json()).fetch,
      pacer,
      queueMaxWaitMs: 1_000,
    });
    const ctx = createMockContext();
    await service.getRecord('A000045', ctx);
    await service.getRecord('A000045', ctx);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('OeisService.dispose', () => {
  it('disposes the pacer', () => {
    const pacer = immediatePacer();
    new OeisService({ pacer }).dispose();
    expect(pacer.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('process-wide service', () => {
  afterEach(() => disposeOeisService());

  it('throws a setup hint before initOeisService has run', () => {
    disposeOeisService();
    expect(() => getOeisService()).toThrow(/initOeisService/);
  });

  it('builds one service, sends a versioned User-Agent, and clears on dispose', async () => {
    const http = createFetchMock([
      { match: RECORD_URL, respond: () => new Response(recordBody(), { status: 200 }) },
    ]);
    http.install();
    try {
      initOeisService({ mcpServerVersion: '9.9.9' } as AppConfig);
      const service = getOeisService();
      expect(getOeisService()).toBe(service);
      await service.getRecord('A000045', createMockContext());
      expect(http.calls[0]?.request.headers.get('user-agent')).toBe(
        'oeis-mcp-server/9.9.9 (+https://github.com/cyanheads/oeis-mcp-server)',
      );
      disposeOeisService();
      expect(() => getOeisService()).toThrow(/not initialized/);
    } finally {
      http.restore();
    }
  });
});
