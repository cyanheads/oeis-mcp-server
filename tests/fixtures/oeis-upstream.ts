/**
 * @fileoverview Upstream fixture bodies shaped like the oeis.org API Reference: `fmt=json` records,
 * `fmt=text` search pages, b-file text, and the non-data bodies (HTML maintenance page, the
 * anonymous paging-cap 403). Shared by the service-layer and tool tests.
 * @module tests/fixtures/oeis-upstream
 */

/** A raw `/A######?fmt=json` record: the shape `normalizeRecord` validates. */
export type RawRecord = Record<string, unknown>;

/** Header value OEIS sends on record responses; echoed back as `If-Modified-Since`. */
export const FIBONACCI_LAST_MODIFIED = 'Tue, 23 Sep 2026 20:08:09 GMT';

/** A complete record for A000045 with every field and section present. */
export const fibonacciRecordJson: RawRecord = {
  number: 45,
  id: 'M0692 N0256',
  data: '0,1,1,2,3,5,8,13,21,34,55,89,144,233,377',
  name: 'Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
  comment: [
    "Also sometimes called Lamé's sequence.",
    "F(n+2) = number of binary sequences of length n that have no consecutive 0's.",
  ],
  reference: ['A. T. Benjamin and J. J. Quinn, Proofs that Really Count, MAA, 2003.'],
  link: [
    '<a href="/A000045/b000045.txt">Table of n, a(n) for n = 0..2000</a>',
    'Wikipedia, <a href="https://en.wikipedia.org/wiki/Fibonacci_number?x=1&amp;y=2">Fibonacci number</a> &amp; <a href="/wiki/Index_entries_for_linear_recurrences">linear recurrences</a>',
  ],
  formula: ['G.f.: x/(1 - x - x^2).', 'a(n) = a(n-1) + a(n-2) for n >= 2.'],
  example: ['F(5) = 5 = F(4) + F(3) = 3 + 2.'],
  maple: [
    'A000045 := proc(n) option remember; if n<=1 then n else A000045(n-1)+A000045(n-2) fi end:',
  ],
  mathematica: ['Fibonacci[Range[0, 40]]'],
  program: [
    '(PARI) a(n) = fibonacci(n)',
    '(Python)',
    'from sympy import fibonacci',
    'def a(n): return fibonacci(n)',
  ],
  xref: ['Cf. A000032, A001045.', 'Row sums of A011973.'],
  ext: ['Extended by _Jane Doe_, Jan 01 2020.'],
  keyword: 'nonn,core,nice,easy,hear,changed',
  offset: '0,4',
  author: '_N. J. A. Sloane_, Apr 30 1991',
  references: 6162,
  revision: 902,
  time: '2026-09-23T16:08:09-04:00',
  created: '1991-04-30T03:00:00-04:00',
};

/** The smallest record OEIS serves: every required field, no optional section, no author. */
export const minimalRecordJson: RawRecord = {
  number: 388000,
  data: '1,2,3',
  name: 'Synthetic new entry.',
  keyword: 'nonn,new',
  offset: '1,2',
  references: 1,
  revision: 3,
  time: '2026-09-28T09:00:00-04:00',
  created: '2026-09-28T08:00:00-04:00',
};

/** Returns `base` with `overrides` applied; a key set to `undefined` is removed. */
export function recordWith(overrides: RawRecord, base: RawRecord = fibonacciRecordJson): RawRecord {
  const next: RawRecord = { ...base, ...overrides };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete next[key];
  }
  return next;
}

/** Serializes a raw record the way OEIS does: pretty-printed with tabs. */
export function recordBody(record: RawRecord = fibonacciRecordJson): string {
  return JSON.stringify(record, null, '\t');
}

/** One record to render into a `fmt=text` search page. */
export interface SearchFixtureRecord {
  aNumber: string;
  keywords: string;
  legacy?: string;
  name: string;
  offset: string;
  terms: string[];
}

export const catalanSearchRecord: SearchFixtureRecord = {
  aNumber: 'A000108',
  legacy: 'M1459 N0577',
  terms: ['1', '1', '2', '5', '14', '42', '132', '429', '1430', '4862', '16796', '58786'],
  name: 'Catalan numbers: C(n) = binomial(2n,n)/(n+1) = (2n)!/(n!(n+1)!).',
  keywords: 'core,nonn,easy,eigen,nice,changed',
  offset: '0,3',
};

export const fibonacciSearchRecord: SearchFixtureRecord = {
  aNumber: 'A000045',
  legacy: 'M0692 N0256',
  terms: ['0', '1', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89'],
  name: 'Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
  keywords: 'nonn,core,nice,easy,hear,changed',
  offset: '0,4',
};

export const moebiusSearchRecord: SearchFixtureRecord = {
  aNumber: 'A008683',
  legacy: 'M0097 N0035',
  terms: ['1', '-1', '-1', '0', '-1', '1', '-1', '0', '0', '1', '-1', '0'],
  name: 'Moebius (or Mobius) function mu(n).',
  keywords: 'sign,core,nice,easy,mult,look',
  offset: '1,1',
};

/** Renders one record in the internal format, with the lines the parser must ignore around it. */
export function searchRecordText(record: SearchFixtureRecord): string {
  const a = record.aNumber;
  const third = Math.ceil(record.terms.length / 3);
  const chunks = [
    record.terms.slice(0, third),
    record.terms.slice(third, third * 2),
    record.terms.slice(third * 2),
  ].filter((chunk) => chunk.length > 0);
  const dataLines = chunks.map((chunk, i) => {
    const tag = ['S', 'T', 'U'][i];
    const trailing = i < chunks.length - 1 ? ',' : '';
    return `%${tag} ${a} ${chunk.join(',')}${trailing}`;
  });
  return [
    `%I ${a} ${record.legacy ?? ''} #2253 Sep 15 2026 21:11:07`.trimEnd(),
    ...dataLines,
    `%N ${a} ${record.name}`,
    `%C ${a} A comment line that mentions A000032 and 1,2,3.`,
    `%D ${a} A reference line.`,
    `%H ${a} <a href="/${a}/b${a.slice(1)}.txt">Table of n, a(n)</a>`,
    `%F ${a} G.f.: x/(1 - x - x^2).`,
    `%e ${a} Example text.`,
    `%p ${a} (PARI) a(n) = n`,
    `%t ${a} Mathematica line`,
    `%o ${a} (Python) def a(n): return n`,
    `%Y ${a} Cf. A000032, A001045.`,
    `%K ${a} ${record.keywords}`,
    `%O ${a} ${record.offset}`,
    `%A ${a} _N. J. A. Sloane_, Apr 30 1991`,
    `%E ${a} Extended by _Jane Doe_, Jan 01 2020.`,
  ].join('\n');
}

const GREETING = '# Greetings from The On-Line Encyclopedia of Integer Sequences! http://oeis.org/';
const LICENSE =
  '# Content is available under The OEIS End-User License Agreement: http://oeis.org/LICENSE';

/** Renders a complete `fmt=text` page: greeting, `Search:` echo, status line, records, license. */
export function searchPageText(options: {
  eol?: '\n' | '\r\n';
  query: string;
  records?: SearchFixtureRecord[];
  status: string;
}): string {
  const { eol = '\n', query, records = [], status } = options;
  const body = records.map(searchRecordText).join('\n\n');
  const lines = [GREETING, '', `Search: ${query}`, status, ''];
  if (body) lines.push(body, '');
  lines.push(LICENSE, '');
  return lines.join('\n').replaceAll('\n', eol);
}

/** `Showing 1-2 of 26` with two records. */
export const resultsSearchPage = searchPageText({
  query: 'seq:1,2,5,14,42,132,429',
  status: 'Showing 1-2 of 26',
  records: [catalanSearchRecord, fibonacciSearchRecord],
});

/**
 * What OEIS serves for `seq:1,2,5,14,42,132,429` (26 results) at `start=30` or `start=100`: a start
 * past the last result is clamped to the last page, `Showing 21-26 of 26`, with its six rows.
 */
export const clampedSearchPage = searchPageText({
  query: 'seq:1,2,5,14,42,132,429',
  status: 'Showing 21-26 of 26',
  records: syntheticSearchRecords(6),
});

/** One signed-sequence hit, as returned for `id:a008683`. */
export const moebiusSearchPage = searchPageText({
  query: 'id:a008683',
  status: 'Showing 1-1 of 1',
  records: [moebiusSearchRecord],
});

export const noResultsSearchPage = searchPageText({
  query: 'id:axyz',
  status: 'No results.',
});

export const tooManySearchPage = searchPageText({
  query: 'prime',
  status: 'Too many results. Please narrow search.',
});

/** `count` synthetic summary records with consecutive A-numbers from `firstNumber`. */
export function syntheticSearchRecords(
  count: number,
  firstNumber = 100_000,
): SearchFixtureRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    ...fibonacciSearchRecord,
    aNumber: `A${String(firstNumber + i).padStart(6, '0')}`,
    name: `Synthetic ${i}.`,
  }));
}

/** A `Showing {firstRow}-… of {total}` page of `count` synthetic rows. */
export function syntheticSearchPage(options: {
  count: number;
  firstRow?: number;
  query?: string;
  total: number;
}): string {
  const { count, firstRow = 1, query = 'seq:1,2,3', total } = options;
  return searchPageText({
    query,
    records: syntheticSearchRecords(count),
    status: `Showing ${firstRow}-${firstRow + count - 1} of ${total}`,
  });
}

/** What a Cloudflare or maintenance page serves in place of data. */
export const htmlMaintenanceBody =
  '<!DOCTYPE html>\n<html lang="en"><head><title>Maintenance</title></head><body>Back soon.</body></html>\n';

/** The plain-text 403 body `/search` returns past result 110. */
export const signInRefusalBody = 'Sign in to see search results past the first 100.\n';

/** A b-file as OEIS serves it: `#` comment lines, then one `n a(n)` pair per line. */
export function bFileText(terms: readonly string[], firstIndex = 0): string {
  const header = ['# Table of n, a(n) for n = 0..1000', '# synthetic fixture', ''];
  return `${[...header, ...terms.map((value, i) => `${firstIndex + i} ${value}`)].join('\n')}\n`;
}

/** First 15 Fibonacci numbers as a complete b-file (28 + header bytes). */
export const fibonacciBFile = bFileText([
  '0',
  '1',
  '1',
  '2',
  '3',
  '5',
  '8',
  '13',
  '21',
  '34',
  '55',
  '89',
  '144',
  '233',
  '377',
]);

/** A b-file body well past the 1 MiB read cap, built from variable-width lines. */
export function oversizedBFile(): { lines: string[]; text: string } {
  const lines: string[] = [];
  let bytes = 0;
  for (let n = 0; bytes <= 1_300_000; n++) {
    const line = `${n} ${String(n * 7919).repeat(1 + (n % 3))}\n`;
    lines.push(line);
    bytes += line.length;
  }
  return { lines, text: lines.join('') };
}
