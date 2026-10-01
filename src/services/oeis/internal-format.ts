/**
 * @fileoverview Parser for OEIS `/search?fmt=text` responses (the internal format): the `Search:`
 * echo, the status line, and the `%S %T %U %N %K %O` lines of each record.
 * @module services/oeis/internal-format
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { stripNonWebHrefs } from './normalize-record.js';
import type { SearchPage, SearchStatus, SequenceSummary } from './types.js';

const SHOWING = /^Showing (\d+)-(\d+) of (\d+)$/;
const NO_RESULTS = 'No results.';
const TOO_MANY = 'Too many results. Please narrow search.';
/** `s`: a stray CR or U+2028/U+2029 inside a line stays in the value instead of failing the match. */
const RECORD_LINE = /^%([A-Za-z]) (A\d{6,7})(?: (.*))?$/s;

interface RecordLines {
  data: string[];
  keywords?: string;
  name?: string;
  offset?: string;
}

/** Throws the non-retryable "format changed" failure for a page this parser cannot read. */
function formatChanged(detail: string): never {
  throw serviceUnavailable(`OEIS returned a search page in an unrecognized format: ${detail}`, {
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
  return formatChanged(`unknown status line "${trimmed.slice(0, 120)}"`);
}

function toSummary(aNumber: string, lines: RecordLines): SequenceSummary {
  if (lines.name === undefined) formatChanged(`record ${aNumber} has no %N line`);
  if (lines.offset === undefined) formatChanged(`record ${aNumber} has no %O line`);
  const firstIndex = Number.parseInt(lines.offset.split(',')[0] ?? '', 10);
  if (!Number.isFinite(firstIndex)) {
    formatChanged(`record ${aNumber} has an unreadable offset "${lines.offset}"`);
  }
  return {
    aNumber,
    name: stripNonWebHrefs(lines.name),
    terms: lines.data
      .join(',')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    offset: lines.offset,
    firstIndex,
    keywords: (lines.keywords ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
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
