/**
 * @fileoverview Tests for the shared markdown helpers: code spans and fences for contributor text,
 * inline flattening and markup escaping for upstream tokens, and the summary-row block. Contributor
 * text must render exactly as written, read by marked in GFM mode; CR/LF must stay out of inline
 * slots; link, image, and HTML syntax in a token must render as text. Every scan is linear.
 * @module tests/shared/markdown.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { codeSpan, fence, inline, summaryLines } from '@/mcp-server/shared/markdown.js';
import type { SequenceSummarySchema } from '@/mcp-server/shared/oeis-schemas.js';
import { cpuMs } from '../fixtures/cpu-time.js';
import { codeTexts, elements, headings, render } from '../fixtures/rendered-markdown.js';

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

const MIB = 1024 * 1024;

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR: marked ends a heading at either. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/**
 * Contributor text a markdown renderer would read as markup: emphasis, strikethrough, a link, an
 * image, HTML, a link reference definition, headings, a quote marker, list markers, entities,
 * backslash escapes, and backtick runs of every length.
 */
const MARKUP = [
  'Factorial numbers: n! = 1*2*3*4*...*n (order of symmetric group S_n, number of permutations of n letters).',
  'a(n) = binomial(2*n, n)/(n+1) = (2*n)!/(n!*(n+1)!) = A000984(n)/(n+1).',
  '`1234, `2`134, `23`14',
  '```',
  'a `b` ``c`` d',
  '[x](https://e.example)',
  '![i](https://e.example/i.png)',
  '<img src=x>',
  '[ref]: https://e.example',
  '# heading',
  '## subheading',
  '> quoted',
  '- item',
  '1. first',
  '~~struck~~ _under_ __strong__ \\*kept\\* &amp; &lt;b&gt; https://e.example/auto',
  ' leading and trailing spaces ',
  '   ',
];

/**
 * Asserts `run` takes time linear in its input: each doubling of `shape` from `from` characters to
 * 64 times that stays under the CPU bound before the next size is tried, and over the full span the
 * cost grows less than 256-fold (64-fold when linear, 4,096-fold when quadratic).
 */
function expectLinear(
  run: (text: string) => unknown,
  shape: (chars: number) => string,
  from: number,
) {
  const REPEAT = 20;
  const SAMPLES = 3;
  const fastest: number[] = [];
  run(shape(from));
  for (let chars = from; chars <= from * 64; chars *= 2) {
    const text = shape(chars);
    const spent = Array.from({ length: SAMPLES }, () =>
      cpuMs(() => {
        for (let i = 0; i < REPEAT; i++) run(text);
      }),
    );
    const ms = Math.min(...spent);
    expect(ms, `${chars} characters`).toBeLessThan(1_000);
    fastest.push(ms);
  }
  expect((fastest.at(-1) ?? Number.NaN) / (fastest[0] ?? Number.NaN)).toBeLessThan(256);
}

/**
 * Inputs for the linear-time tests, each sized to `chars`: a digit run that no scan stops in, then
 * backtick runs, line breaks, and the two interleaved. The digit run carries the full 64× span from
 * 5,000 characters; the others stop at 64,000, below Bun's regex slow-mode switch.
 */
const SHAPES: [string, (chars: number) => string, number][] = [
  ['a digit run', (chars) => '9'.repeat(chars), 5_000],
  ['one backtick run', (chars) => '`'.repeat(chars), 1_000],
  ['alternating backticks', (chars) => '`a'.repeat(chars / 2), 1_000],
  ['growing backtick runs', (chars) => '`a``a```a'.repeat(chars / 9), 1_000],
  ['line breaks after text', (chars) => `${'§1 x'.repeat(chars / 4)}\ny`, 1_000],
  ['backticks between line breaks', (chars) => '`\r\n'.repeat(chars / 3), 1_000],
];

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

describe('markup in an upstream token', () => {
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
  ])('leaves no live link, image, or tag in %j', (text) => {
    expect(liveMarkup(inline(text))).toEqual([]);
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
    ['[multi\nline]: https://e.example', '\\[multi line]: https://e.example'],
  ])('escapes the bracket that opens a link reference definition in %j', (text, expected) => {
    expect(inline(text)).toBe(expected);
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
  ])('leaves %j exactly as written', (text) => {
    expect(inline(text)).toBe(text);
  });

  it.each([
    ['a backslash run before a link', `${'\\'.repeat(MIB - 2)}](`],
    ['brackets before one definition colon', `${'['.repeat(MIB - 2)}]:`],
    ['repeated link openers', '](!['.repeat(MIB / 4)],
    ['repeated tag openers', '<a '.repeat(MIB / 4)],
    ['bracketed lines', '[\n'.repeat(MIB / 2)],
  ])('escapes 1 MiB of %s in linear time', (_shape, text) => {
    expect(cpuMs(() => inline(text))).toBeLessThan(1_000);
  });
});

describe('codeSpan', () => {
  it.each([
    ['Catalan numbers', '`Catalan numbers`'],
    ['a `b` c', '``a `b` c``'],
    ['a `b` ``c`` d', '```a `b` ``c`` d```'],
    ['`1234, `2`134, `23`14', '`` `1234, `2`134, `23`14 ``'],
    ['```', '```` ``` ````'],
    ['x `', '`` x ` ``'],
    [' x', '`  x `'],
    ['x ', '` x  `'],
    ['   ', '`   `'],
    ['https://example.org/a``b', '```https://example.org/a``b```'],
  ])('renders %j as %j', (text, expected) => {
    expect(codeSpan(text)).toBe(expected);
  });

  it.each([
    ['a\nb', '`a b`'],
    ['a\r\nb', '`a b`'],
    ['a\rb', '`a b`'],
    ['a\n\n\r\nb', '`a b`'],
    ['Name\r\n# Injected', '`Name # Injected`'],
    [`a${LS}b${PS}\nc`, '`a b c`'],
  ])('flattens the line breaks in %j to one space', (text, expected) => {
    expect(codeSpan(text)).toBe(expected);
  });

  it('renders empty text as nothing', () => {
    expect(codeSpan('')).toBe('');
  });

  it.each(MARKUP)('renders %j verbatim in a heading, a bold label, and a list item', (text) => {
    const span = codeSpan(text);
    const heading = render(`# A000001: ${span}`).html;
    expect(headings(heading)).toEqual([`h1 A000001: ${text}`]);
    expect(codeTexts(heading)).toEqual([text]);

    const label = render(`**Author:** ${span}`).html;
    expect(codeTexts(label)).toEqual([text]);
    expect(elements(label, 'strong')).toHaveLength(1);

    const item = render(`- ${span} — ${codeSpan('https://e.example/u')}`).html;
    expect(codeTexts(item)).toEqual([text, 'https://e.example/u']);
    expect(elements(item, 'li')).toHaveLength(1);

    for (const html of [heading, label, item]) {
      for (const tag of ['a', 'img', 'em', 'del', 'ol', 'h2', 'blockquote']) {
        expect(elements(html, tag), tag).toEqual([]);
      }
    }
  });

  it('renders text with line breaks as its flattened line, in the slot it was given', () => {
    const html = render(`# A000001: ${codeSpan('Name\r\n## Injected heading\n- item')}`).html;
    expect(headings(html)).toEqual(['h1 A000001: Name ## Injected heading - item']);
    expect(elements(html, 'li')).toEqual([]);
    const separators = render(`# A000001: ${codeSpan(`Name${LS}line${PS}paragraph`)}`).html;
    expect(headings(separators)).toEqual(['h1 A000001: Name line paragraph']);
  });

  it.each([
    ['one backtick run', '`'.repeat(MIB)],
    ['alternating backticks', '`a'.repeat(MIB / 2)],
    ['growing backtick runs', '`a``a```a'.repeat(MIB / 9)],
    ['backticks between line breaks', '`\r\n'.repeat(MIB / 3)],
  ])('renders 1 MiB of %s in linear time', (_shape, text) => {
    expect(cpuMs(() => codeSpan(text))).toBeLessThan(1_000);
  });

  it.each(SHAPES)('grows linearly on %s', (_shape, shape, from) => {
    expectLinear(codeSpan, shape, from);
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

  it('renders every line verbatim in one code block that no line closes', () => {
    const code = [...MARKUP, '    indented', '~~~', '````', '</code></pre>'].join('\n');
    const { html } = render(`## Formulas\n\n${fence(code)}\n\nAfter.`);
    expect(codeTexts(html)).toEqual([`${code}\n`]);
    expect(elements(html, 'pre')).toHaveLength(1);
    expect(headings(html)).toEqual(['h2 Formulas']);
    for (const tag of ['a', 'img', 'em', 'del', 'ul', 'ol', 'blockquote']) {
      expect(elements(html, tag), tag).toEqual([]);
    }
    expect(html).toContain('<p>After.</p>');
  });

  it.each([
    ['one backtick run', '`'.repeat(MIB)],
    ['alternating backticks', '`a'.repeat(MIB / 2)],
    ['growing backtick runs', '`a``a```a'.repeat(MIB / 9)],
    ['backticks between line breaks', '`\r\n'.repeat(MIB / 3)],
  ])('fences 1 MiB of %s in linear time', (_shape, text) => {
    expect(cpuMs(() => fence(text))).toBeLessThan(1_000);
  });

  it.each(SHAPES)('grows linearly on %s', (_shape, shape, from) => {
    expectLinear(fence, shape, from);
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

  it('adds the author, legacy IDs, and last edit after the keywords, before the URL', () => {
    expect(
      summaryLines({
        ...row,
        author: '_N. J. A. Sloane_',
        modified: '2026-09-15T21:11:07-04:00',
        legacyIds: ['M1459', 'N0577'],
      }),
    ).toEqual([
      '**Terms:** 1, 1, 2, 5',
      '**Offset:** 0,3 (first term is a(0))',
      '**Keywords:** core, nonn',
      '**Author:** `_N. J. A. Sloane_`',
      '**Legacy IDs:** M1459, N0577',
      '**Modified:** 2026-09-15T21:11:07-04:00',
      '**URL:** https://oeis.org/A000108',
    ]);
  });

  it('adds a line only for each field the row carries', () => {
    expect(summaryLines({ ...row, modified: '2026-09-29T20:19:41-04:00' })).toEqual([
      '**Terms:** 1, 1, 2, 5',
      '**Offset:** 0,3 (first term is a(0))',
      '**Keywords:** core, nonn',
      '**Modified:** 2026-09-29T20:19:41-04:00',
      '**URL:** https://oeis.org/A000108',
    ]);
    expect(summaryLines({ ...row, author: 'Simon P. Norton' })).toContain(
      '**Author:** `Simon P. Norton`',
    );
    expect(summaryLines({ ...row, legacyIds: ['M2975'] })).toContain('**Legacy IDs:** M2975');
  });

  it('renders the author as written and inert, its line breaks flattened', () => {
    const author = '<a>Eve</a> [site](https://attacker.example) ![x](y)\r\n# Mallory';
    const [, , , line = ''] = summaryLines({ ...row, author });
    expect(line).toBe(
      '**Author:** `<a>Eve</a> [site](https://attacker.example) ![x](y) # Mallory`',
    );
    const { html } = render(line);
    expect(codeTexts(html)).toEqual([
      '<a>Eve</a> [site](https://attacker.example) ![x](y) # Mallory',
    ]);
    for (const tag of ['a', 'img', 'h1']) expect(elements(html, tag), tag).toEqual([]);
  });
});
