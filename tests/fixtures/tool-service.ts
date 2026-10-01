/**
 * @fileoverview Shared setup for tool tests: an immediate pacer and a real `OeisService` built over
 * a scripted fetch, so a tool handler runs its production path against fixture bodies.
 * @module tests/fixtures/tool-service
 */

import type { Pacer } from '@cyanheads/mcp-ts-core/utils';
import { vi } from 'vitest';
import { OeisService } from '@/services/oeis/oeis-service.js';
import { type FetchCall, type FetchStep, scriptedFetch } from './scripted-fetch.js';

/** A pacer that runs every task at once, so a test never waits out the 10 s start gap. */
export function immediatePacer(): Pacer {
  const run = vi.fn(
    (task: (signal: AbortSignal) => Promise<unknown>, options?: { signal?: AbortSignal }) =>
      task(options?.signal ?? new AbortController().signal),
  );
  return {
    cooldown: { consecutive: 0, remainingMs: 0 },
    dispose: vi.fn(),
    run,
    [Symbol.dispose]: vi.fn(),
  } as unknown as Pacer;
}

/** A real service over a scripted fetch and an immediate pacer, plus the calls it makes. */
export function serviceOver(...steps: FetchStep[]): { calls: FetchCall[]; service: OeisService } {
  const { calls, fetch } = scriptedFetch(...steps);
  return { calls, service: new OeisService({ fetch, pacer: immediatePacer() }) };
}

/** The decoded query string of a captured upstream call. */
export function queryOf(call: FetchCall | undefined): URLSearchParams {
  return new URL(call?.url ?? 'https://invalid.test/').searchParams;
}

/** The text of every text block a `format()` call returns, joined by newlines. */
export function blocksText(blocks: readonly { type: string }[] | undefined): string {
  return (blocks ?? []).map((block) => ('text' in block ? String(block.text) : '')).join('\n');
}

/** Runs a promise to settlement while fake timers advance past every retry backoff. */
export async function withBackoff<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  const outcome = await settled;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
