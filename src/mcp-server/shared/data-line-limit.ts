/**
 * @fileoverview The data-line limit of OEIS term matching: a run of terms is matched only within
 * each entry's data line, never its b-file. Supplies the trigger that flags a zero-hit run as likely
 * past every data line and the sentence the term-matching tools add to their zero-hit notice.
 * @module mcp-server/shared/data-line-limit
 */

/** About the longest data line OEIS stores, comma-joined with signs (measured maximum 269). */
const DATA_LINE_CHARS = 270;
/** The smallest 10-digit magnitude; a run whose nonzero terms all reach it often lies past the data line. */
const LARGE_TERM = 1_000_000_000n;
/** The smallest 4-digit magnitude; five or more terms past it within 10% of each other rarely fit a data line. */
const SLOW_TERM = 1_000n;

/** The zero-hit sentence naming the data-line limit, added when {@link likelyPastDataLine} holds. */
export const DATA_LINE_SENTENCE = `OEIS matches only the first terms of each entry (its data line, at most about ${DATA_LINE_CHARS} characters), so a long run or one from far into a sequence is not found; give about 6 of the earliest terms you have.`;

/**
 * Whether a run of terms (integers, or `_` for an unknown term) likely lies past every data line:
 * every nonzero term has 10 or more digits, counted on its absolute value with `_` and `0` skipped
 * (so a run of only those never qualifies); five or more terms, all of 4 or more digits (no `_`),
 * whose largest is at most 1.1 times the smallest, as a slowly growing sequence has far past its
 * start; or the terms joined with commas run past 270 characters. A hint, not a test: it only
 * decides whether a zero-hit notice names the limit.
 */
export function likelyPastDataLine(terms: readonly string[]): boolean {
  const magnitudes = terms
    .filter((term) => term !== '_')
    .map((term) => {
      const value = BigInt(term);
      return value < 0n ? -value : value;
    })
    .filter((value) => value !== 0n);
  const low = magnitudes.reduce((a, b) => (b < a ? b : a), magnitudes[0] ?? 0n);
  const high = magnitudes.reduce((a, b) => (b > a ? b : a), 0n);
  return (
    (magnitudes.length > 0 && magnitudes.every((value) => value >= LARGE_TERM)) ||
    (terms.length >= 5 &&
      magnitudes.length === terms.length &&
      low >= SLOW_TERM &&
      high * 10n <= low * 11n) ||
    terms.join(',').length > DATA_LINE_CHARS
  );
}
