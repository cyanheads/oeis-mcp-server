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

/**
 * A reserved A-number as OEIS serves it (keyword `allocated`): an empty data line and no `offset`
 * field at all.
 */
export const reservedRecordJson: RawRecord = {
  number: 397217,
  data: '',
  name: 'allocated for Jane Doe',
  keyword: 'allocated',
  author: 'Jane Doe',
  references: 1,
  revision: 1,
  time: '2026-09-29T12:00:00-04:00',
  created: '2026-09-29T12:00:00-04:00',
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
    [`%I ${a}`, record.legacy, '#2253 Sep 15 2026 21:11:07'].filter(Boolean).join(' '),
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

/**
 * A reserved A-number's record in the internal format, in the shape oeis.org serves: `%I`, an
 * empty `%S`, `%N`, and `%K`; no `%O` and no `%A`.
 */
export function reservedSearchRecordText(aNumber = 'A397217'): string {
  return [
    `%I ${aNumber} #1 Sep 29 2026 12:00:00`,
    `%S ${aNumber} `,
    `%N ${aNumber} allocated for Jane Doe`,
    `%K ${aNumber} allocated`,
  ].join('\n');
}

/**
 * Records from `/search?fmt=text` pages oeis.org served on 2026-10-01, cut to the lines the parser
 * reads (`%I %S %T %U %N %K %O %A`) and otherwise verbatim. Their `%I` lines carry two, one, or no
 * legacy ids and summer and winter timestamps; the reserved and recycled records have no `%A`.
 */
export const capturedSearchRecords = {
  /** Two legacy ids; an author line with a year only. */
  A000045: [
    '%I A000045 M0692 N0256 #2594 Sep 23 2026 16:08:09',
    '%S A000045 0,1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,2584,4181,6765,',
    '%T A000045 10946,17711,28657,46368,75025,121393,196418,317811,514229,832040,',
    '%U A000045 1346269,2178309,3524578,5702887,9227465,14930352,24157817,39088169,63245986,102334155',
    '%N A000045 Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
    '%K A000045 nonn,core,nice,easy,hear,changed',
    '%O A000045 0,4',
    '%A A000045 _N. J. A. Sloane_, 1964',
  ].join('\n'),
  /** One legacy id; an author line with no date. */
  A005700: [
    '%I A005700 M2975 #174 Jul 30 2026 18:33:54',
    '%S A005700 1,1,3,14,84,594,4719,40898,379236,3711916,37975756,403127256,',
    '%T A005700 4415203280,49671036900,571947380775,6721316278650,80419959684900,',
    '%U A005700 977737404590100,12058761323277900,150656212896017400,1904342169333848400,24328661192286773400,313839729380499376860',
    '%N A005700 a(n) = C(n)*C(n+2) - C(n+1)^2 where C() are the Catalan numbers A000108.',
    '%K A005700 nonn,walk,easy',
    '%O A005700 0,3',
    '%A A005700 _N. J. A. Sloane_',
  ].join('\n'),
  /** One legacy id; two authors. */
  A007318: [
    '%I A007318 M0082 #1149 Sep 25 2026 10:59:50',
    '%S A007318 1,1,1,1,2,1,1,3,3,1,1,4,6,4,1,1,5,10,10,5,1,1,6,15,20,15,6,1,1,7,21,',
    '%T A007318 35,35,21,7,1,1,8,28,56,70,56,28,8,1,1,9,36,84,126,126,84,36,9,1,1,10,',
    '%U A007318 45,120,210,252,210,120,45,10,1,1,11,55,165,330,462,462,330,165,55,11,1',
    "%N A007318 Pascal's triangle read by rows: C(n,k) = binomial(n,k) = n!/(k!*(n-k)!), 0 <= k <= n.",
    '%K A007318 nonn,tabl,nice,easy,core,look,hear,changed',
    '%O A007318 0,5',
    '%A A007318 _N. J. A. Sloane_ and _Mira Bernstein_, Apr 28 1994',
  ].join('\n'),
  /** An author line without wiki underscores. */
  A033191: [
    '%I A033191 #53 Jun 30 2026 19:56:59',
    '%S A033191 1,1,2,5,14,42,132,429,1430,4861,16778,58598,206516,732825,2613834,',
    '%T A033191 9358677,33602822,120902914,435668420,1571649221,5674201118,',
    '%U A033191 20497829133,74079051906,267803779710,968355724724,3502058316337,12666676646162,45818284122149',
    '%N A033191 Binomial transform of [ 1, 0, 1, 1, 3, 6, 15, 36, 91, 231, 595, ... ], which is essentially binomial(Fibonacci(k) + 1, 2).',
    '%K A033191 nonn,easy',
    '%O A033191 0,3',
    '%A A033191 Simon P. Norton',
  ].join('\n'),
  /** A winter (EST) timestamp. */
  A068875: [
    '%I A068875 #146 Jan 15 2026 13:24:20',
    '%S A068875 1,2,4,10,28,84,264,858,2860,9724,33592,117572,416024,1485800,5348880,',
    '%T A068875 19389690,70715340,259289580,955277400,3534526380,13128240840,',
    '%U A068875 48932534040,182965127280,686119227300,2579808294648,9723892802904,36734706144304,139067101832008',
    '%N A068875 Expansion of (1 + x*C)*C, where C = (1 - (1 - 4*x)^(1/2))/(2*x) is the g.f. for Catalan numbers, A000108.',
    '%K A068875 nonn,easy',
    '%O A068875 0,2',
    '%A A068875 _N. J. A. Sloane_, Jun 06 2002',
  ].join('\n'),
  /** A winter (EST) timestamp from the year before. */
  A288942: [
    '%I A288942 #61 Nov 05 2025 15:22:40',
    '%S A288942 1,1,0,1,1,0,1,1,1,0,1,1,2,1,0,1,1,2,4,1,0,1,1,2,5,9,1,0,1,1,2,5,13,',
    '%T A288942 21,1,0,1,1,2,5,14,36,51,1,0,1,1,2,5,14,41,104,127,1,0,1,1,2,5,14,42,',
    '%U A288942 125,309,323,1,0,1,1,2,5,14,42,131,393,939,835,1,0',
    '%N A288942 Number A(n,k) of ordered rooted trees with n non-root nodes and all outdegrees <= k; square array A(n,k), n >= 0, k >= 0, read by antidiagonals.',
    '%K A288942 nonn,tabl',
    '%O A288942 0,13',
    '%A A288942 _Alois P. Heinz_, Sep 01 2017',
  ].join('\n'),
  /** No legacy id. */
  A399236: [
    '%I A399236 #118 Oct 01 2026 14:35:22',
    '%S A399236 1,8,6,2,13,3,4,9,12,19,5,7,24,16,39,17,25,20,42,32,26,10,27,33,14,18,',
    '%T A399236 11,31,41,34,15,35,63,51,40,30,59,50,62,53,28,54,43,21,44,52,61,49,23,',
    '%U A399236 29,58,71,85,74,64,36,65,75,86,72,83,48,22,47,82,97,60,73',
    '%N A399236 Squares visited by knight moves on a diagonally numbered Q1 board and always taking the available unvisited square with the shortest distance to the origin, while in the case of a tie the square with smaller row index is preferred. Starting square is labeled 1.',
    '%K A399236 nonn,fini,full,new',
    '%O A399236 1,2',
    '%A A399236 _Benjamin Simon Strang_, Aug 23 2026',
  ].join('\n'),
  /** A reserved A-number, whole. */
  A397217: [
    '%I A397217 #39 Sep 29 2026 20:19:41',
    '%S A397217 ',
    '%N A397217 allocated for Eric Stolee',
    '%K A397217 allocated',
  ].join('\n'),
  /** A recycled A-number, whole: its `%N` is empty too. */
  A395050: [
    '%I A395050 #97 Sep 22 2026 17:49:40',
    '%S A395050 ',
    '%N A395050 ',
    '%K A395050 recycled',
  ].join('\n'),
} as const;

/**
 * `/A######?fmt=json` records oeis.org served on 2026-10-01 for three of
 * {@link capturedSearchRecords}, without their section arrays.
 */
export const capturedRecordJson = {
  A000045: {
    number: 45,
    id: 'M0692 N0256',
    data: '0,1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,2584,4181,6765,10946,17711,28657,46368,75025,121393,196418,317811,514229,832040,1346269,2178309,3524578,5702887,9227465,14930352,24157817,39088169,63245986,102334155',
    name: 'Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
    keyword: 'nonn,core,nice,easy,hear,changed',
    offset: '0,4',
    author: '_N. J. A. Sloane_, 1964',
    references: 6162,
    revision: 2594,
    time: '2026-09-23T16:08:09-04:00',
    created: '1991-04-30T03:00:00-04:00',
  },
  A068875: {
    number: 68875,
    data: '1,2,4,10,28,84,264,858,2860,9724,33592,117572,416024,1485800,5348880,19389690,70715340,259289580,955277400,3534526380,13128240840,48932534040,182965127280,686119227300,2579808294648,9723892802904,36734706144304,139067101832008',
    name: 'Expansion of (1 + x*C)*C, where C = (1 - (1 - 4*x)^(1/2))/(2*x) is the g.f. for Catalan numbers, A000108.',
    keyword: 'nonn,easy',
    offset: '0,2',
    author: '_N. J. A. Sloane_, Jun 06 2002',
    references: 24,
    revision: 146,
    time: '2026-01-15T13:24:20-05:00',
    created: '2003-05-16T03:00:00-04:00',
  },
  A288942: {
    number: 288942,
    data: '1,1,0,1,1,0,1,1,1,0,1,1,2,1,0,1,1,2,4,1,0,1,1,2,5,9,1,0,1,1,2,5,13,21,1,0,1,1,2,5,14,36,51,1,0,1,1,2,5,14,41,104,127,1,0,1,1,2,5,14,42,125,309,323,1,0,1,1,2,5,14,42,131,393,939,835,1,0',
    name: 'Number A(n,k) of ordered rooted trees with n non-root nodes and all outdegrees <= k; square array A(n,k), n >= 0, k >= 0, read by antidiagonals.',
    keyword: 'nonn,tabl',
    offset: '0,13',
    author: '_Alois P. Heinz_, Sep 01 2017',
    references: 14,
    revision: 61,
    time: '2025-11-05T15:22:40-05:00',
    created: '2017-09-01T19:12:26-04:00',
  },
} satisfies Record<string, RawRecord>;

/**
 * Renders a complete `fmt=text` page: greeting, `Search:` echo, status line, records, license. A
 * string record is inserted as already-rendered internal-format text.
 */
export function searchPageText(options: {
  eol?: '\n' | '\r\n';
  query: string;
  records?: (SearchFixtureRecord | string)[];
  status: string;
}): string {
  const { eol = '\n', query, records = [], status } = options;
  const body = records
    .map((record) => (typeof record === 'string' ? record : searchRecordText(record)))
    .join('\n\n');
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

/** First records of the {@link echoCapturePage} pages, cut to the lines the parser reads, verbatim. */
const echoCaptureRecords = {
  A000045: [
    '%I A000045 M0692 N0256 #2609 Oct 16 2026 16:43:09',
    '%S A000045 0,1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,2584,4181,6765,',
    '%T A000045 10946,17711,28657,46368,75025,121393,196418,317811,514229,832040,',
    '%U A000045 1346269,2178309,3524578,5702887,9227465,14930352,24157817,39088169,63245986,102334155',
    '%N A000045 Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
    '%K A000045 nonn,core,nice,easy,hear,changed',
    '%O A000045 0,4',
    '%A A000045 _N. J. A. Sloane_, 1964',
  ].join('\n'),
  A000108: [
    '%I A000108 M1459 N0577 #2256 Oct 03 2026 09:50:18',
    '%S A000108 1,1,2,5,14,42,132,429,1430,4862,16796,58786,208012,742900,2674440,',
    '%T A000108 9694845,35357670,129644790,477638700,1767263190,6564120420,',
    '%U A000108 24466267020,91482563640,343059613650,1289904147324,4861946401452,18367353072152,69533550916004,263747951750360,1002242216651368,3814986502092304',
    '%N A000108 Catalan numbers: C(n) = binomial(2n,n)/(n+1) = (2n)!/(n!(n+1)!).',
    '%K A000108 core,nonn,easy,eigen,nice',
    '%O A000108 0,3',
    '%A A000108 _N. J. A. Sloane_',
  ].join('\n'),
  A000203: [
    '%I A000203 M2329 N0921 #648 Oct 14 2026 14:28:25',
    '%S A000203 1,3,4,7,6,12,8,15,13,18,12,28,14,24,24,31,18,39,20,42,32,36,24,60,31,',
    '%T A000203 42,40,56,30,72,32,63,48,54,48,91,38,60,56,90,42,96,44,84,78,72,48,',
    '%U A000203 124,57,93,72,98,54,120,72,120,80,90,60,168,62,96,104,127,84,144,68,126,96,144',
    '%N A000203 a(n) = sigma(n), the sum of the divisors of n. Also called sigma_1(n).',
    '%K A000203 easy,core,nonn,nice,mult,changed',
    '%O A000203 1,2',
    '%A A000203 _N. J. A. Sloane_',
  ].join('\n'),
  A008683: [
    '%I A008683 #413 Oct 04 2026 21:02:18',
    '%S A008683 1,-1,-1,0,-1,1,-1,0,0,1,-1,0,-1,1,1,0,-1,0,-1,0,1,1,-1,0,0,1,0,0,-1,',
    '%T A008683 -1,-1,0,1,1,1,0,-1,1,1,0,-1,-1,-1,0,0,1,-1,0,0,0,1,0,-1,0,1,0,1,1,-1,',
    '%U A008683 0,-1,1,0,0,1,-1,-1,0,1,-1,-1,0,-1,1,0,0,1,-1',
    '%N A008683 Möbius (or Moebius) function mu(n). mu(1) = 1; mu(n) = (-1)^k if n is the product of k different primes; otherwise mu(n) = 0.',
    '%K A008683 core,sign,easy,mult,nice,changed',
    '%O A008683 1,1',
    '%A A008683 _N. J. A. Sloane_',
  ].join('\n'),
  A023900: [
    '%I A023900 #249 Sep 24 2026 01:24:36',
    '%S A023900 1,-1,-2,-1,-4,2,-6,-1,-2,4,-10,2,-12,6,8,-1,-16,2,-18,4,12,10,-22,2,',
    '%T A023900 -4,12,-2,6,-28,-8,-30,-1,20,16,24,2,-36,18,24,4,-40,-12,-42,10,8,22,',
    '%U A023900 -46,2,-6,4,32,12,-52,2,40,6,36,28,-58,-8,-60,30,12,-1,48,-20,-66,16,44,-24,-70,2,-72,36,8,18,60,-24,-78,4,-2',
    '%N A023900 Dirichlet inverse of Euler totient function (A000010).',
    '%K A023900 sign,easy,nice,mult',
    '%O A023900 1,3',
    '%A A023900 _Olivier Gérard_',
  ].join('\n'),
  A238442: [
    '%I A238442 #91 Nov 05 2025 15:22:26',
    '%S A238442 1,1,2,3,1,4,3,7,4,-5,6,7,-1,12,6,-3,-7,8,12,-4,-1,15,8,-7,-3,13,15,',
    '%T A238442 -6,-4,18,13,-12,-7,12,18,-8,-6,12,28,12,-15,-12,1,14,28,-13,-8,3,24,',
    '%U A238442 14,-18,-15,4,15,24,24,-12,-13,7,1,31,24,-28,-18,6,3',
    "%N A238442 Triangle read by rows demonstrating Euler's pentagonal theorem for the sum of divisors.",
    '%K A238442 sign,tabf',
    '%O A238442 1,3',
    '%A A238442 _Omar E. Pol_, Feb 26 2014',
  ].join('\n'),
  A370071: [
    '%I A370071 #64 Mar 28 2024 00:01:03',
    '%S A370071 0,1,8,144,610,46368,1346269,14930352,63245986,165580141,267914296,',
    '%T A370071 2971215073,4807526976,7778742049,12586269025,139583862445,',
    '%U A370071 365435296162,591286729879,956722026041,1548008755920,2504730781961,4052739537881,6557470319842,17167680177565,27777890035288,190392490709135',
    '%N A370071 Fibonacci numbers such that some permutation of their digits is a perfect power.',
    '%K A370071 nonn,base',
    '%O A370071 1,3',
    '%A A370071 _Gonzalo Martínez_, Feb 08 2024',
  ].join('\n'),
} as const;

/**
 * `/search?fmt=text` pages oeis.org served on 2026-10-18 for numbers separated by spaces, commas,
 * or both, keyed by the query sent: the `Search:` echo and status line verbatim, and the A-number
 * of the first record. OEIS joins three or more numbers into one `seq:` run, but with spaces alone
 * a negative term after the first starts a new run and fewer than three numbers are not joined.
 */
const echoCaptures = {
  '1 -1 -1 0 -1 1 -1 0 0 1': [
    '1 seq:-1 seq:-1 0 seq:-1 1 seq:-1,0,0,1',
    'Showing 1-10 of 7824',
    'A008683',
  ],
  '1,-1,-1,0,-1,1,-1,0,0,1': ['seq:1,-1,-1,0,-1,1,-1,0,0,1', 'Showing 1-10 of 202', 'A008683'],
  '1, -1, -1, 0, -1, 1, -1, 0, 0, 1': [
    'seq:1,-1,-1,0,-1,1,-1,0,0,1',
    'Showing 1-10 of 202',
    'A008683',
  ],
  '1 2 5 14 42 132': ['seq:1,2,5,14,42,132', 'Showing 1-10 of 50', 'A000108'],
  '5 14 42': ['seq:5,14,42', 'Showing 1-10 of 126', 'A000108'],
  '-1 2 5 14 42 132': ['seq:-1,2,5,14,42,132', 'Showing 1-10 of 50', 'A000108'],
  '1 2 -5 14 42 132': ['1 2 seq:-5,14,42,132', 'Showing 1-10 of 51', 'A000108'],
  '-42': ['seq:-42', 'Showing 1-10 of 36344', 'A023900'],
  '1,-1,-1,0 -1 1 -1 0 0 1': [
    'seq:1,-1,-1,0 seq:-1 1 seq:-1,0,0,1',
    'Showing 1-10 of 3558',
    'A008683',
  ],
  'mobius 1 -1 -1 0 -1 1 -1 0 0 1': [
    'mobius 1 seq:-1 seq:-1 0 seq:-1 1 seq:-1,0,0,1',
    'Showing 1-10 of 175',
    'A008683',
  ],
  'seq:1 -1 -1 0 -1 1 -1 0 0 1': [
    'seq:1 seq:-1 seq:-1 0 seq:-1 1 seq:-1,0,0,1',
    'Showing 1-10 of 7824',
    'A008683',
  ],
  'signed:1 -1 -1 0 -1 1 -1 0 0 1': [
    'signed:1 seq:-1 seq:-1 0 seq:-1 1 seq:-1,0,0,1',
    'Showing 1-10 of 7814',
    'A008683',
  ],
  '-6227020801 87178291200 -1307674368000 20922789888000': [
    'seq:-6227020801 87178291200 seq:-1307674368000 20922789888000',
    'No results.',
  ],
  '1 -1 1 -1': ['1 seq:-1 1 seq:-1', 'Too many results. Please narrow search.'],
  '14 42': ['14 42', 'Showing 1-10 of 30017', 'A000203'],
  'signed:1,-1,-1,0,-1,1,-1,0,0,1': [
    'signed:1,-1,-1,0,-1,1,-1,0,0,1',
    'Showing 1-10 of 12',
    'A008683',
  ],
  '1 2 3 -5 6 7': ['seq:1,2,3 seq:-5,6,7', 'Showing 1-10 of 6967', 'A238442'],
  '1 1 _ 3 5 8': ['seq:1,1,_,3,5,8', 'Showing 1-10 of 344', 'A000045'],
  '1548008755920 _ 4052739537881 6557470319842': [
    'seq:1548008755920,_,4052739537881,6557470319842',
    'Showing 1-1 of 1',
    'A370071',
  ],
  '190392490709135 _ 498454011879264 _ 1304969544928657': [
    'seq:190392490709135,_,498454011879264,_,1304969544928657',
    'No results.',
  ],
  '_ 1548008755920 2504730781961 4052739537881 6557470319842 10610209857723': [
    'seq:1548008755920,2504730781961,4052739537881,6557470319842,10610209857723',
    'No results.',
  ],
} as const satisfies Record<string, EchoCapture>;

type EchoCapture = readonly [
  echo: string,
  status: string,
  firstRecord?: keyof typeof echoCaptureRecords,
];

/** A query with a captured page in {@link echoCapturePage}. */
export type EchoCaptureQuery = keyof typeof echoCaptures;

/** The captured `Search:` echo of `query`. */
export const capturedEcho = (query: EchoCaptureQuery): string => echoCaptures[query][0];

/**
 * The page oeis.org served for `query` on 2026-10-18: its echo, its status line, and its first
 * record, then synthetic rows up to the row count the status line shows.
 */
export function echoCapturePage(query: EchoCaptureQuery): string {
  const [echo, status, first]: EchoCapture = echoCaptures[query];
  const [, from = '0', to = '0'] = /^Showing (\d+)-(\d+) of/.exec(status) ?? [];
  const records = first
    ? [echoCaptureRecords[first], ...syntheticSearchRecords(Number(to) - Number(from))]
    : [];
  return searchPageText({ query: echo, records, status });
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

/**
 * What OEIS answers, with `200`, at the b-file path of an entry that has no b-file: the data line
 * under a marker first line. A reserved A-number's file is the marker line alone (51 bytes).
 */
export function synthesizedBFile(
  aNumber: string,
  terms: readonly string[],
  firstIndex = 0,
): string {
  const pairs = terms.map((value, i) => `${firstIndex + i} ${value}`);
  return `${[`# ${aNumber} (b-file synthesized from sequence entry)`, ...pairs].join('\n')}\n`;
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

/** ETag oeis.org sent for A000203's b-file on 2026-10-01. */
export const SIGMA_ETAG = '"935323c7fd9e2fdbb47daa9304f2ab62"';

let sigmaText: string | undefined;

/**
 * A000203's b-file (sigma(n), n = 1..100000, then four blank lines), rebuilt from the formula. It is
 * byte-identical to the file oeis.org served on 2026-10-01: 1,214,182 bytes, sha256 `c3e2cd7e…bb2d`.
 * The first 1 MiB ends inside the line for n = 87085; the last line is `100000 246078`.
 */
export function sigmaBFile(): string {
  if (sigmaText !== undefined) return sigmaText;
  const last = 100_000;
  const sigma = new Array<number>(last + 1).fill(0);
  for (let d = 1; d <= last; d++) {
    for (let m = d; m <= last; m += d) sigma[m] = (sigma[m] ?? 0) + d;
  }
  const lines: string[] = [];
  for (let n = 1; n <= last; n++) lines.push(`${n} ${sigma[n]}\n`);
  sigmaText = `${lines.join('')}\n\n\n\n`;
  return sigmaText;
}

/** sigma(n), the value on line n of {@link sigmaBFile}. */
export function sigmaOf(n: number): string {
  let sum = 0;
  for (let d = 1; d * d <= n; d++) {
    if (n % d === 0) sum += d === n / d ? d : d + n / d;
  }
  return String(sum);
}

/** ETag oeis.org sent for A000032's b-file on 2026-10-01. */
export const LUCAS_ETAG = '"6ce0685385a334773f8b4cb832838022"';

let lucasText: string | undefined;

/**
 * A000032's b-file (Lucas numbers, n = 0..4775, lines up to 1,004 bytes, no final newline), rebuilt
 * from the recurrence. It is byte-identical to the file oeis.org served on 2026-10-01: 2,412,957
 * bytes, sha256 `db01c6af…2413`, three 1 MiB pages.
 */
export function lucasBFile(): string {
  if (lucasText !== undefined) return lucasText;
  const lines: string[] = [];
  let [a, b] = [2n, 1n];
  for (let n = 0; n <= 4775; n++) {
    lines.push(`${n} ${a}`);
    [a, b] = [b, a + b];
  }
  lucasText = lines.join('\n');
  return lucasText;
}

const MIB = 1_048_576;

let stepped: { body: string; lastN: number } | undefined;

/**
 * A b-file whose line width jumps twice, so the bytes per index of its early pages underestimate
 * where a late index sits: `n 1` lines to 1 MiB, then 40-digit values to 2 MiB, then 990-digit
 * values to 6 MiB. 6,291,778 bytes, n = 0..154902, seven 1 MiB pages.
 */
export function steppedBFile(): { body: string; lastN: number } {
  if (stepped) return stepped;
  const lines: string[] = [];
  let bytes = 0;
  let n = 0;
  for (const [value, end] of [
    ['1', MIB],
    ['7'.repeat(40), 2 * MIB],
    ['9'.repeat(990), 6 * MIB],
  ] as const) {
    while (bytes < end) {
      const line = `${n++} ${value}\n`;
      lines.push(line);
      bytes += line.length;
    }
  }
  stepped = { body: lines.join(''), lastN: n - 1 };
  return stepped;
}

let longLine: { body: string; longN: number } | undefined;

/**
 * A b-file with one 6,000-byte line, n = `longN`, running from byte 1,043,577 to 1,049,576: it
 * starts before the second page's first byte (1 MiB − 4 KiB) and ends past the first page's last
 * (1 MiB − 1), so neither page holds it whole. Every other line is `n 3n`; 1,248,581 bytes.
 */
export function longLineBFile(): { body: string; longN: number } {
  if (longLine) return longLine;
  const lines: string[] = [];
  let bytes = 0;
  let n = 0;
  const push = (line: string) => {
    lines.push(line);
    bytes += line.length;
    n++;
  };
  while (bytes < MIB - 5_000) push(`${n} ${n * 3}\n`);
  const longN = n;
  push(`${n} ${'5'.repeat(6_000 - String(n).length - 2)}\n`);
  while (bytes < MIB + 200_000) push(`${n} ${n * 3}\n`);
  longLine = { body: lines.join(''), longN };
  return longLine;
}

let trailingComments: { body: string; lastN: number } | undefined;

/**
 * A b-file that ends in 15,052 bytes of `#` comment lines: `n 3n` pairs to n = `lastN` (83594),
 * ending at byte 1,038,585, then comments to 1,053,637 bytes, so its second 1 MiB page, from
 * byte 1,044,480, holds no pairs.
 */
export function trailingCommentsBFile(): { body: string; lastN: number } {
  if (trailingComments) return trailingComments;
  const lines: string[] = [];
  let bytes = 0;
  let n = 0;
  while (bytes < MIB - 10_000) {
    const line = `${n} ${n * 3}\n`;
    lines.push(line);
    bytes += line.length;
    n++;
  }
  while (bytes < MIB + 5_000) {
    const line = `# comment ${'x'.repeat(60)}\n`;
    lines.push(line);
    bytes += line.length;
  }
  trailingComments = { body: lines.join(''), lastN: n - 1 };
  return trailingComments;
}

/**
 * A two-page b-file of 28-byte lines (`000000 77777777777777777777\n`, n = 0..39999, 1,120,000
 * bytes), with the line of each n in `junk` replaced by a 28-byte line that is not a pair
 * (`039000 unavailable         `). The first 1 MiB ends 4 bytes into the line for n = 37449
 * (`0374`), and the second page, from byte 1,044,480, opens on the last 3 bytes of the line for
 * n = 37302 (`777`): both cut fragments are lone digit runs, so either would read as malformed.
 */
export function fixedWidthBFile(junk: readonly number[] = []): string {
  const skip = new Set(junk);
  const lines: string[] = [];
  for (let n = 0; n < 40_000; n++) {
    const value = skip.has(n) ? 'unavailable'.padEnd(20) : '7'.repeat(20);
    lines.push(`${String(n).padStart(6, '0')} ${value}\n`);
  }
  return lines.join('');
}

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
