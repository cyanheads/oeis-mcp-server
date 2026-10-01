/**
 * @fileoverview oeis_list_reference — decodes OEIS vocabulary (keyword flags, search syntax, and
 * identifier and offset conventions) from static tables. No upstream call.
 * @module mcp-server/tools/definitions/oeis-list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { inline } from '@/mcp-server/shared/markdown.js';

const TOPICS = ['keywords', 'search_syntax', 'identifiers'] as const;
type Topic = (typeof TOPICS)[number];

interface ReferenceEntry {
  description: string;
  name: string;
}

interface ReferenceTable {
  entries: ReferenceEntry[];
  notes: string[];
}

/** Static vocabulary, from oeis.org/eishelp2.html and oeis.org/hints.html (verified 2026-09-29). */
const REFERENCE: Record<Topic, ReferenceTable> = {
  keywords: {
    entries: [
      { name: 'base', description: 'Depends on the base used to write the numbers.' },
      { name: 'bref', description: 'Too short to analyze.' },
      {
        name: 'changed',
        description: 'Changed in the last 2–3 weeks. Set automatically.',
      },
      { name: 'cofr', description: 'Continued fraction expansion of a number.' },
      {
        name: 'cons',
        description:
          'Decimal expansion of a constant. The first number of the offset is the number of digits before the decimal point.',
      },
      { name: 'core', description: 'An important sequence.' },
      {
        name: 'dead',
        description:
          'Erroneous or duplicated entry; the name points to the correct version, usually by A-number.',
      },
      { name: 'dumb', description: 'An unimportant sequence.' },
      { name: 'easy', description: 'Easy to produce the terms.' },
      {
        name: 'eigen',
        description: 'An eigensequence: fixed under some transform.',
      },
      { name: 'fini', description: 'A finite sequence.' },
      { name: 'frac', description: 'Numerators or denominators of a sequence of rationals.' },
      { name: 'full', description: 'The full sequence is given (implies fini).' },
      { name: 'hard', description: 'The next term is unknown and hard to find.' },
      { name: 'hear', description: 'Worth listening to as music.' },
      {
        name: 'less',
        description: 'Less interesting; less likely to be the sequence being searched for.',
      },
      { name: 'look', description: 'Has an interesting graph.' },
      { name: 'more', description: 'More terms are needed.' },
      {
        name: 'mult',
        description: 'Multiplicative: a(mn) = a(m)a(n) whenever gcd(m,n) = 1.',
      },
      {
        name: 'new',
        description: 'Added or modified in about the last 2 weeks. Set automatically.',
      },
      { name: 'nice', description: 'An exceptionally nice sequence.' },
      {
        name: 'nonn',
        description: 'Every displayed term is nonnegative. Later terms are not guaranteed to be.',
      },
      { name: 'obsc', description: 'Obscure.' },
      { name: 'probation', description: 'Provisional entry; may be deleted.' },
      { name: 'sign', description: 'Contains negative numbers.' },
      {
        name: 'tabf',
        description: 'An irregular triangle, or a fixed-width table, read by rows.',
      },
      {
        name: 'tabl',
        description: 'A regular triangle read by rows, or a square array read by antidiagonals.',
      },
      { name: 'uned', description: 'Not yet edited.' },
      { name: 'unkn', description: 'Little is known; an unsolved problem.' },
      { name: 'walk', description: 'Counts walks or self-avoiding paths.' },
      { name: 'word', description: 'Depends on the words of some language.' },
      {
        name: 'allocated',
        description: 'The A-number is reserved for a sequence not yet published; no data.',
      },
      {
        name: 'recycled',
        description: 'The A-number was freed and is being reused; no published data.',
      },
    ],
    notes: [
      'Keywords appear in each entry\'s keywords list and as the keyword: search prefix, e.g. oeis_search_sequences with "keyword:nice keyword:core".',
      'An entry usually carries several keywords. keywords changed and new are set automatically and come and go as the entry is edited.',
    ],
  },
  search_syntax: {
    entries: [
      {
        name: 'id:',
        description:
          'Look up by A-number, e.g. id:A000045; join several with | (id:A000045|id:A000108).',
      },
      {
        name: 'seq:',
        description:
          'Terms in this order, consecutively, ignoring signs, e.g. seq:1,2,5,14,42. Bare comma-separated numbers are read as seq:.',
      },
      { name: 'signed:', description: 'Like seq:, but the signs must match too.' },
      {
        name: 'subseq:',
        description: 'Terms in this order, not necessarily consecutive, ignoring signs.',
      },
      { name: 'signedsubseq:', description: 'Like subseq:, but the signs must match too.' },
      { name: 'name:', description: 'Words in the sequence name.' },
      { name: 'offset:', description: 'The offset line, e.g. offset:0.' },
      { name: 'comment:', description: 'Words in the comment lines.' },
      { name: 'ref:', description: 'Words in the reference lines.' },
      { name: 'link:', description: 'Words in the link lines.' },
      { name: 'formula:', description: 'Text in the formula lines.' },
      { name: 'example:', description: 'Text in the example lines.' },
      { name: 'maple:', description: 'Text in the Maple programs.' },
      { name: 'mathematica:', description: 'Text in the Mathematica programs.' },
      { name: 'program:', description: 'Text in programs in other languages (PARI, Python, …).' },
      { name: 'xref:', description: 'Text in the cross-reference lines, e.g. xref:A000045.' },
      {
        name: 'keyword:',
        description:
          'A keyword flag, e.g. keyword:nice. oeis_list_reference topic keywords lists them.',
      },
      { name: 'author:', description: 'Words in the author line.' },
      { name: 'extension:', description: 'Words in the extension lines.' },
      {
        name: '|',
        description:
          'OR between alternatives, written with no spaces around it: id:A000045|id:A000108.',
      },
      {
        name: '-prefix:',
        description:
          'Exclude matches, e.g. -keyword:dead. "A000045 -id:A000045" lists the entries that mention A000045.',
      },
      { name: '~n', description: 'Exclude the number n from a space-separated list of numbers.' },
      {
        name: '"…"',
        description: 'Match an exact phrase. Numbers quoted one by one match in any order.',
      },
      { name: '_', description: 'One unknown term in a run of terms: 1,2,_,5,8,13.' },
      { name: '__', description: 'Any run of unknown terms inside a run of terms.' },
      { name: '#n', description: 'The number n anywhere in the entry.' },
      {
        name: 'decimal constants',
        description: 'A decimal such as 3.14159 is converted to its digit sequence 3,1,4,1,5,9.',
      },
      {
        name: 'sort: relevance',
        description:
          'Default order: query score, then how many entries reference the sequence, then A-number.',
      },
      { name: 'sort: number', description: 'Ascending A-number.' },
      { name: 'sort: created', description: 'Newest entry first.' },
      { name: 'sort: modified', description: 'Most recently edited first.' },
      {
        name: 'paging',
        description:
          '10 results per page; start takes 0, 10, … 100, so at most 110 results of one query are reachable without an OEIS account.',
      },
    ],
    notes: [
      'An unknown prefix is searched as plain words rather than rejected, so a misspelled prefix usually returns no results.',
      'A query OEIS judges too broad, such as one common word or a two-term run, returns no rows ("Too many results"); add a word, a quoted phrase, or a prefix.',
      'For a run of terms, oeis_identify_sequence also reports the index where the run begins and can ignore signs.',
    ],
  },
  identifiers: {
    entries: [
      {
        name: 'A-number',
        description:
          'The permanent ID of an entry: A plus 6 digits (A000045), 7 digits past A999999. The tools also accept a000045, A45, 45, and an oeis.org sequence URL.',
      },
      {
        name: 'M-number',
        description:
          'Legacy ID from the 1995 Encyclopedia of Integer Sequences, e.g. M0692. Not an A-number: search it as a word with oeis_search_sequences. Entries list theirs in legacyIds.',
      },
      {
        name: 'N-number',
        description:
          'Legacy ID from the 1973 Handbook of Integer Sequences, e.g. N0256. Search it the same way as an M-number.',
      },
      {
        name: 'offset',
        description:
          'Written "i,p". i is the index of the first term, so the data line starts at a(i) (1 for a list). p is the 1-based position of the first term with |a(n)| > 1, or 1 when every term is 0 or ±1.',
      },
      {
        name: 'offset (cons)',
        description:
          'For keyword cons (decimal expansions), the first number is the number of digits before the decimal point.',
      },
      {
        name: 'data line',
        description:
          'The terms an entry displays, about three lines (~260 characters). oeis_identify_sequence searches these.',
      },
      {
        name: 'b-file',
        description:
          'A text file at https://oeis.org/A######/b######.txt listing "n a(n)" pairs far beyond the data line. oeis_get_terms reads it (the first 1 MiB).',
      },
      {
        name: 'referenceCount',
        description:
          'How many OEIS entries mention this A-number, the entry itself included. oeis_get_cross_refs direction incoming lists them.',
      },
      {
        name: 'terms',
        description:
          'Every term travels as an exact decimal string; values routinely exceed what a JSON number holds.',
      },
    ],
    notes: [
      'Cite reused OEIS content as The On-Line Encyclopedia of Integer Sequences with the sequence URL (https://oeis.org/A######); the content is CC BY-SA 4.0.',
    ],
  },
};

export const oeisListReference = tool('oeis_list_reference', {
  title: 'List OEIS Reference',
  description:
    'Look up OEIS vocabulary used by the other tools: keyword flags (nonn, core, tabl, cons, …), search syntax (prefixes, operators, wildcards, sort orders, paging window), and identifier conventions (A-numbers, legacy M/N numbers, offsets, b-files).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'keywords: keyword flags such as nonn, core, tabl. search_syntax: prefixes, operators, wildcards, sort orders, and paging. identifiers: A-numbers, legacy M/N numbers, offsets, and b-files.',
      ),
  }),
  output: z.object({
    topic: z.string().describe('The topic listed.'),
    entries: z
      .array(
        z
          .object({
            name: z.string().describe('The keyword, prefix, operator, or identifier.'),
            description: z.string().describe('What it means and how to use it.'),
          })
          .describe('One vocabulary entry.'),
      )
      .describe('Vocabulary entries for the topic.'),
    notes: z.array(z.string()).describe('Usage notes that apply across the topic.'),
  }),

  handler(input) {
    return { topic: input.topic, ...REFERENCE[input.topic] };
  },

  format: (result) => {
    const lines = [`# OEIS reference: ${result.topic}`, ''];
    for (const entry of result.entries) {
      lines.push(`- **${inline(entry.name)}**: ${inline(entry.description)}`);
    }
    if (result.notes.length) {
      lines.push('', '## Notes', '');
      for (const note of result.notes) lines.push(`- ${inline(note)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
