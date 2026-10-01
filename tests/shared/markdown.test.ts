/**
 * @fileoverview Tests for the shared markdown helpers: inline flattening, blockquotes,
 * dynamic-length fences, and the summary-row block. CR/LF in upstream text must stay out of
 * inline slots.
 * @module tests/shared/markdown.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { blockquote, fence, inline, summaryLines } from '@/mcp-server/shared/markdown.js';
import type { SequenceSummarySchema } from '@/mcp-server/shared/oeis-schemas.js';

type Row = z.infer<typeof SequenceSummarySchema>;

const row: Row = {
  aNumber: 'A000108',
  name: 'Catalan numbers',
  terms: ['1', '1', '2', '5'],
  offset: '0,3',
  firstIndex: 0,
  keywords: ['core', 'nonn'],
  url: 'https://oeis.org/A000108',
};

describe('inline', () => {
  it('leaves single-line text alone', () => {
    expect(inline('Catalan numbers: C(n)')).toBe('Catalan numbers: C(n)');
  });

  it.each([
    ['a\nb', 'a b'],
    ['a\r\nb', 'a b'],
    ['a\rb', 'a b'],
    ['a\n\n\r\nb', 'a b'],
    ['\nstart', ' start'],
    ['end\r\n', 'end '],
  ])('flattens %j to %j', (input, expected) => {
    expect(inline(input)).toBe(expected);
  });

  it('removes every line break', () => {
    expect(inline('x\ny\r\nz\rw')).not.toMatch(/[\r\n]/);
  });
});

describe('blockquote', () => {
  it('prefixes every line, whatever the line ending', () => {
    expect(blockquote('one')).toBe('> one');
    expect(blockquote('one\ntwo')).toBe('> one\n> two');
    expect(blockquote('one\r\ntwo')).toBe('> one\n> two');
    expect(blockquote('one\rtwo')).toBe('> one\n> two');
  });

  it('keeps blank lines inside the quote', () => {
    expect(blockquote('a\n\nb')).toBe('> a\n> \n> b');
  });

  it('leaves no unquoted line when upstream text tries to start a heading or list', () => {
    const lines = blockquote('# heading\r\n- item\r\n---').split('\n');
    expect(lines.every((line) => line.startsWith('> '))).toBe(true);
  });
});

describe('fence', () => {
  it('wraps code in a three-backtick fence by default', () => {
    expect(fence('a(n) = n')).toBe('```\na(n) = n\n```');
  });

  it('keeps the minimum of three when the code has one or two backticks', () => {
    expect(fence('`x`').startsWith('```\n')).toBe(true);
    expect(fence('``x``').startsWith('```\n')).toBe(true);
  });

  it('uses a marker one longer than the longest backtick run', () => {
    expect(fence('a ``` b').startsWith('````\n')).toBe(true);
    expect(fence('a ```` b ``` c').startsWith('`````\n')).toBe(true);
    expect(fence('`````````').startsWith(`${'`'.repeat(10)}\n`)).toBe(true);
  });

  it('closes with the same marker it opened with and preserves whitespace inside', () => {
    const code = '  1\n 1 1\n1 2 1 ```\n';
    const out = fence(code);
    const marker = out.slice(0, out.indexOf('\n'));
    expect(marker).toBe('````');
    expect(out.endsWith(`\n${marker}`)).toBe(true);
    expect(out.slice(marker.length + 1, -(marker.length + 1))).toBe(code);
  });
});

describe('summaryLines', () => {
  it('renders terms, offset with the first index, keywords, and the URL', () => {
    expect(summaryLines(row)).toEqual([
      '**Terms:** 1, 1, 2, 5',
      '**Offset:** 0,3 (first term is a(0))',
      '**Keywords:** core, nonn',
      '**URL:** https://oeis.org/A000108',
    ]);
  });

  it('says so when there are no terms or keywords', () => {
    const lines = summaryLines({ ...row, terms: [], keywords: [] });
    expect(lines[0]).toBe('**Terms:** none listed');
    expect(lines[2]).toBe('**Keywords:** none');
  });

  it('keeps CR/LF in upstream-sourced tokens out of every line', () => {
    const lines = summaryLines({
      ...row,
      terms: ['1\r\n- injected', '2'],
      offset: '0,3\n# heading',
      keywords: ['core\rnonn'],
    });
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe('**Terms:** 1 - injected, 2');
    expect(lines[1]).toContain('0,3 # heading');
    expect(lines[2]).toBe('**Keywords:** core nonn');
  });

  it('renders a negative first index as given', () => {
    expect(summaryLines({ ...row, offset: '-2,1', firstIndex: -2 })[1]).toBe(
      '**Offset:** -2,1 (first term is a(-2))',
    );
  });
});
