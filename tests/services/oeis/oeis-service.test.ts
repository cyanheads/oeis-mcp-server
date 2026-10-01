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
  FIBONACCI_LAST_MODIFIED,
  fibonacciBFile,
  fibonacciRecordJson,
  htmlMaintenanceBody,
  minimalRecordJson,
  noResultsSearchPage,
  oversizedBFile,
  recordBody,
  recordWith,
  resultsSearchPage,
  signInRefusalBody,
  tooManySearchPage,
} from '../../fixtures/oeis-upstream.js';
import { type FetchStep, hangingFetch, res, scriptedFetch } from '../../fixtures/scripted-fetch.js';

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

    it('returns the record after a fetch, and still returns it once stale', async () => {
      const h = harness([json()]);
      const record = await h.service.getRecord('A000045', h.ctx);
      expect(h.service.getCachedRecord('A000045')).toBe(record);
      h.clock.now += 30 * DAY;
      expect(h.service.getCachedRecord('A000045')).toBe(record);
      expect(h.fetchCalls).toHaveLength(1);
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

    it('evicts a stale cached record when OEIS now answers 404', async () => {
      const h = harness([json(), res('gone', { status: 404 })]);
      await h.service.getRecord('A000045', h.ctx);
      h.clock.now += DAY;
      await expect(h.service.getRecord('A000045', h.ctx)).resolves.toBeUndefined();
      expect(h.service.getCachedRecord('A000045')).toBeUndefined();
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
