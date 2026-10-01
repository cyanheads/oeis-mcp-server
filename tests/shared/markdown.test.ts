/**
 * @fileoverview Tests for the shared markdown helpers: inline flattening, blockquotes, markup
 * escaping, dynamic-length fences, and the summary-row block. CR/LF in upstream text must stay out
 * of inline slots, and link, image, and HTML syntax must render as text.
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

describe('markup in contributor text', () => {
  const MIB = 1024 * 1024;

  /** Each link, image, or HTML opener in `text` that no odd run of backslashes escapes. */
  const liveMarkup = (text: string) =>
    [...text.matchAll(/(?<!\\)(?:\\\\)*(?:\]\(|<[A-Za-z/!?])|!\[/g)].map((match) => match[0]);

  it.each([
    'Evil ![beacon](https://attacker.example/b.png?v=1) [docs](https://attacker.example/x)',
    '[harmless-looking](javascript:alert(4))',
    '<img src=x onerror=alert(1)> <iframe src="javascript:alert(3)"></iframe>',
    '<https://attacker.example/autolink> <!-- comment --> <?php ?> <!DOCTYPE html>',
    '\\[x](u) and [y\\\\](v) and \\\\<b>bold\\\\</b>',
    'line one\n<div>\n[two](https://attacker.example)\r\n![three](x)',
  ])('leaves no live link, image, or tag in %j, inline or quoted', (text) => {
    expect(liveMarkup(inline(text))).toEqual([]);
    expect(liveMarkup(blockquote(text))).toEqual([]);
  });

  it.each([
    ['see [docs](https://e.example/x)', 'see [docs\\](https://e.example/x)'],
    ['![b](https://e.example/b.png)', '!\\[b\\](https://e.example/b.png)'],
    ['<img src=x onerror=alert(1)>', '\\<img src=x onerror=alert(1)>'],
    ['a </a> b', 'a \\</a> b'],
    ['<!-- c --> <?x?>', '\\<!-- c --> \\<?x?>'],
    ['<https://e.example>', '\\<https://e.example>'],
    ['a(n) = [x^n](1 + x + x^2)^n', 'a(n) = [x^n\\](1 + x + x^2)^n'],
  ])('escapes only the character that opens the markup in %j', (text, expected) => {
    expect(inline(text)).toBe(expected);
  });

  it.each([
    ['\\[x](u)', '\\[x\\](u)'],
    ['[x\\](u)', '[x\\](u)'],
    ['[x\\\\](u)', '[x\\\\\\](u)'],
    ['\\<b>', '\\<b>'],
    ['\\\\<b>', '\\\\\\<b>'],
    ['\\\\\\![i](u)', '\\\\\\!\\[i\\](u)'],
  ])('counts the backslash run before an opener in %j', (text, expected) => {
    expect(inline(text)).toBe(expected);
  });

  it.each([
    ['[x]: https://e.example', '\\[x]: https://e.example'],
    ['[a\\]b]: javascript:x', '\\[a\\]b]: javascript:x'],
    ['[a](b)]: c', '\\[a\\](b)]: c'],
  ])('escapes the bracket that opens a link reference definition in %j', (text, expected) => {
    expect(inline(text)).toBe(expected);
  });

  it('escapes a link reference definition on any quoted line, inside nested containers, or across lines', () => {
    expect(blockquote('first line\n[x]: https://e.example "t"')).toBe(
      '> first line\n> \\[x]: https://e.example "t"',
    );
    expect(blockquote('> - [x]: https://e.example')).toBe('> > - \\[x]: https://e.example');
    expect(blockquote('[multi\nline]: https://e.example')).toBe(
      '> \\[multi\n> line]: https://e.example',
    );
  });

  it.each([
    'a(n) < 2^n for n >= 1.',
    'a(n) <= 2*a(n-1) <= 4^n; 0 < k < n; a(n) > 0; x<>y; p <=> q; n <- n+1.',
    'a(n) = [x^n] 1/(1 - x - x^2).',
    '[x^n] f(x) = Sum_{k=0..floor(n/2)} binomial(n-k, k).',
    'T(n,k) = [k <= n] * binomial(n,k); a(n) = n*[n odd].',
    'G.f.: x/(1 - x - x^2). E.g.f.: exp(x/2)*sinh(sqrt(5)*x/2).',
    'Table[Fibonacci[n], {n, 0, 40}]; a[n_] := a[n-1] + a[n-2]',
    'a(n) ~ phi^n/sqrt(5) as n -> oo, where phi = (1+sqrt(5))/2; 3! = 6, [1, 2], [3, 5, 8].',
    '(PARI) a(n) = if(n<1, 0, fibonacci(n)) \\\\ a comment',
  ])('leaves the formula %j exactly as written', (text) => {
    expect(inline(text)).toBe(text);
    expect(blockquote(text)).toBe(`> ${text}`);
  });

  it.each([
    ['a backslash run before a link', `${'\\'.repeat(MIB - 2)}](`],
    ['brackets before one definition colon', `${'['.repeat(MIB - 2)}]:`],
    ['repeated link openers', '](!['.repeat(MIB / 4)],
    ['repeated tag openers', '<a '.repeat(MIB / 4)],
    ['bracketed lines', '[\n'.repeat(MIB / 2)],
  ])('escapes 1 MiB of %s in linear time', (_shape, text) => {
    for (const render of [inline, blockquote]) {
      const started = performance.now();
      render(text);
      expect(performance.now() - started).toBeLessThan(250);
    }
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
