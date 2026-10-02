/**
 * @fileoverview Parser for OEIS `/search?fmt=text` responses (the internal format): the `Search:`
 * echo, the status line, and the `%I %S %T %U %N %K %O %A` lines of each record. `%I` and `%A`
 * give a row the author, last edit, and legacy ids the JSON record carries, in the record's format.
 * @module services/oeis/internal-format
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { isReservedEntry, splitList, stripNonWebHrefs } from './normalize-record.js';
import type { SearchPage, SearchStatus, SequenceSummary } from './types.js';

const SHOWING = /^Showing (\d+)-(\d+) of (\d+)$/;
const NO_RESULTS = 'No results.';
const TOO_MANY = 'Too many results. Please narrow search.';
/** `s`: a stray CR or U+2028/U+2029 inside a line stays in the value instead of failing the match. */
const RECORD_LINE = /^%([A-Za-z]) (A\d{6,7})(?: (.*))?$/s;
/**
 * A `%I` value: legacy book ids, the `#` revision, and the wall-clock time of the last edit, e.g.
 * `M0692 N0256 #2594 Sep 23 2026 16:08:09`. Every token is fixed-width or ends at a character the
 * next token cannot start with, so a failed match is linear in the value.
 */
const ID_LINE =
  /^((?:[MN]\d{4} +)*)#\d+ +([A-Z][a-z]{2}) +(\d{2}) +(\d{4}) +(\d{2}):(\d{2}):(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/**
 * Names America/New_York's offset from UTC at an instant, e.g. `GMT-04:00`. `%I` writes the time
 * there with no zone: it matches the JSON record's `time` in that zone, summer and winter.
 */
const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  timeZoneName: 'longOffset',
});
const OFFSET_NAME = /^GMT([+-])(\d{2}):(\d{2})$/;

interface RecordLines {
  author?: string;
  data: string[];
  idLine?: string;
  keywords?: string;
  name?: string;
  offset?: string;
}

/**
 * Throws the non-retryable "format changed" failure for a page this parser cannot read. `detail` is
 * server-written: it names the part that failed, never the upstream text in it.
 */
function formatChanged(detail: string): never {
  throw serviceUnavailable(`OEIS returned a search page in an unrecognized format: ${detail}.`, {
    reason: 'upstream_unparseable',
    retryable: false,
  });
}

function readStatus(line: string | undefined): {
  start?: number;
  status: SearchStatus;
  total?: number;
} {
  const trimmed = line?.trim() ?? '';
  const showing = SHOWING.exec(trimmed);
  if (showing) {
    return { status: 'results', start: Number(showing[1]) - 1, total: Number(showing[3]) };
  }
  if (trimmed === NO_RESULTS) return { status: 'none', total: 0 };
  if (trimmed === TOO_MANY) return { status: 'too_many' };
  return formatChanged('an unknown status line');
}

function firstIndexOf(aNumber: string, offset: string): number {
  const firstIndex = Number.parseInt(offset.split(',')[0] ?? '', 10);
  if (!Number.isFinite(firstIndex)) formatChanged(`record ${aNumber} has an unreadable offset`);
  return firstIndex;
}

/**
 * America/New_York's offset from UTC at an instant, in minutes (−240 in daylight time); undefined
 * where it is not a whole number of minutes (local mean time, before 1883).
 */
function newYorkOffset(epochMs: number): number | undefined {
  const name = NEW_YORK.formatToParts(epochMs).find((part) => part.type === 'timeZoneName');
  const match = OFFSET_NAME.exec(name?.value ?? '');
  if (!match) return;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Appends America/New_York's offset to a wall-clock time `local` (`YYYY-MM-DDTHH:MM:SS`, whose
 * value read as UTC is `asUtc`). Of the zone's offsets a day either side, the larger one that holds
 * at the time wins, so a time the fall-back hour repeats reads as its first, daylight-time instance;
 * when neither holds, the time lies in the skipped spring-forward hour and takes the offset before
 * the change.
 */
function newYorkIso(local: string, asUtc: number): string | undefined {
  const before = newYorkOffset(asUtc - DAY_MS);
  const after = newYorkOffset(asUtc + DAY_MS);
  if (before === undefined || after === undefined) return;
  const holds = (offset: number) => newYorkOffset(asUtc - offset * MINUTE_MS) === offset;
  const offset = [Math.max(before, after), Math.min(before, after)].find(holds) ?? before;
  const pad = (n: number) => String(n).padStart(2, '0');
  const minutes = Math.abs(offset);
  return `${local}${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * The legacy ids and last edit a `%I` value carries, in the record's formats. Empty when the value
 * is missing, in another shape, or names a date or time that does not exist; a row never fails on it.
 */
function readIdLine(value: string | undefined): Pick<SequenceSummary, 'legacyIds' | 'modified'> {
  const match = ID_LINE.exec(value?.trim() ?? '');
  if (!match) return {};
  const [, ids = '', monthName = '', day = '', year = '', hour = '', minute = '', second = ''] =
    match;
  const month = MONTHS.indexOf(monthName);
  const local = `${year}-${String(month + 1).padStart(2, '0')}-${day}T${hour}:${minute}:${second}`;
  const asUtc = Date.UTC(+year, month, +day, +hour, +minute, +second);
  if (new Date(asUtc).toISOString().slice(0, 19) !== local) return {};
  const modified = newYorkIso(local, asUtc);
  if (modified === undefined) return {};
  const legacyIds = ids.split(' ').filter(Boolean);
  return { ...(legacyIds.length > 0 && { legacyIds }), modified };
}

/**
 * One summary row. A reserved or recycled row has no `%O` line, so no offset or firstIndex, and no
 * `%A` line, so no author.
 */
function toSummary(aNumber: string, lines: RecordLines): SequenceSummary {
  if (lines.name === undefined) formatChanged(`record ${aNumber} has no %N line`);
  const keywords = splitList(lines.keywords ?? '');
  if (lines.offset === undefined && !isReservedEntry(keywords)) {
    formatChanged(`record ${aNumber} has no %O line`);
  }
  const author = lines.author && stripNonWebHrefs(lines.author).trim();
  return {
    aNumber,
    name: stripNonWebHrefs(lines.name),
    terms: splitList(lines.data.join(',')),
    ...(lines.offset !== undefined && {
      offset: lines.offset,
      firstIndex: firstIndexOf(aNumber, lines.offset),
    }),
    keywords,
    ...(author && { author }),
    ...readIdLine(lines.idLine),
    url: `https://oeis.org/${aNumber}`,
  };
}

/**
 * Parses one `/search?fmt=text` page.
 *
 * @throws {McpError} `ServiceUnavailable` with `reason: 'upstream_unparseable'` — retryable when
 *   the body has no `Search:` line (an HTML or empty page), non-retryable when the status line or a
 *   record is in a shape this parser does not know.
 */
export function parseSearchText(text: string): SearchPage {
  const lines = text.split(/\r?\n/);
  const searchIndex = lines.findIndex((l) => l.startsWith('Search:'));
  if (searchIndex === -1) {
    throw serviceUnavailable('OEIS returned a search page without its "Search:" line.', {
      reason: 'upstream_unparseable',
    });
  }
  const effectiveQuery = (lines[searchIndex] ?? '').slice('Search:'.length).trim();
  const rest = lines.slice(searchIndex + 1);
  const statusIndex = rest.findIndex((l) => l.trim() !== '');
  const { start, status, total } = readStatus(rest[statusIndex]);

  const records = new Map<string, RecordLines>();
  if (status === 'results') {
    for (const line of rest.slice(statusIndex + 1)) {
      const match = RECORD_LINE.exec(line);
      if (!match) continue;
      const [, tag, aNumber = '', value = ''] = match;
      let rec = records.get(aNumber);
      if (!rec) {
        rec = { data: [] };
        records.set(aNumber, rec);
      }
      switch (tag) {
        case 'I':
          rec.idLine = value;
          break;
        case 'S':
        case 'T':
        case 'U':
          rec.data.push(value);
          break;
        case 'N':
          rec.name = value;
          break;
        case 'K':
          rec.keywords = value;
          break;
        case 'O':
          rec.offset = value;
          break;
        case 'A':
          rec.author = value;
          break;
      }
    }
  }

  return {
    effectiveQuery,
    status,
    ...(start !== undefined && { start }),
    ...(total !== undefined && { total }),
    rows: [...records].map(([aNumber, rec]) => toSummary(aNumber, rec)),
  };
}
