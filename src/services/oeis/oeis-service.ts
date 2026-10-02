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
import { heapCharge, LruCache } from './lru-cache.js';
import { normalizeRecord } from './normalize-record.js';
import type {
  BFileOptions,
  BFileRead,
  BFileTerm,
  SearchPage,
  SearchParams,
  SequenceRecord,
  SequenceSummary,
  UpstreamCallOptions,
} from './types.js';

type BFileOk = Extract<BFileRead, { status: 'ok' }>;

const ORIGIN = 'https://oeis.org';
/** One tool call's total budget across attempts, backoffs, and queue wait. */
export const DEFAULT_DEADLINE_MS = 50_000;
const PER_ATTEMPT_MS = 15_000;
const DEFAULT_QUEUE_MAX_WAIT_MS = 30_000;
/** A b-file is read in pages of this size: bytes 0 to this − 1, then one ranged page at a time. */
const BFILE_PAGE_BYTES = 1_048_576;
/**
 * How far each page past the first starts before the previous page ends, so a line the previous
 * page cut off is whole in the next. OEIS asks for terms of at most about 1,000 digits; the longest
 * line measured across five large b-files was 1,004 bytes.
 */
const BFILE_OVERLAP_BYTES = 4_096;
/** Page reads one call may make past the first page. */
const BFILE_MAX_PAGE_READS = 2;
/**
 * Sent on every b-file request. A `200` answering a stale `If-Range` otherwise comes compressed, with
 * no `Content-Length`, no `Accept-Ranges`, and a weak ETag, so the file's new first page could not
 * be paged.
 */
const UNENCODED = { 'Accept-Encoding': 'identity' } as const;
const LINE_FEED = 0x0a;
/** Ceiling on a record body; A000108, among the largest entries, is 134 KB as served. */
const RECORD_MAX_BYTES = 4 * 1_048_576;
/** Ceiling on a search page; the heaviest measured page (`keyword:core`) was 517 KB. */
const SEARCH_MAX_BYTES = 16 * 1_048_576;
/** Ceiling on a `/search` 403 body; the sign-in refusal is one short line. */
const REFUSAL_MAX_BYTES = 65_536;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a `404` for an A-number is remembered. */
const MISSING_TTL_MS = 60 * 60 * 1000;
const SEARCH_TTL_MS = 60 * 60 * 1000;
const BFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BFILE_LINE = /^\s*(-?\d+)\s+(-?\d+)\s*$/;
/**
 * First line of the file OEIS serves at the b-file path of an entry that has none, built from the
 * data line: `# A181630 (b-file synthesized from sequence entry)`.
 */
const SYNTHESIZED_BFILE = /^#\s*A\d{6,7}\s+\(b-file synthesized from sequence entry\)/;
const HTML_START = /^\s*<(!doctype\s+html|html[\s>])/i;
const DEFAULT_USER_AGENT = 'oeis-mcp-server (+https://github.com/cyanheads/oeis-mcp-server)';

/** A b-file's first page as cached: the read it answers with, and what reading later pages takes. */
interface BFileHead {
  /**
   * Present when later pages can be read: the strong ETag each page request is pinned to with
   * `If-Range`, the file size, and the offset just past the first page's last whole line.
   */
  paging?: { endByte: number; etag: string; size: number };
  read: BFileRead;
}

/** One page of a b-file: its whole lines and where they sit in the file. */
interface BFilePage {
  /** Offset just past the last whole line. */
  endByte: number;
  /**
   * True when the line the page's start cuts runs past the previous page's end, so neither page
   * holds it whole.
   */
  headLost: boolean;
  /** Offset of the first whole line. */
  startByte: number;
  terms: BFileTerm[];
}

type CachedValue =
  | { kind: 'record'; record: SequenceRecord; lastModified?: string }
  | { kind: 'missing' }
  | { kind: 'search'; page: SearchPage }
  | { kind: 'bfile'; head: BFileHead }
  | { kind: 'bfile_page'; page: BFilePage };

/** Cached under a record key while OEIS answers `404` for the A-number. */
const MISSING: CachedValue = { kind: 'missing' };

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

/**
 * Reads a text body of at most `max` bytes. A longer body reads as empty, so each caller sends it
 * down its unreadable-body path: not a JSON record, no `Search:` line, not the sign-in text.
 */
async function readText(res: Response, max: number): Promise<string> {
  const { bytes, overflowed } = await readCapped(res, max);
  return overflowed ? '' : new TextDecoder().decode(bytes);
}

/**
 * Classifies a status outside a path's accept-list from the status code and headers alone: `429`
 * → RateLimited with `retryAfter`, `5xx` → ServiceUnavailable, `3xx` → InvalidRequest. The body is
 * discarded unread and the reason phrase dropped, so the message and data are server-written apart
 * from the `Retry-After` value.
 */
async function unexpectedStatus(res: Response): Promise<McpError> {
  await discard(res);
  const { code, data } = await httpErrorFromResponse(res, {
    service: 'OEIS',
    captureBody: false,
    ...(res.status === 429 && { data: { reason: 'upstream_rate_limited' } }),
  });
  const { statusText: _reasonPhrase, ...rest } = data ?? {};
  return new McpError(code, `OEIS returned HTTP ${res.status}.`, rest);
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

/** The `n a(n)` pairs of whole b-file lines, in order; any other line is skipped. */
function parsePairs(text: string): BFileTerm[] {
  const terms: BFileTerm[] = [];
  for (const line of text.split('\n')) {
    const match = BFILE_LINE.exec(line);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n)) terms.push({ n, value: match[2] ?? '' });
  }
  // Each value is a slice of `text`, and a cached slice keeps the whole decoded page alive.
  return JSON.parse(JSON.stringify(terms)) as BFileTerm[];
}

/** Pairs of a b-file's first page; a `cut` read drops its trailing partial line. */
function parseBFile(text: string, cut: boolean): BFileTerm[] {
  if (HTML_START.test(text)) {
    throw serviceUnavailable(
      'OEIS returned an HTML page in place of a b-file, likely a maintenance page.',
      {
        reason: 'upstream_unparseable',
      },
    );
  }
  return parsePairs(cut ? text.slice(0, text.lastIndexOf('\n') + 1) : text);
}

/**
 * Reads a b-file's first page from a `200`, `206`, or `404`. A `200` is read from the stream up to
 * 1 MiB and then cancelled, so the cap holds either way. Later pages can be read when the file is
 * larger, its size is stated, it carries a strong ETag, and upstream serves byte ranges.
 */
async function readHead(res: Response): Promise<BFileHead> {
  if (res.status === 404) {
    await discard(res);
    return { read: { status: 'missing' } };
  }
  const { bytes, overflowed } = await readCapped(res, BFILE_PAGE_BYTES);
  const text = new TextDecoder().decode(bytes);
  if (SYNTHESIZED_BFILE.test(text)) return { read: { status: 'missing' } };
  const sizeInBytes =
    res.status === 206
      ? headerInt(res.headers.get('content-range')?.split('/')[1] ?? null)
      : headerInt(res.headers.get('content-length'));
  const cut = overflowed || (sizeInBytes !== undefined && sizeInBytes > bytes.length);
  const terms = parseBFile(text, cut);
  const first = terms[0];
  const last = terms.at(-1);
  const etag = res.headers.get('etag');
  const ranged =
    res.status === 206 || res.headers.get('accept-ranges')?.trim().toLowerCase() === 'bytes';
  const paging =
    cut && ranged && sizeInBytes !== undefined && etag !== null && !etag.startsWith('W/')
      ? { endByte: bytes.lastIndexOf(LINE_FEED) + 1, etag, size: sizeInBytes }
      : undefined;
  return {
    read: {
      status: 'ok',
      terms,
      ...(first && { firstIndex: first.n }),
      ...(last && { lastIndex: last.n }),
      ...(sizeInBytes !== undefined && { sizeInBytes }),
      cut,
      ...(cut && !paging && { firstMibOnly: true }),
    },
    ...(paging && { paging }),
  };
}

/**
 * The whole lines of a page read from byte `start`. Its first line is always dropped: a range can
 * open mid-line, and the overlap makes that line whole in the previous page. A trailing partial line
 * is dropped too, unless the page ends the file.
 */
function parsePage(bytes: Uint8Array, start: number, final: boolean): BFilePage {
  const firstBreak = bytes.indexOf(LINE_FEED);
  const from = firstBreak === -1 ? bytes.length : firstBreak + 1;
  const to = Math.max(from, final ? bytes.length : bytes.lastIndexOf(LINE_FEED) + 1);
  return {
    endByte: start + to,
    headLost: firstBreak === -1 || firstBreak >= BFILE_OVERLAP_BYTES,
    startByte: start + from,
    terms: parsePairs(new TextDecoder().decode(bytes.subarray(from, to))),
  };
}

/** Cache key of page `index` (≥ 1) of the version of a b-file with this ETag. */
function pageKey(aNumber: string, index: number, etag: string): string {
  return `bfile:${aNumber}:${index}:${etag}`;
}

/**
 * Where index `n` falls among the known pages: the page holding it, or the nearest pages known to
 * end before it (`below`) and to start after it (`above`, `lastPage + 1` when none does).
 */
function placeAmong(
  pages: ReadonlyMap<number, BFilePage>,
  n: number,
  lastPage: number,
): { holder: number } | { above: number; below: number } {
  let below = -1;
  let above = lastPage + 1;
  for (const [index, page] of pages) {
    const first = page.terms[0];
    const last = page.terms.at(-1);
    if (!first || !last) continue;
    if (first.n <= n && n <= last.n) return { holder: index };
    if (last.n < n) below = Math.max(below, index);
    else above = Math.min(above, index);
  }
  return { above, below };
}

/**
 * The page where the line for index `n` is expected to end (a page holds the lines that end in its
 * own bytes), extrapolated from the end of `page` nearer to `n` at the bytes per index of the tenth
 * of its pairs on that end.
 */
function expectedPage(page: BFilePage, n: number): number {
  const { terms } = page;
  const first = terms[0];
  const last = terms.at(-1);
  if (!first || !last) return 0;
  const forward = n > last.n;
  const k = Math.max(1, Math.floor(terms.length / 10));
  const run = forward ? terms.slice(-k) : terms.slice(0, k);
  let bytes = 0;
  for (const term of run) bytes += String(term.n).length + term.value.length + 2;
  // The run ends at `last` going forward and starts at `first` going back.
  const span = forward ? last.n - (run[0] ?? last).n : (run.at(-1) ?? first).n - first.n;
  const perIndex = bytes / (span + 1);
  const lineEnd = forward
    ? page.endByte + (n - last.n) * perIndex
    : page.startByte - (first.n - n - 1) * perIndex;
  return Math.floor((lineEnd - 1) / BFILE_PAGE_BYTES);
}

/** The unread page strictly between `below` and `above` nearest to `estimate`, if any. */
function pickPage(
  estimate: number,
  below: number,
  above: number,
  pages: ReadonlyMap<number, BFilePage>,
): number | undefined {
  const target = Math.min(above - 1, Math.max(below + 1, estimate));
  for (let step = 0; target - step > below || target + step < above; step++) {
    if (target + step < above && !pages.has(target + step)) return target + step;
    if (target - step > below && !pages.has(target - step)) return target - step;
  }
  return;
}

/** Reads the shared `/search` 403 body: the anonymous paging cap, or an edge refusal. */
async function searchRefusal(res: Response): Promise<McpError> {
  const body = (await readText(res, REFUSAL_MAX_BYTES)).trimStart();
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

  /**
   * The cached record for an A-number while it is fresh (under 24 h old and not expired by a newer
   * search row), without any upstream request.
   * A peek: it leaves the entry's place in the LRU order alone.
   */
  getCachedRecord(aNumber: string): SequenceRecord | undefined {
    const cached = this.cache.peek(`record:${aNumber}`);
    return cached?.value.kind === 'record' && cached.expiresAt > this.now()
      ? cached.value.record
      : undefined;
  }

  /**
   * Fetches and normalizes one record. A cached record is served as-is for 24 h, or until a fresh
   * search row shows a later edit (see `search`); after that it is revalidated with
   * `If-Modified-Since` (a `304` refreshes it without a body). A `404` is remembered for 1 h, or
   * until a fresh search row lists the entry, so a repeated missing A-number makes no further
   * request.
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
    if (cached && cached.expiresAt > this.now()) {
      if (cached.value.kind === 'missing') {
        ctx.log.debug('OEIS record 404 cache hit', { aNumber });
        return;
      }
      if (cached.value.kind === 'record') {
        ctx.log.debug('OEIS record cache hit', { aNumber });
        return cached.value.record;
      }
    }
    const entry = cached?.value.kind === 'record' ? cached.value : undefined;

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
          record: parseRecordBody(await readText(res, RECORD_MAX_BYTES)),
          ...(lastModified && { lastModified }),
        };
      },
      ctx,
      options.deadlineMs,
    );

    if (outcome.kind === 'missing') {
      this.cache.set(key, MISSING, heapCharge(MISSING), this.now() + MISSING_TTL_MS);
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
      heapCharge(fresh.record),
      this.now() + RECORD_TTL_MS,
    );
    return fresh.record;
  }

  /**
   * Runs one `/search?fmt=text` query and parses the page. Pages are cached for 1 h. A freshly
   * fetched page also expires each cached record or `404` its rows prove outdated (see
   * `expireOutdatedRecords`).
   */
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
        return parseSearchText(await readText(res, SEARCH_MAX_BYTES));
      },
      ctx,
      options.deadlineMs,
    );
    this.cache.set(key, { kind: 'search', page }, heapCharge(page), this.now() + SEARCH_TTL_MS);
    this.expireOutdatedRecords(page.rows);
    return page;
  }

  /**
   * Expires what a page's rows prove outdated, so the next record read asks OEIS again: a
   * remembered `404` for an entry a row lists, and a record a row shows a later edit for (compared
   * as instants; that read revalidates with `If-Modified-Since`). Makes no request, and leaves a
   * record alone when either side has no edit time.
   */
  private expireOutdatedRecords(rows: readonly SequenceSummary[]): void {
    for (const { aNumber, modified } of rows) {
      const cached = this.cache.peek(`record:${aNumber}`);
      if (!cached) continue;
      const { value } = cached;
      const outdated =
        value.kind === 'missing' ||
        (value.kind === 'record' &&
          modified !== undefined &&
          value.record.modified !== undefined &&
          Date.parse(modified) > Date.parse(value.record.modified));
      if (outdated) cached.expiresAt = this.now();
    }
  }

  /**
   * Reads an entry's b-file from its canonical path. The first page, bytes 0 to 1 MiB − 1, is read on
   * every call; when `fromIndex` lies past it in a larger file, the page holding it is read as well
   * (see `locate`). Pages are cached for 7 days: the first under the A-number, a later one under its
   * index and the first page's ETag, so no page ever answers for another version of the file.
   *
   * @returns `{ status: 'missing' }` when the entry has no b-file: OEIS answers `404`, or `200` with
   *   a file it synthesized from the data line.
   */
  async getBFile(aNumber: string, ctx: Context, options: BFileOptions = {}): Promise<BFileRead> {
    const startedAt = Date.now();
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const remainingMs = () => Math.max(0, deadlineMs - (Date.now() - startedAt));

    const cached = this.cache.get(`bfile:${aNumber}`);
    let head: BFileHead;
    if (cached?.value.kind === 'bfile' && cached.expiresAt > this.now()) {
      ctx.log.debug('OEIS b-file cache hit', { aNumber });
      head = cached.value.head;
    } else {
      head = await this.call(
        'getBFile',
        bFileUrl(aNumber),
        [200, 206, 404],
        { ...UNENCODED, Range: `bytes=0-${BFILE_PAGE_BYTES - 1}` },
        readHead,
        ctx,
        remainingMs(),
      );
      this.cacheHead(aNumber, head);
    }
    return this.locate(aNumber, head, options.fromIndex, ctx, remainingMs);
  }

  /** Releases the pacer: clears its timer and rejects queued waiters. */
  dispose(): void {
    this.pacer.dispose();
  }

  private cacheHead(aNumber: string, head: BFileHead): void {
    this.cache.set(
      `bfile:${aNumber}`,
      { kind: 'bfile', head },
      heapCharge(head),
      this.now() + BFILE_TTL_MS,
    );
  }

  /**
   * Answers `fromIndex` (the first page when it is unset) from the page of a b-file that holds it. A
   * `200` to a page request means the file changed: its first page replaced the cached one, and the
   * search restarts from it with the reads left, so one answer never mixes two versions of a file.
   */
  private async locate(
    aNumber: string,
    head: BFileHead,
    fromIndex: number | undefined,
    ctx: Context,
    remainingMs: () => number,
  ): Promise<BFileRead> {
    const budget = { reads: 0 };
    let current = head;
    while (true) {
      const step = await this.searchPages(aNumber, current, fromIndex, budget, ctx, remainingMs);
      if ('answer' in step) return step.answer;
      current = step.changed;
    }
  }

  /**
   * Finds the page holding `fromIndex` among the pages known for this version of the file (the
   * first page and any cached ones), reading more until one holds it, the file is known to end
   * before it, or the call's page reads are spent. Each read is picked by extrapolating bytes per
   * index from the page just read (at first, the furthest known page below `fromIndex`), kept
   * strictly between the nearest pages known to end before and to start after it. When `fromIndex`
   * falls between two pages with no unread page between them (a gap in the file's indices, a
   * skipped long line, or pages holding no pairs), the answer starts at the later page's first pair,
   * or reports the file's end when no later page holds one. An unset `fromIndex`, or one inside the
   * first page, is answered from the first page; `lastIndex` and `cut` still describe every page
   * known.
   */
  private async searchPages(
    aNumber: string,
    head: BFileHead,
    fromIndex: number | undefined,
    budget: { reads: number },
    ctx: Context,
    remainingMs: () => number,
  ): Promise<{ answer: BFileRead } | { changed: BFileHead }> {
    const { read, paging } = head;
    if (read.status !== 'ok' || !paging) return { answer: read };
    const lastPage = Math.floor((paging.size - 1) / BFILE_PAGE_BYTES);
    const pages = new Map<number, BFilePage>([
      [
        0,
        {
          endByte: paging.endByte,
          headLost: false,
          startByte: 0,
          terms: read.terms,
        },
      ],
    ]);
    for (let index = 1; index <= lastPage; index++) {
      const cached = this.cache.peek(pageKey(aNumber, index, paging.etag));
      if (cached?.value.kind === 'bfile_page' && cached.expiresAt > this.now()) {
        pages.set(index, cached.value.page);
      }
    }
    const answer = (served?: number, skippedLine = false) => ({
      answer: this.pageRead(aNumber, read, paging, pages, served, skippedLine),
    });
    if (read.lastIndex === undefined || fromIndex === undefined || fromIndex <= read.lastIndex) {
      return answer(0);
    }

    let justRead: BFilePage | undefined;
    while (true) {
      const place = placeAmong(pages, fromIndex, lastPage);
      if ('holder' in place) return answer(place.holder);
      const { above, below } = place;
      let unread = false;
      for (let index = below + 1; index < above && !unread; index++) unread = !pages.has(index);
      // Every page between holds no pairs: the file ends, or its indices skip, before fromIndex.
      if (!unread) {
        return above > lastPage
          ? answer(below)
          : answer(above, pages.get(above)?.headLost === true);
      }
      const source = justRead?.terms.length ? justRead : pages.get(below);
      const pick =
        source && budget.reads < BFILE_MAX_PAGE_READS
          ? pickPage(expectedPage(source, fromIndex), below, above, pages)
          : undefined;
      if (pick === undefined) return answer();
      budget.reads++;
      const page = await this.readPage(aNumber, paging, pick, ctx, remainingMs());
      if ('read' in page) return { changed: page };
      pages.set(pick, page);
      justRead = page;
    }
  }

  /**
   * The read answering from known page `served`, or with no pairs when `fromIndex` was not reached.
   * `lastIndex` is the highest n of any known page, and `cut` holds while a page after the last one
   * holding pairs is unread, so a final page whose pairs all lie in the overlap, or that holds none,
   * still ends the file.
   */
  private pageRead(
    aNumber: string,
    first: BFileOk,
    paging: NonNullable<BFileHead['paging']>,
    pages: ReadonlyMap<number, BFilePage>,
    served: number | undefined,
    skippedLine: boolean,
  ): BFileRead {
    let lastIndex: number | undefined;
    let reachedPage = -1;
    for (const [index, page] of pages) {
      const n = page.terms.at(-1)?.n;
      if (n === undefined) continue;
      lastIndex = Math.max(lastIndex ?? n, n);
      reachedPage = Math.max(reachedPage, index);
    }
    const lastPage = Math.floor((paging.size - 1) / BFILE_PAGE_BYTES);
    let cut = false;
    for (let index = reachedPage + 1; index <= lastPage && !cut; index++) cut = !pages.has(index);
    const page = served === undefined ? undefined : pages.get(served);
    // Mark the served page recently used; the pages were gathered with peek.
    if (served !== undefined && served > 0) this.cache.get(pageKey(aNumber, served, paging.etag));
    const last = page?.terms.at(-1);
    return {
      status: 'ok',
      terms: page?.terms ?? [],
      ...(first.firstIndex !== undefined && { firstIndex: first.firstIndex }),
      ...(lastIndex !== undefined && { lastIndex }),
      ...(last && (cut || last.n !== lastIndex) && { nextIndex: last.n + 1 }),
      sizeInBytes: paging.size,
      cut,
      ...(skippedLine && { skippedLine: true }),
      ...(page === undefined && { unreached: true }),
    };
  }

  /**
   * Reads page `index` (≥ 1) of a b-file by byte range, from 4 KiB before the page's own first byte
   * to its last, clipped to the file, and pinned to the first page's ETag with `If-Range`. A `206`
   * is the page, cached for 7 days under its index and that ETag. A `200` (the ETag no longer
   * matches: the file changed) or a `404` (it was removed) is read as the file's new first page,
   * which replaces the cached one.
   */
  private async readPage(
    aNumber: string,
    paging: NonNullable<BFileHead['paging']>,
    index: number,
    ctx: Context,
    deadlineMs: number,
  ): Promise<BFilePage | BFileHead> {
    const start = index * BFILE_PAGE_BYTES - BFILE_OVERLAP_BYTES;
    const end = Math.min((index + 1) * BFILE_PAGE_BYTES, paging.size) - 1;
    const page = await this.call<BFilePage | BFileHead>(
      'getBFilePage',
      bFileUrl(aNumber),
      [200, 206, 404],
      { ...UNENCODED, Range: `bytes=${start}-${end}`, 'If-Range': paging.etag },
      async (res) => {
        if (res.status !== 206) return readHead(res);
        const etag = res.headers.get('etag');
        if (
          res.headers.get('content-range')?.trim() !== `bytes ${start}-${end}/${paging.size}` ||
          (etag !== null && etag !== paging.etag)
        ) {
          // Not this page of the version page 0 came from: read page 0 again on the next call.
          await discard(res);
          this.cache.delete(`bfile:${aNumber}`);
          throw serviceUnavailable(
            'OEIS answered a b-file range request from another range or version of the file.',
            { reason: 'upstream_unparseable', retryable: false },
          );
        }
        const length = end - start + 1;
        const { bytes, overflowed } = await readCapped(res, length);
        if (overflowed || bytes.length !== length) {
          throw serviceUnavailable(
            'OEIS answered a b-file range request with a body of the wrong length.',
            { reason: 'upstream_unparseable' },
          );
        }
        return parsePage(bytes, start, end === paging.size - 1);
      },
      ctx,
      deadlineMs,
    );
    if ('read' in page) {
      this.cacheHead(aNumber, page);
    } else {
      this.cache.set(
        pageKey(aNumber, index, paging.etag),
        { kind: 'bfile_page', page },
        heapCharge(page),
        this.now() + BFILE_TTL_MS,
      );
    }
    return page;
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
   * unlisted `403` is an edge refusal, and anything else is classified from its status and
   * headers — a `429` with `reason: 'upstream_rate_limited'` beside the `retryAfter` it carries.
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
        throw await unexpectedStatus(res);
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
