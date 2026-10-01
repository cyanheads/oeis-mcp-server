/**
 * @fileoverview Domain types for the OEIS service: normalized records, search pages, and b-file reads.
 * @module services/oeis/types
 */

/** One summary row parsed from a `/search?fmt=text` page. */
export interface SequenceSummary {
  /** Zero-padded A-number, e.g. `A000108`. */
  aNumber: string;
  /** First integer of `offset`: the index n of the first term. Absent with `offset`. */
  firstIndex?: number;
  /** Keyword flags from `%K`. */
  keywords: string[];
  /** Sequence name from `%N`. */
  name: string;
  /** Offset line from `%O`, e.g. `"0,3"`; absent on a reserved or recycled A-number. */
  offset?: string;
  /** Data-line terms (`%S`+`%T`+`%U`), signed values kept, as decimal strings. */
  terms: string[];
  /** Canonical sequence page URL. */
  url: string;
}

/** Sort orders `/search` honors. `relevance` sends no `sort` parameter. */
export type SearchSort = 'relevance' | 'number' | 'created' | 'modified';

/** Outcome a `/search?fmt=text` status line reports. */
export type SearchStatus = 'results' | 'none' | 'too_many';

/** A parsed `/search?fmt=text` page. */
export interface SearchPage {
  /** The query as OEIS parsed it (the `Search:` line, lowercased upstream). */
  effectiveQuery: string;
  /** Summary rows on this page, in upstream (relevance or requested sort) order. */
  rows: SequenceSummary[];
  /**
   * Zero-based offset of the first row OEIS served (`Showing a-b`: a − 1); present on a `results`
   * page. Below the requested start when that start was past the last result, since OEIS then
   * serves the last page.
   */
  start?: number;
  /** Which status line the page carried. */
  status: SearchStatus;
  /** Total matches upstream reported; 0 for `none`, absent for `too_many`. */
  total?: number;
}

/** Parameters for {@link SearchPage} retrieval. */
export interface SearchParams {
  /** OEIS query string, sent as-is. */
  q: string;
  /** Result order. */
  sort: SearchSort;
  /** Zero-based result offset, a multiple of 10 from 0 to 100. */
  start: number;
}

/** One program block from the `maple`, `mathematica`, or `program` fields. */
export interface SequenceProgram {
  /** Program text, one upstream line per text line, the `(Lang) ` tag removed. */
  code: string;
  /** Language label (`Maple`, `Mathematica`, or the `(Lang)` tag); absent when the lines carry none. */
  language?: string;
}

/** One `link` line, decoded. */
export interface SequenceLink {
  /** The line with HTML tags stripped and entities decoded. */
  text: string;
  /** Absolute URL of every `<a href>` on the line. */
  urls: string[];
}

/** The eight selectable record sections, one array each. */
export interface SequenceSections {
  comments: string[];
  crossReferences: string[];
  examples: string[];
  extensions: string[];
  formulas: string[];
  links: SequenceLink[];
  programs: SequenceProgram[];
  references: string[];
}

/** Section names, in the order a full record presents them. */
export const SECTION_NAMES = [
  'comments',
  'formulas',
  'examples',
  'programs',
  'references',
  'links',
  'crossReferences',
  'extensions',
] as const satisfies readonly (keyof SequenceSections)[];

/** A selectable section name. */
export type SectionName = (typeof SECTION_NAMES)[number];

/** Core (non-section) fields of a normalized record. */
export interface SequenceCore {
  aNumber: string;
  author?: string;
  /** Absolute b-file URL when a `link` line points at `/A######/b######.txt`. */
  bFileUrl?: string;
  created?: string;
  /** First integer of `offset`: the index n of the first term. Absent with `offset`. */
  firstIndex?: number;
  keywords: string[];
  legacyIds?: string[];
  modified?: string;
  name: string;
  /** Offset `"i,p"`; absent on a reserved or recycled A-number, which OEIS publishes without one. */
  offset?: string;
  /** Entries mentioning this A-number, the entry itself included. */
  referenceCount: number;
  revision: number;
  terms: string[];
  url: string;
}

/** A normalized `/A######?fmt=json` record. */
export type SequenceRecord = SequenceCore & SequenceSections;

/** One `n a(n)` pair from a b-file. */
export interface BFileTerm {
  n: number;
  value: string;
}

/** Result of reading a b-file. */
export type BFileRead =
  | {
      /** True when the file exceeds the 1 MiB read and was cut. */
      cut: boolean;
      /** Total file size when upstream stated it (`Content-Range` total or `Content-Length`). */
      sizeInBytes?: number;
      status: 'ok';
      /** Parsed pairs in file order; `#` comments and non-matching lines skipped. */
      terms: BFileTerm[];
    }
  /** The entry has no b-file: a `404`, or a file OEIS synthesized from the data line. */
  | { status: 'missing' };

/** Per-call options shared by the service's upstream methods. */
export interface UpstreamCallOptions {
  /** Total wall-clock budget for this call's attempts, backoffs, and queue wait. Default 50 s. */
  deadlineMs?: number;
}
