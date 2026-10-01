/**
 * @fileoverview Markdown rendering helpers for upstream-authored OEIS text: inline flattening,
 * blockquotes, dynamic-length code fences, and the shared summary-row block. Inline slots and
 * blockquotes escape link, image, and HTML syntax so contributor text renders as written.
 * @module mcp-server/shared/markdown
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { SequenceSummarySchema } from './oeis-schemas.js';

/** A character after `<` that opens a tag, a closing tag, a comment or declaration, or an autolink. */
const TAG_START = /[A-Za-z/!?]/;

/**
 * Backslash-escapes the characters that would make contributor text a link, an image, a link
 * reference definition, or HTML: the `]` of `](`, the `[` of `![`, a `[` whose label closes with
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
 * Renders text for an inline slot (headings, bold labels, list items): CR/LF flattened to a space,
 * then link, image, and HTML syntax escaped.
 */
export function inline(text: string): string {
  return escapeMarkup(text.replace(/[\r\n]+/g, ' '));
}

/** Renders text as a blockquote, one `> ` line per source line, with markup escaped as in `inline`. */
export function blockquote(text: string): string {
  return escapeMarkup(text)
    .split(/\r\n|\r|\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Wraps text in a code fence one backtick longer than its longest backtick run (minimum 3). */
export function fence(code: string): string {
  let longest = 0;
  for (const run of code.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}\n${code}\n${marker}`;
}

/** The offset line of an entry or row; a reserved or recycled A-number has no offset. */
export function offsetLine(offset: string | undefined, firstIndex: number | undefined): string {
  return offset === undefined || firstIndex === undefined
    ? '**Offset:** none (reserved or recycled A-number)'
    : `**Offset:** ${inline(offset)} (first term is a(${firstIndex}))`;
}

/** Renders the detail lines of one summary row (terms, offset, keywords, URL). */
export function summaryLines(row: z.infer<typeof SequenceSummarySchema>): string[] {
  return [
    `**Terms:** ${row.terms.length ? inline(row.terms.join(', ')) : 'none listed'}`,
    offsetLine(row.offset, row.firstIndex),
    `**Keywords:** ${row.keywords.length ? inline(row.keywords.join(', ')) : 'none'}`,
    `**URL:** ${row.url}`,
  ];
}
