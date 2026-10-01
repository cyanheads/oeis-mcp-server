/**
 * @fileoverview Tests for oeis_list_reference through the tool contract: topic validation, the
 * three static tables, no upstream access, and `format()` carrying every entry and note.
 * @module tests/tools/oeis-list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { oeisListReference } from '@/mcp-server/tools/definitions/oeis-list-reference.tool.js';
import { blocksText } from '../fixtures/tool-service.js';

vi.mock('@/services/oeis/oeis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/oeis/oeis-service.js')>()),
  getOeisService: () => {
    throw new Error('oeis_list_reference must not reach the upstream service');
  },
}));

type Topic = 'keywords' | 'search_syntax' | 'identifiers';
const TOPICS: Topic[] = ['keywords', 'search_syntax', 'identifiers'];

interface Table {
  entries: { description: string; name: string }[];
  notes: string[];
  topic: string;
}

async function lookup(topic: Topic) {
  const result = await runToolContract(oeisListReference, { topic });
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  return { result, table: result.structuredContent as unknown as Table, text };
}

describe('oeis_list_reference', () => {
  describe('input validation', () => {
    it.each([
      ['an unknown topic', { topic: 'sort_orders' }],
      ['a blank topic (required, never read as unset)', { topic: '' }],
      ['a differently cased topic', { topic: 'Keywords' }],
      ['no topic', {}],
      ['a non-string topic', { topic: 7 }],
    ])('rejects %s as invalid arguments', async (_label, input) => {
      const result = await runToolContract(oeisListReference, input as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
    });

    it('parses each declared topic unchanged', () => {
      for (const topic of TOPICS) {
        expect(oeisListReference.input.parse({ topic })).toEqual({ topic });
      }
    });
  });

  describe.each(TOPICS)('topic %s', (topic) => {
    it('returns the table for that topic, valid against the output schema', async () => {
      const { result, table } = await lookup(topic);
      expect(result.isError).toBeUndefined();
      expect(table.topic).toBe(topic);
      expect(table.entries.length).toBeGreaterThan(0);
      expect(table.notes.length).toBeGreaterThan(0);
      expect(table).toEqual(expect.schemaMatching(oeisListReference.output));
      for (const entry of table.entries) {
        expect(entry.name.trim()).not.toBe('');
        expect(entry.description.trim()).not.toBe('');
      }
    });

    it('lists each entry name once', async () => {
      const { table } = await lookup(topic);
      const names = table.entries.map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('renders every entry name, description, and note in content[]', async () => {
      const { table, text } = await lookup(topic);
      expect(text).toContain(`# OEIS reference: ${topic}`);
      for (const entry of table.entries) {
        expect(text).toContain(`- **${entry.name}**: ${entry.description}`);
      }
      expect(text).toContain('## Notes');
      for (const note of table.notes) expect(text).toContain(`- ${note}`);
    });

    it('serves the same answer on every call', async () => {
      const first = (await lookup(topic)).table;
      const second = (await lookup(topic)).table;
      expect(second).toEqual(first);
    });
  });

  describe('vocabulary the other tools depend on', () => {
    it('decodes the lifecycle keywords oeis_get_sequence reports on (dead, allocated, recycled)', async () => {
      const { table } = await lookup('keywords');
      const names = table.entries.map((entry) => entry.name);
      expect(names).toEqual(expect.arrayContaining(['dead', 'allocated', 'recycled']));
    });

    it('decodes the search prefixes the identify tool builds (seq:, signed:) and the paging window', async () => {
      const { table } = await lookup('search_syntax');
      const names = table.entries.map((entry) => entry.name);
      expect(names).toEqual(expect.arrayContaining(['seq:', 'signed:', 'id:', 'paging']));
      const paging = table.entries.find((entry) => entry.name === 'paging');
      expect(paging?.description).toContain('110');
    });

    it('covers A-numbers, legacy M/N numbers, offsets, and b-files', async () => {
      const { table } = await lookup('identifiers');
      const names = table.entries.map((entry) => entry.name);
      expect(names).toEqual(
        expect.arrayContaining(['A-number', 'M-number', 'N-number', 'offset', 'b-file']),
      );
    });
  });

  describe('handler', () => {
    it('runs without a context feature beyond the mock and never throws', async () => {
      const input = oeisListReference.input.parse({ topic: 'keywords' });
      const result = await oeisListReference.handler(input, createMockContext());
      expect(result.topic).toBe('keywords');
    });

    it('declares itself closed-world: it reads static tables only', () => {
      expect(oeisListReference.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    });
  });

  describe('format', () => {
    it('keeps CR/LF in entry text out of the list-item slots', () => {
      const blocks = oeisListReference.format?.({
        topic: 'keywords',
        entries: [{ name: 'a\r\nb', description: 'c\nd\r\n## Injected' }],
        notes: ['e\nf\n# Also injected'],
      });
      const text = blocksText(blocks);
      expect(text).toContain('- **a b**: c d ## Injected');
      expect(text).toContain('- e f # Also injected');
      expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
        '# OEIS reference: keywords',
        '## Notes',
      ]);
    });

    it('omits the notes heading when a topic has no notes', () => {
      const blocks = oeisListReference.format?.({
        topic: 'keywords',
        entries: [{ name: 'nonn', description: 'Nonnegative.' }],
        notes: [],
      });
      const text = blocksText(blocks);
      expect(text).toContain('- **nonn**: Nonnegative.');
      expect(text).not.toContain('## Notes');
    });

    it('renders an empty table as the heading alone', () => {
      const blocks = oeisListReference.format?.({ topic: 'identifiers', entries: [], notes: [] });
      expect(blocksText(blocks).trim()).toBe('# OEIS reference: identifiers');
    });
  });
});
