/**
 * @fileoverview Validates a raw `/A######?fmt=json` record and normalizes it into a
 * {@link SequenceRecord}: terms as strings, programs grouped into blocks, links decoded.
 * @module services/oeis/normalize-record
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { SequenceLink, SequenceProgram, SequenceRecord } from './types.js';

const OEIS_ORIGIN = 'https://oeis.org';
const lines = z.array(z.string()).optional();

const RawRecordSchema = z.object({
  number: z.number().int().nonnegative(),
  id: z.string().optional(),
  data: z.string(),
  name: z.string(),
  comment: lines,
  reference: lines,
  link: lines,
  formula: lines,
  example: lines,
  maple: lines,
  mathematica: lines,
  program: lines,
  xref: lines,
  ext: lines,
  keyword: z.string(),
  offset: z.string(),
  author: z.string().optional(),
  references: z.number().int(),
  revision: z.number().int(),
  time: z.string().optional(),
  created: z.string().optional(),
});

/** A `program` line that opens a new block: `(PARI) …`, `(Python) …`, `(SageMath)`. */
const PROGRAM_TAG = /^\(([A-Z][A-Za-z0-9+#/._ -]{0,24})\)(\s|$)/;
const HREF = /<a\s[^>]*?href\s*=\s*"([^"]*)"/gi;
const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Formats an OEIS sequence number as its zero-padded A-number (`45` → `A000045`). */
export function toANumber(n: number): string {
  return `A${String(n).padStart(6, '0')}`;
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (!lower.startsWith('#')) return NAMED_ENTITIES[lower] ?? match;
    const code = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function toPrograms(maple: string[], mathematica: string[], program: string[]): SequenceProgram[] {
  const blocks: SequenceProgram[] = [];
  if (maple.length) blocks.push({ language: 'Maple', code: maple.join('\n') });
  if (mathematica.length) blocks.push({ language: 'Mathematica', code: mathematica.join('\n') });

  const tagged: { language?: string; lines: string[] }[] = [];
  for (const line of program) {
    const tag = PROGRAM_TAG.exec(line);
    if (tag) {
      const rest = line.slice(tag[0].length);
      tagged.push({ language: tag[1] ?? '', lines: rest ? [rest] : [] });
      continue;
    }
    const current = tagged.at(-1);
    if (current) current.lines.push(line);
    else tagged.push({ lines: [line] });
  }
  for (const block of tagged) {
    blocks.push({
      ...(block.language !== undefined && { language: block.language }),
      code: block.lines.join('\n'),
    });
  }
  return blocks;
}

/** Schemes a link URL may carry; any other href (`javascript:`, `data:`, `mailto:`, …) is dropped. */
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/** An `href` attribute in any HTML quoting; the value lands in whichever group matched. */
const HREF_ATTRIBUTE = /\s*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>][^\s>]*))/gi;

/** The absolute URL an href resolves to against oeis.org, when its scheme is `http:` or `https:`. */
function toWebUrl(href: string): string | undefined {
  const decoded = decodeEntities(href).trim();
  const url = decoded ? URL.parse(decoded, OEIS_ORIGIN) : null;
  return url && WEB_PROTOCOLS.has(url.protocol) ? url.href : undefined;
}

/**
 * Removes every `href` attribute whose value is not an `http:`/`https:` URL from contributor-written
 * text and leaves the rest as written: `<a href="javascript:…">A000032</a>` becomes
 * `<a>A000032</a>`, which nothing can follow.
 */
export function stripNonWebHrefs(text: string): string {
  return text.replace(
    HREF_ATTRIBUTE,
    (attribute, double?: string, single?: string, bare?: string) =>
      toWebUrl(double ?? single ?? bare ?? '') === undefined ? '' : attribute,
  );
}

/** Decodes one link line: its text with tags stripped, and the absolute web URL of each href. */
function toLink(line: string): SequenceLink {
  const urls: string[] = [];
  for (const match of line.matchAll(HREF)) {
    const url = toWebUrl(match[1] ?? '');
    if (url) urls.push(url);
  }
  return { text: stripNonWebHrefs(decodeEntities(line.replace(/<[^>]*>/g, ''))).trim(), urls };
}

function findBFileUrl(aNumber: string, links: SequenceLink[]): string | undefined {
  const path = `/${aNumber}/b${aNumber.slice(1)}.txt`;
  const pointsAtBFile = links
    .flatMap((link) => link.urls)
    .some((url) => {
      const { hostname, pathname } = new URL(url);
      return (hostname === 'oeis.org' || hostname === 'www.oeis.org') && pathname === path;
    });
  return pointsAtBFile ? `${OEIS_ORIGIN}${path}` : undefined;
}

/**
 * Normalizes a parsed `/A######?fmt=json` body.
 *
 * @throws {McpError} `ServiceUnavailable` with `reason: 'upstream_unparseable'` and
 *   `retryable: false` when the object lacks a field every OEIS record carries — the record
 *   format changed, and asking again returns the same body.
 */
export function normalizeRecord(body: Record<string, unknown>): SequenceRecord {
  const parsed = RawRecordSchema.safeParse(body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw serviceUnavailable(
      `OEIS returned a sequence record in an unrecognized format (fields: ${fields.join(', ')}).`,
      { reason: 'upstream_unparseable', retryable: false },
    );
  }
  const raw = parsed.data;
  const aNumber = toANumber(raw.number);
  const firstIndex = Number.parseInt(raw.offset.split(',')[0] ?? '', 10);
  if (!Number.isFinite(firstIndex)) {
    throw serviceUnavailable(
      `OEIS returned ${aNumber} with an unreadable offset "${raw.offset}".`,
      {
        reason: 'upstream_unparseable',
        retryable: false,
      },
    );
  }
  const links = (raw.link ?? []).map(toLink);
  const text = (values: string[] | undefined) => (values ?? []).map(stripNonWebHrefs);
  const author = raw.author && stripNonWebHrefs(raw.author).trim();
  const legacyIds = raw.id?.split(/\s+/).filter(Boolean) ?? [];
  const bFileUrl = findBFileUrl(aNumber, links);

  return {
    aNumber,
    name: stripNonWebHrefs(raw.name),
    terms: splitList(raw.data),
    offset: raw.offset,
    firstIndex,
    keywords: splitList(raw.keyword),
    ...(author && { author }),
    ...(legacyIds.length > 0 && { legacyIds }),
    referenceCount: raw.references,
    revision: raw.revision,
    ...(raw.created && { created: raw.created }),
    ...(raw.time && { modified: raw.time }),
    url: `${OEIS_ORIGIN}/${aNumber}`,
    ...(bFileUrl && { bFileUrl }),
    comments: text(raw.comment),
    formulas: text(raw.formula),
    examples: text(raw.example),
    programs: toPrograms(text(raw.maple), text(raw.mathematica), text(raw.program)),
    references: text(raw.reference),
    links,
    crossReferences: text(raw.xref),
    extensions: text(raw.ext),
  };
}
