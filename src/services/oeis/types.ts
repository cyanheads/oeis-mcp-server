/**
 * @fileoverview Domain types for the OEIS service: normalized records, search pages, and b-file reads.
 * @module services/oeis/types
 */

/** One summary row parsed from a `/search?fmt=text` page. */
export interface SequenceSummary {
  /** Zero-padded A-number, e.g. `A000108`. */
  aNumber: string;
  /** Author line from `%A`, as the record's `author`; absent on a reserved or recycled A-number. */
  author?: string;
  /** First integer of `offset`: the index n of the first term. Absent with `offset`. */
  firstIndex?: number;
  /** Keyword flags from `%K`. */
  keywords: string[];
  /** Legacy book ids from `%I`, e.g. `["M0692", "N0256"]`; absent when it names none or is unreadable. */
  legacyIds?: string[];
  /**
   * Last edit from `%I`, read as America/New_York time and written ISO 8601 with offset, as the
   * record's `modified`; absent when `%I` is missing or unreadable.
   */
  modified?: string;
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

/**
 * Result of reading a b-file. A file is read in pages of up to 1 MiB: the first page (bytes 0 to
 * 1 MiB − 1) on every call, and a later page only when `fromIndex` lies past the first.
 */
export type BFileRead =
  | {
      /** True while the file goes on past `lastIndex`. */
      cut: boolean;
      /** n of the file's first pair; absent when its first page holds none. */
      firstIndex?: number;
      /**
       * Set on a file larger than 1 MiB that cannot be read past its first page: upstream answered
       * without byte ranges or a strong ETag to pin later pages to one version of the file.
       */
      firstMibOnly?: true;
      /** Highest n among the pages of this version of the file read so far, this call's or cached. */
      lastIndex?: number;
      /** The n to ask for next when the file goes on past the last pair of `terms`. */
      nextIndex?: number;
      /** Total file size when upstream stated it (`Content-Range` total or `Content-Length`). */
      sizeInBytes?: number;
      /**
       * Set when a line just before `terms[0]` is longer than the 4 KiB overlap between pages, so
       * neither page holds it whole and it was skipped.
       */
      skippedLine?: true;
      status: 'ok';
      /**
       * Pairs of the page holding `fromIndex` (the first page when it is unset), in file order; `#`
       * comments and non-matching lines skipped. Empty when `unreached`.
       */
      terms: BFileTerm[];
      /**
       * Set when the page reads one call may make did not reach `fromIndex`; the pages read are
       * cached, so a later call starts closer.
       */
      unreached?: true;
    }
  /** The entry has no b-file: a `404`, or a file OEIS synthesized from the data line. */
  | { status: 'missing' };

/** Per-call options shared by the service's upstream methods. */
export interface UpstreamCallOptions {
  /** Total wall-clock budget for this call's attempts, backoffs, and queue wait. Default 50 s. */
  deadlineMs?: number;
}

/** Options for {@link BFileRead} retrieval. */
export interface BFileOptions extends UpstreamCallOptions {
  /** The n the caller starts from; a file larger than 1 MiB is read at the page that holds it. */
  fromIndex?: number | undefined;
}
