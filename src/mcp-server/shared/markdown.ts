/**
 * @fileoverview Markdown rendering helpers for OEIS text. Contributor-written text renders as code:
 * a code span in an inline slot, a dynamic-length fence for line sections, so a renderer shows it
 * exactly as written and reads none of it as markup. Upstream tokens and server-written text render
 * through `inline()`. Also the shared summary-row block.
 * @module mcp-server/shared/markdown
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { SequenceSummarySchema } from './oeis-schemas.js';

/** A character after `<` that opens a tag, a closing tag, a comment or declaration, or an autolink. */
const TAG_START = /[A-Za-z/!?]/;

/**
 * Backslash-escapes the characters that would make the text a link, an image, a link reference
 * definition, or HTML: the `]` of `](`, the `[` of `![`, a `[` whose label closes with
 * `]:`, and a `<` before a letter, `/`, `!`, or `?`. A character that an odd run of backslashes
 * already escapes stays as written, and an even run gets one more backslash. Everything else is
 * left exactly as written, so `a(n) < 2^n`, `[x^n] f(x)`, and `floor(n/2)` read unchanged. Linear
 * in the text.
 */
function escapeMarkup(text: string): string {
  /** Each `]` that still closes a bracket once every `](` is escaped. */
  const closers: number[] = [];
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ']' && run % 2 === 0 && text[i + 1] !== '(') closers.push(i);
    run = text[i] === '\\' ? run + 1 : 0;
  }

  let next = 0;
  const opensMarkup = (i: number): boolean => {
    switch (text[i]) {
      case ']':
        return text[i + 1] === '(';
      case '<':
        return TAG_START.test(text[i + 1] ?? '');
      case '[': {
        while ((closers[next] ?? Number.POSITIVE_INFINITY) < i) next++;
        const closer = closers[next];
        return text[i - 1] === '!' || (closer !== undefined && text[closer + 1] === ':');
      }
      default:
        return false;
    }
  };

  let out = '';
  let from = 0;
  run = 0;
  for (let i = 0; i < text.length; i++) {
    if (run % 2 === 0 && opensMarkup(i)) {
      out += `${text.slice(from, i)}\\`;
      from = i;
    }
    run = text[i] === '\\' ? run + 1 : 0;
  }
  return out + text.slice(from);
}

/**
 * Each run of CR, LF, and the line and paragraph separators (U+2028, U+2029) flattened to one
 * space, so the text cannot end its line: marked ends an ATX heading at either separator, leaving
 * the heading as a paragraph.
 */
function flatten(text: string): string {
  return text.replace(/[\r\n\p{Zl}\p{Zp}]+/gu, ' ');
}

/** The length of the longest run of backticks in the text. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
}

/**
 * Renders an upstream token or server-written text for an inline slot (keywords, offset, legacy
 * IDs, dates, terms, program languages, reference tables): line breaks flattened to a space, then
 * link, image, and HTML syntax escaped. Contributor-written text goes through {@link codeSpan} instead.
 */
export function inline(text: string): string {
  return escapeMarkup(flatten(text));
}

/**
 * Renders contributor-written text or a URL for an inline slot (headings, bold labels, list items)
 * as a code span, so a renderer shows it exactly as written. Line breaks are flattened to a space,
 * so the text cannot end a heading or start a list item; the delimiter is one backtick longer than any run
 * in the text, so none closes it. Text that starts or ends with a backtick or a space is padded
 * with one space on each side, which the renderer strips again; text of spaces alone needs none.
 * Empty text renders as nothing.
 */
export function codeSpan(text: string): string {
  const flat = flatten(text);
  if (!flat) return '';
  const ticks = '`'.repeat(longestBacktickRun(flat) + 1);
  const pad = /^[ `]|[ `]$/.test(flat) && /[^ ]/.test(flat) ? ' ' : '';
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/** Wraps text in a code fence one backtick longer than its longest backtick run (minimum 3). */
export function fence(code: string): string {
  const marker = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
  return `${marker}\n${code}\n${marker}`;
}

/** The offset line of an entry or row; a reserved or recycled A-number has no offset. */
export function offsetLine(offset: string | undefined, firstIndex: number | undefined): string {
  return offset === undefined || firstIndex === undefined
    ? '**Offset:** none (reserved or recycled A-number)'
    : `**Offset:** ${inline(offset)} (first term is a(${firstIndex}))`;
}

/**
 * Renders the detail lines of one summary row: terms, offset, keywords, then the author, legacy IDs,
 * and last edit when the row carries them, then the URL.
 */
export function summaryLines(row: z.infer<typeof SequenceSummarySchema>): string[] {
  return [
    `**Terms:** ${row.terms.length ? inline(row.terms.join(', ')) : 'none listed'}`,
    offsetLine(row.offset, row.firstIndex),
    `**Keywords:** ${row.keywords.length ? inline(row.keywords.join(', ')) : 'none'}`,
    ...(row.author ? [`**Author:** ${codeSpan(row.author)}`] : []),
    ...(row.legacyIds ? [`**Legacy IDs:** ${inline(row.legacyIds.join(', '))}`] : []),
    ...(row.modified ? [`**Modified:** ${inline(row.modified)}`] : []),
    `**URL:** ${row.url}`,
  ];
}
