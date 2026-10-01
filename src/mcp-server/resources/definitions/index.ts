/**
 * @fileoverview Barrel collecting every resource definition registered with `createApp()`.
 * @module mcp-server/resources/definitions
 */

import type { AnyResourceDefinition } from '@cyanheads/mcp-ts-core/resources';
import { oeisSequenceResource } from './oeis-sequence.resource.js';

/** Every resource the server registers. */
export const allResourceDefinitions: AnyResourceDefinition[] = [oeisSequenceResource];
