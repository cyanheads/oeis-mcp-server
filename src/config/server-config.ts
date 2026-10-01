/**
 * @fileoverview Server-specific configuration for oeis-mcp-server, parsed lazily from the environment.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  queueMaxWaitMs: z.coerce
    .number()
    .int()
    .min(0)
    .default(30_000)
    .describe(
      'Longest a call waits in the oeis.org request queue before failing with RateLimited and retryAfter.',
    ),
});

/** Parsed server configuration. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Returns the server configuration, parsing the environment on first call. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    queueMaxWaitMs: 'OEIS_QUEUE_MAX_WAIT_MS',
  });
  return _config;
}
