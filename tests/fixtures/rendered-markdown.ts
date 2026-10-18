/**
 * @fileoverview Renders `content[]` markdown the way a client does, with marked in GFM mode, and
 * reads back what a viewer sees: the visible text and the elements the markup produced.
 * @module tests/fixtures/rendered-markdown
 */

import { marked } from 'marked';

/** The entities marked writes for `&`, `<`, `>`, `"`, and `'` in text, code, and attributes. */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** One markdown document as marked renders it. */
export interface Rendered {
  /** The HTML marked produced. */
  html: string;
  /** What a viewer reads: every tag removed, then marked's entities decoded in one pass. */
  text: string;
}

/** The text a viewer reads in an HTML fragment. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Renders markdown with marked (`gfm: true`), as a client showing `content[]` would. */
export function render(markdown: string): Rendered {
  const html = marked.parse(markdown, { gfm: true, async: false });
  return { html, text: visibleText(html) };
}

/** The opening tag of each `tag` element in the HTML, in document order. */
export function elements(html: string, tag: string): string[] {
  return html.match(new RegExp(`<${tag}(?=[\\s>])[^>]*>`, 'g')) ?? [];
}

/** The visible text of each `code` element (span or block), in document order. */
export function codeTexts(html: string): string[] {
  return [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map(([, inner]) =>
    visibleText(inner ?? ''),
  );
}

/** Each heading as `h<level> <visible text>`, in document order. */
export function headings(html: string): string[] {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map(
    ([, level, inner]) => `h${level} ${visibleText(inner ?? '')}`,
  );
}
