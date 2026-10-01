/**
 * @fileoverview A scripted `fetch` fake for driving `OeisService` through its constructor seam:
 * records every call and answers from a per-call script of responses or thrown errors.
 * @module tests/fixtures/scripted-fetch
 */

import { vi } from 'vitest';

/** One captured `fetch` call. */
export interface FetchCall {
  headers: Headers;
  init: RequestInit;
  url: string;
}

/** A scripted step: a response factory (bodies are single-use) or an error to throw. */
export type FetchStep = (() => Response | Promise<Response>) | Error;

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
    calls.push({ url: String(input), init, headers: new Headers(init.headers) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === undefined) throw new Error('scriptedFetch called with an empty script');
    if (step instanceof Error) throw step;
    return step();
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
    return new Promise<Response>((_, reject) => {
      const signal = init.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  return { calls, fetch: fn as unknown as typeof globalThis.fetch, started: started.promise };
}
