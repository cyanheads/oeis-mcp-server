/**
 * @fileoverview Markdown rendering helpers for upstream-authored OEIS text: inline flattening,
 * blockquotes, dynamic-length code fences, and the shared summary-row block.
 * @module mcp-server/shared/markdown
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { SequenceSummarySchema } from './oeis-schemas.js';

/** Flattens CR/LF to a space for inline slots: headings, bold labels, list items. */
export function inline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

/** Renders text as a blockquote, one `> ` line per source line. */
export function blockquote(text: string): string {
  return text
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
