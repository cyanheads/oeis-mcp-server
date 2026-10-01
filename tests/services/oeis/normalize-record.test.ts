/**
 * @fileoverview Tests for record normalization: Zod validation failures, absent sections as `[]`,
 * the Maple / Mathematica / `(Lang)` program split, link decoding, `bFileUrl`, and linear-time
 * parsing of long contributor lines.
 * @module tests/services/oeis/normalize-record.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { normalizeRecord, toANumber } from '@/services/oeis/normalize-record.js';
import {
  fibonacciRecordJson,
  minimalRecordJson,
  type RawRecord,
  recordWith,
  reservedRecordJson,
} from '../../fixtures/oeis-upstream.js';

function normalizeError(body: RawRecord): McpError {
  try {
    normalizeRecord(body);
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected normalizeRecord to throw.');
}

describe('toANumber', () => {
  it('zero-pads to six digits and never truncates', () => {
    expect(toANumber(7)).toBe('A000007');
    expect(toANumber(45)).toBe('A000045');
    expect(toANumber(999999)).toBe('A999999');
    expect(toANumber(1234567)).toBe('A1234567');
  });
});

describe('normalizeRecord', () => {
  describe('core fields', () => {
    it('maps a full record', () => {
      const record = normalizeRecord(fibonacciRecordJson);
      expect(record).toMatchObject({
        aNumber: 'A000045',
        name: 'Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
        offset: '0,4',
        firstIndex: 0,
        keywords: ['nonn', 'core', 'nice', 'easy', 'hear', 'changed'],
        author: '_N. J. A. Sloane_, Apr 30 1991',
        legacyIds: ['M0692', 'N0256'],
        referenceCount: 6162,
        revision: 902,
        created: '1991-04-30T03:00:00-04:00',
        modified: '2026-09-23T16:08:09-04:00',
        url: 'https://oeis.org/A000045',
      });
      expect(record.terms.slice(0, 6)).toEqual(['0', '1', '1', '2', '3', '5']);
    });

    it('keeps terms as strings, signs included, and skips the trailing comma and spaces', () => {
      const record = normalizeRecord(recordWith({ data: ' 1, -1,-1 ,0, 99999999999999999999,' }));
      expect(record.terms).toEqual(['1', '-1', '-1', '0', '99999999999999999999']);
    });

    it('reads empty data as no terms and an empty keyword string as no keywords', () => {
      const record = normalizeRecord(recordWith({ data: '', keyword: '' }));
      expect(record.terms).toEqual([]);
      expect(record.keywords).toEqual([]);
    });

    it('omits optional core fields the record lacks', () => {
      const record = normalizeRecord(minimalRecordJson);
      for (const key of ['author', 'legacyIds', 'bFileUrl']) expect(record).not.toHaveProperty(key);
      expect(record.aNumber).toBe('A388000');
      expect(record.firstIndex).toBe(1);
    });

    it('omits a blank author, a blank legacy id, and a blank time field', () => {
      const record = normalizeRecord(recordWith({ author: '   ', id: '', time: '', created: '' }));
      for (const key of ['author', 'legacyIds', 'modified', 'created']) {
        expect(record).not.toHaveProperty(key);
      }
    });

    it('trims the author', () => {
      expect(normalizeRecord(recordWith({ author: '  _Jane_  ' })).author).toBe('_Jane_');
    });

    it('pads the A-number from the numeric field', () => {
      expect(normalizeRecord(recordWith({ number: 7 })).aNumber).toBe('A000007');
      expect(normalizeRecord(recordWith({ number: 7 })).url).toBe('https://oeis.org/A000007');
    });
  });

  describe('absent sections', () => {
    it('reads every missing section as an empty array', () => {
      const record = normalizeRecord(minimalRecordJson);
      expect(record).toMatchObject({
        comments: [],
        formulas: [],
        examples: [],
        programs: [],
        references: [],
        links: [],
        crossReferences: [],
        extensions: [],
      });
    });

    it('maps each upstream section field to its section', () => {
      const record = normalizeRecord(fibonacciRecordJson);
      expect(record.comments).toHaveLength(2);
      expect(record.formulas).toEqual([
        'G.f.: x/(1 - x - x^2).',
        'a(n) = a(n-1) + a(n-2) for n >= 2.',
      ]);
      expect(record.examples).toEqual(['F(5) = 5 = F(4) + F(3) = 3 + 2.']);
      expect(record.references).toHaveLength(1);
      expect(record.crossReferences).toEqual(['Cf. A000032, A001045.', 'Row sums of A011973.']);
      expect(record.extensions).toEqual(['Extended by _Jane Doe_, Jan 01 2020.']);
    });
  });

  describe('validation failures', () => {
    it.each(['number', 'data', 'name', 'keyword', 'offset', 'references', 'revision'])(
      'rejects a record missing %s as non-retryable upstream_unparseable naming the field',
      (field) => {
        const error = normalizeError(recordWith({ [field]: undefined }));
        expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
        expect(error.message).toContain(field);
      },
    );

    it('lists every failing field once', () => {
      const error = normalizeError({});
      for (const field of ['number', 'data', 'name', 'keyword', 'references', 'revision']) {
        expect(error.message).toContain(field);
      }
    });

    it('rejects wrong types: a string number, a fractional count, a string section', () => {
      expect(normalizeError(recordWith({ number: '45' })).message).toContain('number');
      expect(normalizeError(recordWith({ references: 1.5 })).message).toContain('references');
      expect(normalizeError(recordWith({ comment: 'one line' })).message).toContain('comment');
    });

    it('rejects a negative number', () => {
      expect(normalizeError(recordWith({ number: -1 })).data).toMatchObject({
        reason: 'upstream_unparseable',
        retryable: false,
      });
    });

    it.each(['', 'x,2', ','])('rejects the unreadable offset %j as non-retryable', (offset) => {
      const error = normalizeError(recordWith({ offset }));
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toContain('A000045');
    });

    it('keeps an unreadable offset out of the message', () => {
      const error = normalizeError(recordWith({ offset: 'see <a href="x">here</a>' }));
      expect(error.message).toBe('OEIS returned A000045 with an unreadable offset.');
      expect(JSON.stringify(error.data)).not.toContain('here');
    });
  });

  describe('reserved and recycled entries', () => {
    it.each(['allocated', 'recycled'])(
      'normalizes a %s record with no offset, leaving offset and firstIndex absent',
      (keyword) => {
        const record = normalizeRecord(recordWith({ keyword }, reservedRecordJson));
        expect(record).toMatchObject({
          aNumber: 'A397217',
          name: 'allocated for Jane Doe',
          terms: [],
          keywords: [keyword],
          url: 'https://oeis.org/A397217',
        });
        expect(record).not.toHaveProperty('offset');
        expect(record).not.toHaveProperty('firstIndex');
      },
    );

    it('still rejects an ordinary record with no offset as non-retryable upstream_unparseable', () => {
      const error = normalizeError(recordWith({ keyword: 'nonn,new' }, reservedRecordJson));
      expect(error.data).toMatchObject({ reason: 'upstream_unparseable', retryable: false });
      expect(error.message).toContain('offset');
    });

    it('keeps the offset of a reserved record that carries one', () => {
      const record = normalizeRecord(recordWith({ offset: '0,1' }, reservedRecordJson));
      expect(record).toMatchObject({ offset: '0,1', firstIndex: 0 });
    });
  });

  describe('programs', () => {
    it('puts Maple and Mathematica first, as labeled blocks with lines joined by newline', () => {
      const record = normalizeRecord(
        recordWith({ maple: ['f := n -> n;', 'f(3);'], mathematica: ['Range[10]'], program: [] }),
      );
      expect(record.programs).toEqual([
        { language: 'Maple', code: 'f := n -> n;\nf(3);' },
        { language: 'Mathematica', code: 'Range[10]' },
      ]);
    });

    it('splits the program field into one block per (Lang) tag, stripping the tag', () => {
      const record = normalizeRecord(
        recordWith({
          maple: undefined,
          mathematica: undefined,
          program: [
            '(PARI) a(n) = n',
            '(Python)',
            'def a(n):',
            '    return n',
            '(Haskell) a n = n',
          ],
        }),
      );
      expect(record.programs).toEqual([
        { language: 'PARI', code: 'a(n) = n' },
        { language: 'Python', code: 'def a(n):\n    return n' },
        { language: 'Haskell', code: 'a n = n' },
      ]);
    });

    it('orders Maple, Mathematica, then the tagged blocks', () => {
      const record = normalizeRecord(fibonacciRecordJson);
      expect(record.programs.map((p) => p.language)).toEqual([
        'Maple',
        'Mathematica',
        'PARI',
        'Python',
      ]);
      expect(record.programs[3]?.code).toBe(
        'from sympy import fibonacci\ndef a(n): return fibonacci(n)',
      );
    });

    it('gives untagged leading lines a block with no language', () => {
      const record = normalizeRecord(
        recordWith({
          maple: undefined,
          mathematica: undefined,
          program: ['x := 1;', '(PARI) a(n) = n'],
        }),
      );
      expect(record.programs[0]).toEqual({ code: 'x := 1;' });
      expect(record.programs[0]).not.toHaveProperty('language');
      expect(record.programs[1]).toEqual({ language: 'PARI', code: 'a(n) = n' });
    });

    it('keeps a tag-only block as an empty code string', () => {
      const record = normalizeRecord(
        recordWith({ maple: undefined, mathematica: undefined, program: ['(SageMath)'] }),
      );
      expect(record.programs).toEqual([{ language: 'SageMath', code: '' }]);
    });

    it('does not read a parenthesis that is not a language tag as one', () => {
      const record = normalizeRecord(
        recordWith({
          maple: undefined,
          mathematica: undefined,
          program: ['(PARI) f(n) = 1', '(1+x)^2 is the generating polynomial', '(Python)x = 1'],
        }),
      );
      expect(record.programs).toHaveLength(1);
      expect(record.programs[0]?.code).toBe(
        'f(n) = 1\n(1+x)^2 is the generating polynomial\n(Python)x = 1',
      );
    });

    it('accepts multi-word and symbol language tags', () => {
      const record = normalizeRecord(
        recordWith({
          maple: undefined,
          mathematica: undefined,
          program: ['(Python 3) print(1)', '(C++) int a(int n);', '(F#) let a n = n'],
        }),
      );
      expect(record.programs.map((p) => p.language)).toEqual(['Python 3', 'C++', 'F#']);
    });

    it('yields no program blocks when all three fields are empty', () => {
      const record = normalizeRecord(recordWith({ maple: [], mathematica: [], program: [] }));
      expect(record.programs).toEqual([]);
    });
  });

  describe('links', () => {
    it('makes relative hrefs absolute against oeis.org and strips the tags', () => {
      const [first] = normalizeRecord(fibonacciRecordJson).links;
      expect(first).toEqual({
        text: 'Table of n, a(n) for n = 0..2000',
        urls: ['https://oeis.org/A000045/b000045.txt'],
      });
    });

    it('decodes entities in the text and in the href, and keeps absolute hrefs as they are', () => {
      const second = normalizeRecord(fibonacciRecordJson).links[1];
      expect(second?.text).toBe('Wikipedia, Fibonacci number & linear recurrences');
      expect(second?.urls).toEqual([
        'https://en.wikipedia.org/wiki/Fibonacci_number?x=1&y=2',
        'https://oeis.org/wiki/Index_entries_for_linear_recurrences',
      ]);
    });

    it('decodes named, decimal and hex entities and leaves unknown or invalid ones intact', () => {
      const [link] = normalizeRecord(
        recordWith({
          link: [
            '&lt;b&gt; &quot;q&quot; &#39;s&#39; &#x27;h&#x27; &apos;a&apos; &nbsp; &#1114112; &AMP;',
          ],
        }),
      ).links;
      expect(link?.text).toBe("<b> \"q\" 's' 'h' 'a' &nbsp; &#1114112; &");
    });

    it('returns a link line without an anchor as text with no URLs', () => {
      const [link] = normalizeRecord(recordWith({ link: ['Plain text line, no anchor.'] })).links;
      expect(link).toEqual({ text: 'Plain text line, no anchor.', urls: [] });
    });

    it('collects every anchor on a line and matches the tag case-insensitively', () => {
      const [link] = normalizeRecord(
        recordWith({
          link: ['<A HREF="/A000032">Lucas</A> and <a class="x" href="/A001045">Jacobsthal</a>'],
        }),
      ).links;
      expect(link?.urls).toEqual(['https://oeis.org/A000032', 'https://oeis.org/A001045']);
      expect(link?.text).toBe('Lucas and Jacobsthal');
    });

    it('skips an empty href', () => {
      const [link] = normalizeRecord(recordWith({ link: ['<a href="">nothing</a>'] })).links;
      expect(link?.urls).toEqual([]);
    });

    it('reads an href only inside the anchor tag that carries it', () => {
      const [link] = normalizeRecord(
        recordWith({ link: ['<a x <img href="https://example.org/i.png">image</a>'] }),
      ).links;
      expect(link?.urls).toEqual([]);
    });

    describe('URL schemes', () => {
      const linkOf = (line: string) => normalizeRecord(recordWith({ link: [line] })).links[0];

      it.each([
        ['javascript:', '<a href="javascript:alert(1)">run</a>'],
        ['JAVASCRIPT: in upper case', '<a href="JAVASCRIPT:alert(1)">run</a>'],
        ['JavaScript: in mixed case', '<a href="JavaScript:alert(1)">run</a>'],
        ['javascript: after leading whitespace', '<a href="  javascript:alert(1)">run</a>'],
        ['javascript: with a tab inside the scheme', '<a href="java&#9;script:alert(1)">run</a>'],
        ['javascript: written as an entity', '<a href="&#106;avascript:alert(1)">run</a>'],
        ['javascript: written as a hex entity', '<a href="&#x6A;avascript:alert(1)">run</a>'],
        ['data:', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">run</a>'],
        ['DATA: in upper case', '<a href="DATA:text/plain,hi">run</a>'],
        ['mailto:', '<a href="mailto:someone@example.org">run</a>'],
        ['MAILTO: in upper case', '<a href="MAILTO:someone@example.org">run</a>'],
        ['ftp:', '<a href="ftp://example.org/file">run</a>'],
        ['file:', '<a href="file:///etc/passwd">run</a>'],
        ['vbscript:', '<a href="vbscript:msgbox(1)">run</a>'],
      ])('drops a %s href and keeps the link text', (_label, line) => {
        expect(linkOf(line)).toEqual({ text: 'run', urls: [] });
      });

      it('keeps http: and https: hrefs, in any case of the scheme', () => {
        const link = linkOf(
          '<a href="HTTPS://example.org/a">a</a> <a href="Http://example.org/b">b</a> <a href="http://example.org/c">c</a>',
        );
        expect(link?.urls).toEqual([
          'https://example.org/a',
          'http://example.org/b',
          'http://example.org/c',
        ]);
      });

      it('keeps a protocol-relative href as https', () => {
        expect(linkOf('<a href="//example.org/x">x</a>')?.urls).toEqual(['https://example.org/x']);
      });

      it('keeps the safe hrefs of a line and drops the others', () => {
        const link = linkOf(
          '<a href="javascript:a()">one</a> <a href="/A000032">two</a> <a href="data:x,y">three</a> <a href="https://example.org/ok">four</a> <a href="mailto:a@b.c">five</a>',
        );
        expect(link).toEqual({
          text: 'one two three four five',
          urls: ['https://oeis.org/A000032', 'https://example.org/ok'],
        });
      });

      it('yields urls: [] with the text kept when the only href is dropped', () => {
        expect(linkOf('See <a href="javascript:void(0)">the page</a> for details.')).toEqual({
          text: 'See the page for details.',
          urls: [],
        });
      });

      it('does not take a dropped href as the b-file URL', () => {
        const record = normalizeRecord(
          recordWith({ link: ['<a href="javascript:/A000045/b000045.txt">b</a>'] }),
        );
        expect(record.bFileUrl).toBeUndefined();
      });
    });
  });

  describe('bFileUrl', () => {
    const withLink = (link: string, base: RawRecord = fibonacciRecordJson) =>
      normalizeRecord(recordWith({ link: [link] }, base));

    it('is the absolute canonical URL when a link points at the entry b-file', () => {
      expect(normalizeRecord(fibonacciRecordJson).bFileUrl).toBe(
        'https://oeis.org/A000045/b000045.txt',
      );
    });

    it('accepts an absolute oeis.org or www.oeis.org href and normalizes it to https://oeis.org', () => {
      expect(withLink('<a href="https://oeis.org/A000045/b000045.txt">b</a>').bFileUrl).toBe(
        'https://oeis.org/A000045/b000045.txt',
      );
      expect(withLink('<a href="http://www.oeis.org/A000045/b000045.txt">b</a>').bFileUrl).toBe(
        'https://oeis.org/A000045/b000045.txt',
      );
    });

    it("is absent when the link is another entry's b-file, another host, or another path", () => {
      expect(withLink('<a href="/A000046/b000046.txt">b</a>').bFileUrl).toBeUndefined();
      expect(
        withLink('<a href="https://example.org/A000045/b000045.txt">b</a>').bFileUrl,
      ).toBeUndefined();
      expect(withLink('<a href="/A000045/list">list</a>').bFileUrl).toBeUndefined();
    });

    it('is absent when the record has no links', () => {
      expect(normalizeRecord(recordWith({ link: undefined })).bFileUrl).toBeUndefined();
    });

    it('uses the seven-digit form for a seven-digit A-number', () => {
      const record = normalizeRecord(
        recordWith({ number: 1234567, link: ['<a href="/A1234567/b1234567.txt">b</a>'] }),
      );
      expect(record.aNumber).toBe('A1234567');
      expect(record.bFileUrl).toBe('https://oeis.org/A1234567/b1234567.txt');
    });
  });

  describe('hrefs in contributor text', () => {
    it('removes every non-web href from every text section, in any quoting, and keeps the rest verbatim', () => {
      const unsafe = [
        'See <a href="javascript:alert(1)">A000032</a>.',
        "See <a href='data:text/html,<b>x</b>'>A000032</a>.",
        'See <a HREF=javascript:alert(2)>A000032</a>.',
        'See <a href="&#106;avascript:alert(3)">A000032</a>.',
      ];
      const record = normalizeRecord(
        recordWith({
          name: unsafe[0],
          author: unsafe[1],
          comment: unsafe,
          formula: unsafe,
          example: unsafe,
          reference: unsafe,
          xref: unsafe,
          ext: unsafe,
          maple: unsafe,
          mathematica: unsafe,
          program: unsafe,
        }),
      );
      expect(JSON.stringify(record)).not.toMatch(/javascript|data:|&#106;/i);
      expect(record.crossReferences).toEqual(Array(4).fill('See <a>A000032</a>.'));
      expect(record.name).toBe('See <a>A000032</a>.');
    });

    it('keeps web hrefs, relative ones included, exactly as written', () => {
      const lines = [
        'Cf. <a href="/A000032" title="Lucas">A000032</a>, <a href=\'https://example.org/x\'>x</a>.',
      ];
      expect(normalizeRecord(recordWith({ xref: lines, comment: lines })).comments).toEqual(lines);
    });

    it('leaves comparison operators and program code without an href untouched', () => {
      const code = ['a(n) = if(0<a && b>c, 1<<n, n>>1); /* hrefs elsewhere */'];
      expect(normalizeRecord(recordWith({ program: code, formula: code })).formulas).toEqual(code);
    });

    it('removes an href that entity decoding exposes in link text', () => {
      const [link] = normalizeRecord(
        recordWith({ link: ['&lt;a href=&quot;javascript:x&quot;&gt;Evil&lt;/a&gt;'] }),
      ).links;
      expect(link?.text).toBe('<a>Evil</a>');
    });

    it('removes the whole whitespace run before a dropped href', () => {
      const comment = ['<a \t href="javascript:x" title="t">A000032</a>'];
      expect(normalizeRecord(recordWith({ comment })).comments).toEqual([
        '<a title="t">A000032</a>',
      ]);
    });
  });

  describe('long contributor lines', () => {
    const MIB = 1024 * 1024;

    it.each([
      ['a whitespace run in a comment', { comment: [`${' '.repeat(MIB - 1)}x`] }],
      ['a run of "<" in a link line', { link: ['<'.repeat(MIB)] }],
      ['a run of "<a " in a link line', { link: ['<a '.repeat(MIB / 4)] }],
    ])('normalizes 1 MiB of %s in linear time', (_shape, override) => {
      const raw = recordWith(override);
      const started = performance.now();
      normalizeRecord(raw);
      expect(performance.now() - started).toBeLessThan(250);
    });
  });
});
