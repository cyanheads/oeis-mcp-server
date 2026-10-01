/**
 * @fileoverview oeis_get_sequence — fetches one OEIS entry by A-number with its sections, or the
 * core fields plus a section outline when the entry exceeds the response budget.
 * @module mcp-server/tools/definitions/oeis-get-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatOutline, outlineOnOverflow, selectSections } from '@cyanheads/mcp-ts-core/utils';
import { blockquote, fence, inline } from '@/mcp-server/shared/markdown.js';
import { ANumberSchema, blankAsUnset } from '@/mcp-server/shared/oeis-schemas.js';
import { getOeisService } from '@/services/oeis/oeis-service.js';
import { SECTION_NAMES, type SectionName, type SequenceRecord } from '@/services/oeis/types.js';

/**
 * Outline budget for the eight sections, in serialized-JSON characters: `outlineOnOverflow`
 * measures `JSON.stringify(...).length` (UTF-16 code units), which equals bytes only for ASCII.
 */
const OUTLINE_BUDGET_CHARS = 24_000;

const lineSection = (what: string) =>
  z
    .array(z.string())
    .optional()
    .describe(
      `${what}, one element per upstream line, written by OEIS contributors. Present on a full entry or when selected.`,
    );

const SequenceOutputSchema = z.object({
  kind: z
    .enum(['full', 'outline'])
    .describe(
      'full: every section (or the selected ones) is included. outline: the entry is too large, so sections lists the sections to request by name.',
    ),
  aNumber: z.string().describe('A-number, e.g. "A000045".'),
  name: z.string().describe('Sequence name, written by OEIS contributors.'),
  terms: z
    .array(z.string())
    .describe('Data-line terms as exact decimal strings, signs kept; the first is a(firstIndex).'),
  offset: z
    .string()
    .describe(
      'Offset "i,p": i is the index n of the first term, p the 1-based position of the first term with |a(n)| > 1.',
    ),
  firstIndex: z.number().describe('The index n of the first term (the first number of offset).'),
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
    .describe('Programs that compute the terms. Present on a full entry or when selected.'),
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
    .describe('Link lines. Present on a full entry or when selected.'),
  crossReferences: lineSection('Cross-reference lines naming related A-numbers'),
  extensions: lineSection('Extension lines: who added terms or corrections, and when'),
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
    .describe('Outline only: how to request sections that fit the response budget.'),
});

/** The tool's output shape, also served by the `oeis://sequence/{aNumber}` resource. */
export type SequenceOutput = z.infer<typeof SequenceOutputSchema>;

/**
 * Shapes a normalized record into the tool output. `sections` projects the core plus exactly those
 * sections; otherwise `outline: true` outlines an entry whose sections exceed 24,000 characters of
 * serialized JSON, and `outline: false` returns every section whatever the size.
 */
export function buildSequenceOutput(
  record: SequenceRecord,
  options: { outline: boolean; sections?: readonly SectionName[] | undefined },
): SequenceOutput {
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
  if (options.sections?.length) {
    return { kind: 'full', ...core, ...selectSections(heavy, [...options.sections]) };
  }
  if (!options.outline) return { kind: 'full', ...core, ...heavy };

  const result = outlineOnOverflow(heavy, { budget: OUTLINE_BUDGET_CHARS });
  if (result.kind === 'full') return { ...core, ...result };
  return { kind: 'outline', ...core, sections: result.sections, outlineNotice: result.notice };
}

/** Guidance for withdrawn, reserved, and recycled A-numbers. */
function lifecycleNotice(keywords: readonly string[]): string | undefined {
  if (keywords.includes('dead')) {
    return 'This entry is withdrawn (keyword dead); its name gives the reason and usually the replacement A-number — pass that to oeis_get_sequence.';
  }
  if (keywords.includes('allocated') || keywords.includes('recycled')) {
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
function quotedLines(heading: string, lines: readonly string[]): string[] {
  return [`## ${heading}`, lines.length ? lines.map(blockquote).join('\n\n') : 'None.'];
}

export const oeisGetSequence = tool('oeis_get_sequence', {
  title: 'Get OEIS Sequence',
  description:
    'Fetch one OEIS entry by A-number. Returns the name, data-line terms, offset, keywords, author, dates, and the sections: comments, formulas (recurrences and generating functions), examples, programs (Maple, Mathematica, PARI, Python, …), references, links, cross-references, and extensions. When the sections together exceed 24,000 characters of serialized JSON, the core fields come back with a section outline instead; call again with sections to pick what to read.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aNumber: ANumberSchema,
    sections: blankAsUnset(z.array(z.enum(SECTION_NAMES)).optional()).describe(
      'Sections to return with the core fields, whatever their size, e.g. ["formulas", "programs"]. Omit (or pass []) for the full entry, or the core fields plus an outline when the entry is large.',
    ),
  }),
  output: SequenceOutputSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the entry is withdrawn (dead) or its A-number is reserved or recycled.',
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
    const record = await getOeisService().getRecord(input.aNumber, ctx);
    if (!record) {
      throw ctx.fail('sequence_not_found', `OEIS has no entry ${input.aNumber}.`, {
        aNumber: input.aNumber,
      });
    }
    const notice = lifecycleNotice(record.keywords);
    if (notice) ctx.enrich.notice(notice);
    return buildSequenceOutput(record, { outline: true, sections: input.sections });
  },

  format: (result) => {
    const lines = [
      `# ${result.aNumber}: ${inline(result.name)}`,
      '',
      `**Kind:** ${result.kind}`,
      `**Terms:** ${result.terms.length ? inline(result.terms.join(', ')) : 'none listed'}`,
      `**Offset:** ${inline(result.offset)} (first term is a(${result.firstIndex}))`,
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
    if (result.comments) blocks.push(quotedLines('Comments', result.comments).join('\n\n'));
    if (result.formulas) blocks.push(quotedLines('Formulas', result.formulas).join('\n\n'));
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
    if (result.references) blocks.push(quotedLines('References', result.references).join('\n\n'));
    if (result.links) {
      const linkLines = result.links.map(
        (link) =>
          `- ${inline(link.text)}${link.urls.length ? ` — ${link.urls.map(codeSpan).join(' ')}` : ''}`,
      );
      blocks.push(['## Links', linkLines.length ? linkLines.join('\n') : 'None.'].join('\n\n'));
    }
    if (result.crossReferences) {
      blocks.push(quotedLines('Cross-references', result.crossReferences).join('\n\n'));
    }
    if (result.extensions) blocks.push(quotedLines('Extensions', result.extensions).join('\n\n'));

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
  },
});
