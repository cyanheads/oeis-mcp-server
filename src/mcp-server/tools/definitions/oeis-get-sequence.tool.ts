/**
 * @fileoverview oeis_get_sequence — fetches one OEIS entry by A-number with its sections, or the
 * core fields plus a section outline when the entry exceeds the outline budget. A sections
 * selection past the response budget is cut between items and continued with fromItem.
 * @module mcp-server/tools/definitions/oeis-get-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatOutline, outlineOnOverflow, type SectionMeta } from '@cyanheads/mcp-ts-core/utils';
import { blockquote, fence, inline, offsetLine } from '@/mcp-server/shared/markdown.js';
import { ANumberSchema, blankAsUnset } from '@/mcp-server/shared/oeis-schemas.js';
import { isReservedEntry } from '@/services/oeis/normalize-record.js';
import { getOeisService } from '@/services/oeis/oeis-service.js';
import { SECTION_NAMES, type SectionName, type SequenceRecord } from '@/services/oeis/types.js';

/**
 * Outline budget for the eight sections, in serialized-JSON characters: `outlineOnOverflow`
 * measures `JSON.stringify(...).length` (UTF-16 code units), which equals bytes only for ASCII.
 */
const OUTLINE_BUDGET_CHARS = 24_000;

/**
 * Most bytes one response to a sections selection carries, as oeis_get_terms counts its slices:
 * the structuredContent JSON (the notice included) plus the content[] text, UTF-8.
 */
const RESPONSE_BUDGET_BYTES = 100_000;
const encoder = new TextEncoder();

/** One item of one section: where a cut selection stopped, and where its continuation starts. */
const ItemPositionSchema = z.object({
  section: z.enum(SECTION_NAMES).describe('Section name.'),
  index: z.number().int().min(0).describe('0-based position of the item within its section.'),
});

type ItemPosition = z.infer<typeof ItemPositionSchema>;

const lineSection = (what: string) =>
  z
    .array(z.string())
    .optional()
    .describe(
      `${what}, one element per upstream line, written by OEIS contributors. Present on a full entry or when selected; a cut selection carries only this part's lines.`,
    );

const SequenceOutputSchema = z.object({
  kind: z
    .enum(['full', 'outline'])
    .describe(
      'full: every section, or the selected ones (a selection past the 100,000-byte response budget is cut between items, and nextFromItem continues it). outline: the entry is too large, so sections lists the sections to request by name.',
    ),
  aNumber: z.string().describe('A-number, e.g. "A000045".'),
  name: z.string().describe('Sequence name, written by OEIS contributors.'),
  terms: z
    .array(z.string())
    .describe('Data-line terms as exact decimal strings, signs kept; the first is a(firstIndex).'),
  offset: z
    .string()
    .optional()
    .describe(
      'Offset "i,p": i is the index n of the first term, p the 1-based position of the first term with |a(n)| > 1. Absent on a reserved or recycled A-number (keyword allocated or recycled).',
    ),
  firstIndex: z
    .number()
    .optional()
    .describe('The index n of the first term (the first number of offset); absent with offset.'),
  keywords: z
    .array(z.string())
    .describe(
      'Keyword flags such as nonn, core, tabl; oeis_list_reference topic keywords decodes them.',
    ),
  author: z
    .string()
    .optional()
    .describe('Author line as OEIS records it; absent when the entry has none.'),
  legacyIds: z
    .array(z.string())
    .optional()
    .describe('Legacy book numbers, e.g. ["M0692", "N0256"]; absent on entries that have none.'),
  referenceCount: z
    .number()
    .describe('How many OEIS entries mention this A-number, the entry itself included.'),
  revision: z.number().describe('Revision number of the entry.'),
  created: z.string().optional().describe('When the entry was created, ISO 8601 with offset.'),
  modified: z.string().optional().describe('When the entry was last edited, ISO 8601 with offset.'),
  url: z.string().describe('Sequence page on oeis.org; cite it wherever the entry is reused.'),
  bFileUrl: z
    .string()
    .optional()
    .describe("URL of the entry's b-file of extended terms; oeis_get_terms reads it."),
  comments: lineSection('Comment lines'),
  formulas: lineSection('Formula lines: recurrences, generating functions, closed forms'),
  examples: lineSection('Example lines; whitespace matters for triangles and tables'),
  programs: z
    .array(
      z
        .object({
          language: z
            .string()
            .optional()
            .describe('Language, e.g. Maple, Mathematica, PARI, Python; absent when untagged.'),
          code: z.string().describe('Program text, one upstream line per line.'),
        })
        .describe('One program block.'),
    )
    .optional()
    .describe(
      "Programs that compute the terms. Present on a full entry or when selected; a cut selection carries only this part's blocks.",
    ),
  references: lineSection('Reference lines (books and papers)'),
  links: z
    .array(
      z
        .object({
          text: z.string().describe('The link line with HTML removed.'),
          urls: z.array(z.string()).describe('Absolute URL of every link on the line.'),
        })
        .describe('One link line.'),
    )
    .optional()
    .describe(
      "Link lines. Present on a full entry or when selected; a cut selection carries only this part's lines.",
    ),
  crossReferences: lineSection('Cross-reference lines naming related A-numbers'),
  extensions: lineSection('Extension lines: who added terms or corrections, and when'),
  nextFromItem: ItemPositionSchema.optional().describe(
    'Present when the selection was cut at the 100,000-byte response budget: the first item left out. Pass it unchanged as fromItem, with the same sections, to continue.',
  ),
  sections: z
    .array(
      z
        .object({
          name: z.string().describe('Section name to pass in sections.'),
          bytes: z
            .number()
            .describe(
              'Size of the section as serialized JSON, counted in characters (UTF-16 code units, equal to bytes for ASCII text): the unit of the 24,000 outline budget.',
            ),
        })
        .describe('One section of the entry and its size.'),
    )
    .optional()
    .describe('Outline only: the sections of the entry, largest first.'),
  outlineNotice: z
    .string()
    .optional()
    .describe('Outline only: how to request sections, and how a large selection continues.'),
});

/** The tool's output shape, also served by the `oeis://sequence/{aNumber}` resource. */
export type SequenceOutput = z.infer<typeof SequenceOutputSchema>;

/** A record's core fields and its eight sections, apart. */
function splitRecord(record: SequenceRecord) {
  const {
    comments,
    formulas,
    examples,
    programs,
    references,
    links,
    crossReferences,
    extensions,
    ...core
  } = record;
  const heavy = {
    comments,
    formulas,
    examples,
    programs,
    references,
    links,
    crossReferences,
    extensions,
  };
  return { core, heavy };
}

/**
 * The outline's re-call notice: the largest section that fits the outline budget as the worked
 * example (the smallest when none does), and how a selection past the response budget continues.
 */
function outlineNotice(sections: SectionMeta[], budget: number): string {
  const example = sections.find((section) => section.bytes <= budget) ?? sections.at(-1);
  const pick = example
    ? `, e.g. sections:["${example.name}"] (size ${example.bytes}, against the ${budget} outline budget)`
    : '';
  return `Record too large to inline. Re-call this tool with sections:[...] to retrieve specific sections${pick}. Sizes are listed per section. A selection past the 100,000-byte response budget comes back in parts: pass each part's nextFromItem as fromItem, with the same sections, for the next.`;
}

/**
 * Shapes a normalized record into the tool output for an entry read whole: `outline: true`
 * outlines an entry whose sections exceed 24,000 characters of serialized JSON, and
 * `outline: false` returns every section whatever the size.
 */
export function buildSequenceOutput(
  record: SequenceRecord,
  options: { outline: boolean },
): SequenceOutput {
  const { core, heavy } = splitRecord(record);
  if (!options.outline) return { kind: 'full', ...core, ...heavy };

  const result = outlineOnOverflow(heavy, { budget: OUTLINE_BUDGET_CHARS, notice: outlineNotice });
  if (result.kind === 'full') return { ...core, ...result };
  return { kind: 'outline', ...core, sections: result.sections, outlineNotice: result.notice };
}

/** One candidate response to a selection and its size as the caller receives it. */
interface Part {
  bytes: number;
  notice: string | undefined;
  output: SequenceOutput;
}

const utf8Bytes = (text: string) => encoder.encode(text).length;

/**
 * Pages a sections selection: the core fields plus the selected sections in record order, from
 * `fromItem` when given, cut before the first whole item that would take the response past
 * {@link RESPONSE_BUDGET_BYTES}; the first item is always kept. Each candidate is measured as the
 * caller receives it: the structuredContent JSON with the notice merged in, the `format()` text,
 * and the framework's enrichment trailer (`\n\n> ` plus the notice). `lifecycle` opens that one
 * notice; a fromItem past the end of its section and the cut add to it.
 */
function pageSelection(
  record: SequenceRecord,
  selected: readonly SectionName[],
  fromItem: ItemPosition | undefined,
  lifecycle: string | undefined,
): Part {
  const { core, heavy } = splitRecord(record);
  const items = (section: SectionName): readonly unknown[] => heavy[section];
  const itemCount = (section: SectionName) =>
    `${items(section).length} ${items(section).length === 1 ? 'item' : 'items'}`;
  const ordered = SECTION_NAMES.filter((section) => selected.includes(section));
  const walk = fromItem ? ordered.slice(ordered.indexOf(fromItem.section)) : ordered;
  const startOf = (section: SectionName) => (section === fromItem?.section ? fromItem.index : 0);
  const positions: ItemPosition[] = walk.flatMap((section) =>
    items(section)
      .slice(startOf(section))
      .map((_, i) => ({ section, index: startOf(section) + i })),
  );
  const pastEnd =
    fromItem && fromItem.index >= items(fromItem.section).length
      ? `fromItem.index ${fromItem.index} is past the end of ${fromItem.section}, which has ${itemCount(fromItem.section)}, so ${fromItem.section} comes back empty.`
      : undefined;

  /** The response carrying the first `kept` items of the walk. */
  const part = (kept: number): Part => {
    const next = positions[kept];
    const picked: [SectionName, readonly unknown[]][] = [];
    for (const section of walk) {
      const start = startOf(section);
      const end = section === next?.section ? next.index : undefined;
      if (end === start) break;
      picked.push([section, items(section).slice(start, end)]);
      if (end !== undefined) break;
    }
    const output: SequenceOutput = {
      kind: 'full',
      ...core,
      ...(Object.fromEntries(picked) as Partial<typeof heavy>),
      ...(next && { nextFromItem: next }),
    };
    const cut =
      next &&
      `Stopped before ${next.section}[${next.index}] (${next.section} has ${itemCount(next.section)}) to stay within the 100,000-byte response budget; call again with the same sections and fromItem ${JSON.stringify(next)}.`;
    const notice = [lifecycle, pastEnd, cut].filter(Boolean).join(' ') || undefined;
    const text = formatSequence(output).reduce(
      (sum, block) => sum + ('text' in block ? utf8Bytes(block.text) : 0),
      0,
    );
    const bytes =
      utf8Bytes(JSON.stringify(notice ? { ...output, notice } : output)) +
      text +
      (notice ? utf8Bytes(`\n\n> ${notice}`) : 0);
    return { bytes, notice, output };
  };

  /**
   * The fewest leading items whose JSON alone passes the budget: no part carrying them fits, so the
   * search stays below them and every part it measures stays near the budget in size, however large
   * the selection.
   */
  let reach = positions.length;
  let itemBytes = 0;
  for (const [i, { section, index }] of positions.entries()) {
    itemBytes += utf8Bytes(JSON.stringify(items(section)[index]));
    if (itemBytes > RESPONSE_BUDGET_BYTES) {
      reach = i + 1;
      break;
    }
  }
  if (reach === positions.length) {
    const whole = part(positions.length);
    if (whole.bytes <= RESPONSE_BUDGET_BYTES || positions.length <= 1) return whole;
  }
  let fit: Part | undefined;
  let low = 2;
  let high = reach - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = part(mid);
    if (candidate.bytes <= RESPONSE_BUDGET_BYTES) {
      fit = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return fit ?? part(1);
}

/** Guidance for withdrawn, reserved, and recycled A-numbers. */
function lifecycleNotice(keywords: readonly string[]): string | undefined {
  if (keywords.includes('dead')) {
    return 'This entry is withdrawn (keyword dead); its name gives the reason and usually the replacement A-number — pass that to oeis_get_sequence.';
  }
  if (isReservedEntry(keywords)) {
    return 'This A-number is reserved or recycled and has no published sequence yet.';
  }
  return;
}

/**
 * Renders an upstream URL as an inline code span, so it reads as plain text and no renderer turns
 * it into a link or emphasis. The backtick run outgrows any in the URL (a query keeps them raw).
 */
function codeSpan(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const ticks = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** Renders a line section as one blockquote per line, or "None." when the entry has no lines. */
function quotedLines(heading: string, lines: readonly string[]): string {
  return `## ${heading}\n\n${lines.length ? lines.map(blockquote).join('\n\n') : 'None.'}`;
}

/** Renders the output as markdown: the core fields, each present section, a cut's next call, and the outline. */
function formatSequence(result: SequenceOutput) {
  const lines = [
    `# ${result.aNumber}: ${inline(result.name)}`,
    '',
    `**Kind:** ${result.kind}`,
    `**Terms:** ${result.terms.length ? inline(result.terms.join(', ')) : 'none listed'}`,
    offsetLine(result.offset, result.firstIndex),
    `**Keywords:** ${result.keywords.length ? inline(result.keywords.join(', ')) : 'none'}`,
  ];
  if (result.author) lines.push(`**Author:** ${inline(result.author)}`);
  if (result.legacyIds) lines.push(`**Legacy IDs:** ${inline(result.legacyIds.join(', '))}`);
  lines.push(
    `**Referenced by:** ${result.referenceCount} entries (this one included)`,
    `**Revision:** ${result.revision}`,
  );
  if (result.created) lines.push(`**Created:** ${inline(result.created)}`);
  if (result.modified) lines.push(`**Modified:** ${inline(result.modified)}`);
  lines.push(`**URL:** ${result.url}`);
  if (result.bFileUrl) lines.push(`**b-file:** ${inline(result.bFileUrl)}`);

  const blocks: string[] = [lines.join('\n')];
  if (result.comments) blocks.push(quotedLines('Comments', result.comments));
  if (result.formulas) blocks.push(quotedLines('Formulas', result.formulas));
  if (result.examples) {
    blocks.push(
      ['## Examples', result.examples.length ? fence(result.examples.join('\n')) : 'None.'].join(
        '\n\n',
      ),
    );
  }
  if (result.programs) {
    const programBlocks = result.programs.map(
      (program) =>
        `### ${program.language ? inline(program.language) : 'Untagged'}\n\n${fence(program.code)}`,
    );
    blocks.push(
      ['## Programs', ...(programBlocks.length ? programBlocks : ['None.'])].join('\n\n'),
    );
  }
  if (result.references) blocks.push(quotedLines('References', result.references));
  if (result.links) {
    const linkLines = result.links.map(
      (link) =>
        `- ${inline(link.text)}${link.urls.length ? ` — ${link.urls.map(codeSpan).join(' ')}` : ''}`,
    );
    blocks.push(['## Links', linkLines.length ? linkLines.join('\n') : 'None.'].join('\n\n'));
  }
  if (result.crossReferences) {
    blocks.push(quotedLines('Cross-references', result.crossReferences));
  }
  if (result.extensions) blocks.push(quotedLines('Extensions', result.extensions));
  if (result.nextFromItem) {
    blocks.push(
      `**Next:** call again with the same sections and fromItem ${JSON.stringify(result.nextFromItem)}.`,
    );
  }

  const content = [{ type: 'text' as const, text: blocks.join('\n\n') }];
  if (result.sections) {
    return [
      ...content,
      ...formatOutline({
        kind: 'outline',
        sections: result.sections,
        notice: result.outlineNotice ?? '',
      }),
    ];
  }
  return content;
}

export const oeisGetSequence = tool('oeis_get_sequence', {
  title: 'Get OEIS Sequence',
  description:
    'Fetch one OEIS entry by A-number. Returns the name, data-line terms, offset, keywords, author, dates, and the sections: comments, formulas (recurrences and generating functions), examples, programs (Maple, Mathematica, PARI, Python, …), references, links, cross-references, and extensions. When the sections together exceed 24,000 characters of serialized JSON, the core fields come back with a section outline instead; call again with sections to pick what to read. A selection past 100,000 bytes comes back in parts cut between items: pass nextFromItem as fromItem, with the same sections, for the next part.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aNumber: ANumberSchema,
    sections: blankAsUnset(z.array(z.enum(SECTION_NAMES)).optional()).describe(
      'Sections to return with the core fields, e.g. ["formulas", "programs"]. A selection past the 100,000-byte response budget is cut between items; fromItem continues it. Omit (or pass []) for the full entry, or the core fields plus an outline when the entry is large.',
    ),
    fromItem: blankAsUnset(ItemPositionSchema.optional()).describe(
      "Where to resume a cut selection: the previous response's nextFromItem, passed unchanged with the same sections. The selected sections before fromItem.section are left out. Omit to start at the beginning.",
    ),
  }),
  output: SequenceOutputSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance: the entry is withdrawn (dead) or its A-number reserved or recycled; where a cut selection stopped and the call that continues it; or that fromItem lies past the end of its section.',
      ),
  },
  errors: [
    {
      reason: 'sequence_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No OEIS entry exists for the requested A-number.',
      recovery:
        'No OEIS entry has this A-number; find the right one with oeis_search_sequences or oeis_identify_sequence.',
    },
    {
      reason: 'from_item_not_selected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'fromItem is given without sections, or names a section that sections does not select.',
      recovery:
        'Pass fromItem with the same sections as the call that returned it as nextFromItem; its section must be one of them.',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The oeis.org request queue would exceed its wait budget.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org requests are paced to one every 10 seconds and the queue is backed up; wait the retryAfter seconds in the error data (30 seconds if none is shown), then call oeis_get_sequence again.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'oeis.org answered HTTP 429 Too Many Requests and retries within the call did not clear it.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'oeis.org answered 429 Too Many Requests; wait as long as the retryAfter in the error data says (seconds, or an HTTP date), or 30 seconds if none is shown, then call oeis_get_sequence again.',
    },
  ],

  async handler(input, ctx) {
    const { aNumber, fromItem, sections } = input;
    if (fromItem && !sections?.includes(fromItem.section)) {
      throw ctx.fail(
        'from_item_not_selected',
        `fromItem names ${fromItem.section}, which sections does not select (${sections?.length ? sections.join(', ') : 'none given'}).`,
        { fromItem, sections: sections ?? [] },
      );
    }
    const record = await getOeisService().getRecord(aNumber, ctx);
    if (!record) {
      throw ctx.fail('sequence_not_found', `OEIS has no entry ${aNumber}.`, { aNumber });
    }
    const lifecycle = lifecycleNotice(record.keywords);
    if (!sections?.length) {
      if (lifecycle) ctx.enrich.notice(lifecycle);
      return buildSequenceOutput(record, { outline: true });
    }
    const { notice, output } = pageSelection(record, sections, fromItem, lifecycle);
    if (notice) ctx.enrich.notice(notice);
    return output;
  },

  format: formatSequence,
});
