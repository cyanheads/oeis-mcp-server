/**
 * @fileoverview A scripted `fetch` fake for driving `OeisService` through its constructor seam:
 * records every call and answers from a per-call script of responses or thrown errors, plus a step
 * that serves a file by byte range the way oeis.org serves b-files.
 * @module tests/fixtures/scripted-fetch
 */

import { vi } from 'vitest';

/** One captured `fetch` call. */
export interface FetchCall {
  headers: Headers;
  init: RequestInit;
  url: string;
}

/**
 * A scripted step: a response factory (bodies are single-use), handed the call it answers, or an
 * error to throw.
 */
export type FetchStep = ((call: FetchCall) => Response | Promise<Response>) | Error;

/** Response factory: `res('body', { status: 404 })`. */
export function res(
  body: ConstructorParameters<typeof Response>[0],
  init?: ResponseInit,
): FetchStep {
  return () => new Response(body, init);
}

/**
 * A fetch fake that answers call `i` with `steps[i]`, repeating the last step once the script
 * runs out. An `Error` step is thrown from `fetch`.
 */
export function scriptedFetch(...steps: FetchStep[]) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init, headers: new Headers(init.headers) };
    calls.push(call);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === undefined) throw new Error('scriptedFetch called with an empty script');
    if (step instanceof Error) throw step;
    return step(call);
  });
  return { calls, fetch: fn as unknown as typeof globalThis.fetch, fn };
}

/** A fetch that never answers until its request signal aborts, then rejects with the reason. */
export function hangingFetch() {
  const started = Promise.withResolvers<void>();
  const calls: FetchCall[] = [];
  const fn = vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, headers: new Headers(init.headers) });
    started.resolve();
    return hang(init.signal);
  });
  return { calls, fetch: fn as unknown as typeof globalThis.fetch, started: started.promise };
}

/** A response that never arrives: rejects with the signal's reason once it aborts. */
export function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** One version of a file a {@link rangedFile} step serves. */
export interface FileVersion {
  body: string;
  /** Strong ETag, quotes included: `"935323c7…"`. */
  etag: string;
}

/**
 * A step serving `state.version` the way oeis.org served real b-files on 2026-10-01 and 2026-10-02:
 * a satisfiable `Range` answers `206` with `Content-Range: bytes a-e/size` (the end clipped to the
 * file), the ETag, and `Accept-Ranges: bytes`; a range starting past the end answers `416` with an
 * XML body and no `Content-Range`; an `If-Range` other than the current ETag (checked before the
 * range, so even a range past the end), or no `Range`, answers `200` with the whole file. That `200`
 * carries `Content-Length`, `Accept-Ranges`, and the strong ETag only to a request sending
 * `Accept-Encoding: identity`; to any other it comes compressed, with none of the three and a weak
 * ETag (fetch decodes the body, so the text is the same). Assign `state.version` to change the file
 * between requests.
 */
export function rangedFile(version: FileVersion) {
  const state = { version };
  let encodedFor: string | undefined;
  let bytes = new Uint8Array(0);
  const step = ({ headers }: FetchCall): Response => {
    const { body, etag } = state.version;
    if (encodedFor !== body) {
      bytes = new TextEncoder().encode(body);
      encodedFor = body;
    }
    const common = {
      'accept-ranges': 'bytes',
      'content-type': 'text/plain; charset=utf-8',
      etag,
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('range') ?? '');
    const ifRange = headers.get('if-range');
    if (!range || (ifRange !== null && ifRange !== etag)) {
      if (headers.get('accept-encoding') !== 'identity') {
        return new Response(bytes, {
          status: 200,
          headers: { 'content-type': common['content-type'], etag: `W/${etag}` },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: { ...common, 'content-length': String(bytes.length) },
      });
    }
    const start = Number(range[1]);
    if (start >= bytes.length) {
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidRange</Code></Error>',
        {
          status: 416,
          headers: { 'content-type': 'application/xml' },
        },
      );
    }
    const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { ...common, 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    });
  };
  return { state, step };
}
