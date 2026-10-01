/**
 * @fileoverview Barrel collecting every tool definition registered with `createApp()`.
 * @module mcp-server/tools/definitions
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { oeisGetCrossRefs } from './oeis-get-cross-refs.tool.js';
import { oeisGetSequence } from './oeis-get-sequence.tool.js';
import { oeisGetTerms } from './oeis-get-terms.tool.js';
import { oeisIdentifySequence } from './oeis-identify-sequence.tool.js';
import { oeisListReference } from './oeis-list-reference.tool.js';
import { oeisSearchSequences } from './oeis-search-sequences.tool.js';

/** Every tool the server registers. */
export const allToolDefinitions: AnyToolDefinition[] = [
  oeisIdentifySequence,
  oeisSearchSequences,
  oeisGetSequence,
  oeisGetTerms,
  oeisGetCrossRefs,
  oeisListReference,
];
