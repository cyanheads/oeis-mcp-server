/**
 * @fileoverview OEIS upstream client: one process-wide pacer (one request start per 10 s), a
 * deadline-bounded retry boundary around fetch + parse, per-path accept-list fetch boundaries, and
 * a byte-budgeted LRU cache. Serves records (`/A######?fmt=json`), searches (`/search?fmt=text`),
 * and b-files (`/A######/b######.txt`).
 * @module services/oeis/oeis-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  isRecord,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { parseSearchText } from './internal-format.js';
import { LruCache } from './lru-cache.js';
import { normalizeRecord } from './normalize-record.js';
import type {
  BFileRead,
  BFileTerm,
  SearchPage,
  SearchParams,
  SequenceRecord,
  UpstreamCallOptions,
} from './types.js';

const ORIGIN = 'https://oeis.org';
/** One tool call's total budget across attempts, backoffs, and queue wait. */
export const DEFAULT_DEADLINE_MS = 50_000;
const PER_ATTEMPT_MS = 15_000;
const DEFAULT_QUEUE_MAX_WAIT_MS = 30_000;
const BFILE_MAX_BYTES = 1_048_576;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 60 * 60 * 1000;
const BFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BFILE_LINE = /^\s*(-?\d+)\s+(-?\d+)\s*$/;
const HTML_START = /^\s*<(!doctype\s+html|html[\s>])/i;
const DEFAULT_USER_AGENT = 'oeis-mcp-server (+https://github.com/cyanheads/oeis-mcp-server)';

type CachedValue =
  | { kind: 'record'; record: SequenceRecord; lastModified?: string }
  | { kind: 'search'; page: SearchPage }
  | { kind: 'bfile'; read: BFileRead };

type RecordOutcome =
  | { kind: 'ok'; record: SequenceRecord; lastModified?: string }
  | { kind: 'not_modified' }
  | { kind: 'missing' };

/** Constructor options — the injectable seams for tests. */
export interface OeisServiceOptions {
  /** Fetch implementation. Default: `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Clock for cache expiry, epoch milliseconds. Default: `Date.now`. */
  now?: () => number;
  /** Pacer every oeis.org request runs through (a zero-gap pacer in unit tests). */
  pacer: Pacer;
  /** Longest a call waits in the pacer queue. Default 30 s. */
  queueMaxWaitMs?: number;
  /** `User-Agent` sent on every request. */
  userAgent?: string;
}

/** The canonical b-file URL of an A-number: `https://oeis.org/A######/b######.txt`. */
export function bFileUrl(aNumber: string): string {
  return `${ORIGIN}/${aNumber}/b${aNumber.slice(1)}.txt`;
}

/** Discards an unread body so the connection is released. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel();
}

/** Reads a response body up to `max` bytes, cancelling the stream past the cap. */
async function readCapped(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array; overflowed: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), overflowed: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      overflowed = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.length) break;
  }
  return { bytes, overflowed };
}

function headerInt(value: string | null): number | undefined {
  if (value === null) return;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function parseRecordBody(text: string): SequenceRecord {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!isRecord(body)) {
    throw serviceUnavailable(
      'OEIS returned a sequence page that is not a JSON record, likely a maintenance page.',
      { reason: 'upstream_unparseable' },
    );
  }
  return normalizeRecord(body);
}

function parseBFile(text: string, cut: boolean): BFileTerm[] {
  if (HTML_START.test(text)) {
    throw serviceUnavailable(
      'OEIS returned an HTML page in place of a b-file, likely a maintenance page.',
      {
        reason: 'upstream_unparseable',
      },
    );
  }
  const lines = text.split('\n');
  if (cut && !text.endsWith('\n')) lines.pop();
  const terms: BFileTerm[] = [];
  for (const line of lines) {
    const match = BFILE_LINE.exec(line);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n)) terms.push({ n, value: match[2] ?? '' });
  }
  return terms;
}

/** Reads the shared `/search` 403 body: the anonymous paging cap, or an edge refusal. */
async function searchRefusal(res: Response): Promise<McpError> {
  const body = (await res.text()).trimStart();
  if (body.startsWith('Sign in to see search results')) {
    return validationError(
      'OEIS shows anonymous users only the first 110 results of a query; narrow the query instead of paging deeper.',
      { reason: 'result_window_exceeded' },
    );
  }
  return edgeRefusal();
}

function edgeRefusal(): McpError {
  return serviceUnavailable('oeis.org refused the request at its edge (HTTP 403).', {
    reason: 'upstream_refused',
    retryable: false,
  });
}

/** Client for oeis.org. Every upstream request is paced, retried within a deadline, and cached. */
export class OeisService {
  private readonly cache = new LruCache<CachedValue>(CACHE_MAX_BYTES);
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly pacer: Pacer;
  private readonly queueMaxWaitMs: number;
  private readonly userAgent: string;

  constructor(options: OeisServiceOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.pacer = options.pacer;
    this.queueMaxWaitMs = options.queueMaxWaitMs ?? DEFAULT_QUEUE_MAX_WAIT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** The cached record for an A-number, fresh or stale, without any upstream request. */
  getCachedRecord(aNumber: string): SequenceRecord | undefined {
    const value = this.cache.get(`record:${aNumber}`)?.value;
    return value?.kind === 'record' ? value.record : undefined;
  }

  /**
   * Fetches and normalizes one record. A cached record younger than 24 h is served as-is; an
   * older one is revalidated with `If-Modified-Since` (a `304` refreshes it without a body).
   *
   * @returns The record, or `undefined` when OEIS answers `404` for the A-number.
   */
  async getRecord(
    aNumber: string,
    ctx: Context,
    options: UpstreamCallOptions = {},
  ): Promise<SequenceRecord | undefined> {
    const key = `record:${aNumber}`;
    const cached = this.cache.get(key);
    const entry = cached?.value.kind === 'record' ? cached.value : undefined;
    if (cached && entry && cached.expiresAt > this.now()) {
      ctx.log.debug('OEIS record cache hit', { aNumber });
      return entry.record;
    }

    const outcome = await this.call<RecordOutcome>(
      'getRecord',
      `${ORIGIN}/${aNumber}?fmt=json`,
      [200, 304, 404],
      entry?.lastModified ? { 'If-Modified-Since': entry.lastModified } : {},
      async (res) => {
        if (res.status === 404) {
          await discard(res);
          return { kind: 'missing' };
        }
        if (res.status === 304) {
          await discard(res);
          return { kind: 'not_modified' };
        }
        const lastModified = res.headers.get('last-modified') ?? undefined;
        return {
          kind: 'ok',
          record: parseRecordBody(await res.text()),
          ...(lastModified && { lastModified }),
        };
      },
      ctx,
      options.deadlineMs,
    );

    if (outcome.kind === 'missing') {
      this.cache.delete(key);
      return;
    }
    const fresh = outcome.kind === 'ok' ? outcome : entry;
    if (!fresh) {
      throw serviceUnavailable('OEIS answered 304 Not Modified to a request with no cached copy.', {
        reason: 'upstream_unparseable',
      });
    }
    this.cache.set(
      key,
      {
        kind: 'record',
        record: fresh.record,
        ...(fresh.lastModified && { lastModified: fresh.lastModified }),
      },
      JSON.stringify(fresh.record).length,
      this.now() + RECORD_TTL_MS,
    );
    return fresh.record;
  }

  /** Runs one `/search?fmt=text` query and parses the page. Pages are cached for 1 h. */
  async search(
    params: SearchParams,
    ctx: Context,
    options: UpstreamCallOptions = {},
  ): Promise<SearchPage> {
    const key = `search:${JSON.stringify([params.q, params.sort, params.start])}`;
    const cached = this.cache.get(key);
    if (cached && cached.value.kind === 'search' && cached.expiresAt > this.now()) {
      ctx.log.debug('OEIS search cache hit', { q: params.q, start: params.start });
      return cached.value.page;
    }

    const query = [
      `q=${encodeURIComponent(params.q)}`,
      'fmt=text',
      ...(params.start > 0 ? [`start=${params.start}`] : []),
      ...(params.sort !== 'relevance' ? [`sort=${params.sort}`] : []),
    ].join('&');
    const page = await this.call(
      'search',
      `${ORIGIN}/search?${query}`,
      [200, 403],
      {},
      async (res) => {
        if (res.status === 403) throw await searchRefusal(res);
        return parseSearchText(await res.text());
      },
      ctx,
      options.deadlineMs,
    );
    this.cache.set(
      key,
      { kind: 'search', page },
      JSON.stringify(page).length,
      this.now() + SEARCH_TTL_MS,
    );
    return page;
  }

  /**
   * Reads the first 1 MiB of an entry's b-file from its canonical path. Reads are cached for 7 days.
   *
   * @returns `{ status: 'missing' }` when OEIS answers `404` (the entry has no b-file).
   */
  async getBFile(
    aNumber: string,
    ctx: Context,
    options: UpstreamCallOptions = {},
  ): Promise<BFileRead> {
    const key = `bfile:${aNumber}`;
    const cached = this.cache.get(key);
    if (cached && cached.value.kind === 'bfile' && cached.expiresAt > this.now()) {
      ctx.log.debug('OEIS b-file cache hit', { aNumber });
      return cached.value.read;
    }

    const read = await this.call<BFileRead>(
      'getBFile',
      bFileUrl(aNumber),
      [200, 206, 404],
      { Range: `bytes=0-${BFILE_MAX_BYTES - 1}` },
      async (res) => {
        if (res.status === 404) {
          await discard(res);
          return { status: 'missing' };
        }
        const { bytes, overflowed } = await readCapped(res, BFILE_MAX_BYTES);
        const sizeInBytes =
          res.status === 206
            ? headerInt(res.headers.get('content-range')?.split('/')[1] ?? null)
            : headerInt(res.headers.get('content-length'));
        const cut = overflowed || (sizeInBytes !== undefined && sizeInBytes > bytes.length);
        return {
          status: 'ok',
          terms: parseBFile(new TextDecoder().decode(bytes), cut),
          ...(sizeInBytes !== undefined && { sizeInBytes }),
          cut,
        };
      },
      ctx,
      options.deadlineMs,
    );
    this.cache.set(
      key,
      { kind: 'bfile', read },
      JSON.stringify(read).length,
      this.now() + BFILE_TTL_MS,
    );
    return read;
  }

  /** Releases the pacer: clears its timer and rejects queued waiters. */
  dispose(): void {
    this.pacer.dispose();
  }

  /**
   * The retry boundary: each attempt re-queues at the pacer, and queue time, backoff, and every
   * attempt share one deadline. A queue wait the deadline cannot absorb sheds at enqueue.
   */
  private call<T>(
    operation: string,
    url: string,
    accept: readonly number[],
    headers: Record<string, string>,
    read: (res: Response) => Promise<T>,
    ctx: Context,
    deadlineMs = DEFAULT_DEADLINE_MS,
  ): Promise<T> {
    return withRetry(
      ({ signal, remainingMs }) => {
        const perAttemptMs = Math.min(PER_ATTEMPT_MS, remainingMs);
        return this.pacer.run(
          (taskSignal) => this.attempt(url, accept, headers, perAttemptMs, taskSignal, read),
          {
            signal,
            maxWaitMs: Math.max(0, Math.min(this.queueMaxWaitMs, remainingMs - PER_ATTEMPT_MS)),
          },
        );
      },
      {
        operation: `OeisService.${operation}`,
        context: ctx,
        signal: ctx.signal,
        deadlineMs,
        maxRetries: 2,
        baseDelayMs: 2_000,
        maxDelayMs: 30_000,
      },
    );
  }

  /**
   * One fetch + read against an accept-list: a listed status is a result for `read`, an
   * unlisted `403` is an edge refusal, and anything else is classified from the response — a
   * `429` with `reason: 'upstream_rate_limited'` beside the `retryAfter` it carries.
   * Raw fetch failures are classified here so none surfaces as `InternalError`.
   */
  private async attempt<T>(
    url: string,
    accept: readonly number[],
    headers: Record<string, string>,
    perAttemptMs: number,
    signal: AbortSignal,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const timer = AbortSignal.timeout(perAttemptMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, ...headers },
        redirect: 'manual',
        signal: AbortSignal.any([signal, timer]),
      });
      if (!accept.includes(res.status)) {
        if (res.status === 403) {
          await discard(res);
          throw edgeRefusal();
        }
        throw await httpErrorFromResponse(res, {
          service: 'OEIS',
          ...(res.status === 429 && { data: { reason: 'upstream_rate_limited' } }),
        });
      }
      return await read(res);
    } catch (err) {
      if (signal.aborted || err instanceof McpError) throw err;
      if (timer.aborted) {
        throw timeout(
          `OEIS did not answer within ${Math.ceil(perAttemptMs / 1000)} s.`,
          undefined,
          {
            cause: err,
          },
        );
      }
      throw serviceUnavailable('oeis.org is unreachable.', undefined, { cause: err });
    }
  }
}

let _service: OeisService | undefined;

/** Builds the process-wide service and its pacer. Call from `createApp({ setup })`. */
export function initOeisService(config: AppConfig): void {
  _service = new OeisService({
    pacer: createPacer({
      name: 'oeis',
      minStartGapMs: 10_000,
      maxConcurrent: 1,
      cooldown: { baseMs: 30_000, maxMs: 300_000 },
    }),
    queueMaxWaitMs: getServerConfig().queueMaxWaitMs,
    userAgent: `oeis-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/oeis-mcp-server)`,
  });
}

/** The process-wide service. Throws when `initOeisService()` has not run. */
export function getOeisService(): OeisService {
  if (!_service) throw new Error('OeisService not initialized — call initOeisService() in setup()');
  return _service;
}

/** Disposes the service's pacer. Call from `createApp({ teardown })`. */
export function disposeOeisService(): void {
  _service?.dispose();
  _service = undefined;
}
