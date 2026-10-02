# Developer Protocol

**Server:** oeis-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.2.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

> **Read the design next:** `docs/design.md` records the tool surface, the shared input and output shapes, the upstream API behavior verified against oeis.org, the resilience table (pacing, retries, caching), and the design decisions. Update it when the surface or a decision changes.

---

## Domain

Six read-only tools and one resource over oeis.org, the On-Line Encyclopedia of Integer Sequences. Keyless; OEIS content is CC BY-SA 4.0.

| Upstream path | Format | Used by |
|:--------------|:-------|:--------|
| `/A######?fmt=json` | One record as JSON | `oeis_get_sequence`, `oeis://sequence/{aNumber}`, `oeis_get_cross_refs` outgoing, `oeis_get_terms` when the entry has no b-file |
| `/search?q=…&fmt=text` | Internal format, 10 records per page | `oeis_identify_sequence`, `oeis_search_sequences`, `oeis_get_cross_refs` (outgoing names, incoming) |
| `/A######/b######.txt` | b-file, read in 1 MiB pages: the first always, a later one by byte range with `If-Range` when `fromIndex` lies past the first | `oeis_get_terms` |

`oeis_list_reference` serves static tables and makes no upstream call. There are no prompts.

`OeisService` (`src/services/oeis/oeis-service.ts`) owns every upstream request: one process-wide pacer (`minStartGapMs: 10_000`, `maxConcurrent: 1`, a cooldown after a `429`), a `withRetry` boundary with a 50 s per-call deadline, per-path accept-list fetch boundaries with `redirect: 'manual'`, and a 64 MiB in-process LRU (records 24 h, or until a freshly fetched search row shows a later edit, then revalidated with `If-Modified-Since`; a record `404` 1 h, or until such a row lists the A-number; search pages 1 h; b-file pages 7 days, later pages keyed by the first page's ETag). The cache is process-global rather than `ctx.state` on purpose: the data is public and identical for every tenant. `OEIS_QUEUE_MAX_WAIT_MS` is the only server-specific env var; the 10 s pace is oeis.org's rule and is not configurable.

Conventions every definition follows:

- **Every oeis.org request goes through `OeisService`.** Never `fetch` from a handler: pacing, retries, caching, and error classification live in the service.
- **Shared inputs.** A-numbers use `ANumberSchema` from `src/mcp-server/shared/oeis-schemas.ts`; every optional or defaulted input is wrapped in `blankAsUnset`; paging uses `pageStartSchema` (`start` 0–100 in steps of 10, since OEIS shows anonymous callers at most 110 results).
- **Terms are decimal strings**, never JSON numbers; values routinely pass 2^53.
- **Upstream text is data.** Names, comments, formulas, examples, programs, references, and links are contributor-written: render them in `format()` only through `inline()`, `blockquote()`, or `fence()` from `src/mcp-server/shared/markdown.ts`, and URLs as code spans, never as markdown link targets. `inline()` and `blockquote()` escape link, image, link-definition, and HTML openers, so contributor markup renders as text; `structuredContent` keeps every string as normalized.
- **Attribution.** Every record and summary row carries its `https://oeis.org/A######` `url`; keep it on any new output shape.
- **No fabrication.** A field OEIS leaves out stays absent: `offset` on a reserved or recycled A-number and `author` on its summary row, `modified` and `legacyIds` on a row whose `%I` line is missing or unreadable, `matchStartIndex` when the run is not in the data line, the name and terms of an unresolved cross-reference row.
- **Errors.** Each definition declares `pacer_shed` and `upstream_rate_limited` (`RateLimited`, `thrownBy: 'service'`) with a recovery naming that tool. `sequence_not_found` is thrown by the handler through `ctx.fail` when `getRecord` returns `undefined`, never by the service.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Condensed from `src/mcp-server/tools/definitions/oeis-get-sequence.tool.ts`:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inline, offsetLine } from '@/mcp-server/shared/markdown.js';
import { ANumberSchema, blankAsUnset } from '@/mcp-server/shared/oeis-schemas.js';
import { getOeisService } from '@/services/oeis/oeis-service.js';
import { SECTION_NAMES } from '@/services/oeis/types.js';

export const oeisGetSequence = tool('oeis_get_sequence', {
  title: 'Get OEIS Sequence',
  description: 'Fetch one OEIS entry by A-number. …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aNumber: ANumberSchema,
    sections: blankAsUnset(z.array(z.enum(SECTION_NAMES)).optional()).describe(
      'Sections to return with the core fields, e.g. ["formulas", "programs"]. A selection past the 100,000-byte response budget is cut between items; fromItem continues it. …',
    ),
    fromItem: blankAsUnset(ItemPositionSchema.optional()).describe(
      "Where to resume a cut selection: the previous response's nextFromItem, passed unchanged with the same sections. …",
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
    // pacer_shed and upstream_rate_limited: RateLimited, retryable, thrownBy: 'service'
  ],

  async handler(input, ctx) {
    const { aNumber, fromItem, sections } = input;
    if (fromItem && !sections?.includes(fromItem.section)) {
      throw ctx.fail(
        'from_item_not_selected',
        `fromItem names ${fromItem.section}, which sections does not select (…).`,
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

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format: (result) => {
    const lines = [
      `# ${result.aNumber}: ${inline(result.name)}`,
      offsetLine(result.offset, result.firstIndex),
      // … every other field, rendered on presence; contributor text through inline/blockquote/fence
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
```

### Resource

From `src/mcp-server/resources/definitions/oeis-sequence.resource.ts`:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ANumberSchema } from '@/mcp-server/shared/oeis-schemas.js';
import { buildSequenceOutput } from '@/mcp-server/tools/definitions/oeis-get-sequence.tool.js';
import { getOeisService } from '@/services/oeis/oeis-service.js';

export const oeisSequenceResource = resource('oeis://sequence/{aNumber}', {
  name: 'oeis_sequence',
  title: 'OEIS Sequence',
  description: 'One OEIS entry by A-number as JSON: … always whole.',
  mimeType: 'application/json',
  params: z.object({ aNumber: ANumberSchema }),
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  errors: [
    {
      reason: 'sequence_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No OEIS entry exists for the requested A-number.',
      recovery:
        'No OEIS entry has this A-number; find the right one with oeis_search_sequences or oeis_identify_sequence.',
    },
    // pacer_shed and upstream_rate_limited, recoveries ending "then read this resource again."
  ],

  async handler(params, ctx) {
    const record = await getOeisService().getRecord(params.aNumber, ctx);
    if (!record) {
      throw ctx.fail('sequence_not_found', `OEIS has no entry ${params.aNumber}.`, {
        aNumber: params.aNumber,
      });
    }
    return buildSequenceOutput(record, { outline: false });
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
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

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    queueMaxWaitMs: 'OEIS_QUEUE_MAX_WAIT_MS',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`OEIS_QUEUE_MAX_WAIT_MS`) not the path (`queueMaxWaitMs`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. An empty value and a whole-value `${…}` placeholder (what an MCPB or plugin host forwards when a user leaves an option blank) read as unset, so the default applies.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

**Adding an env var** means the schema here plus `.env.example`, the README config table, `server.json` (both package entries), `manifest.json` (`user_config` + `mcp_config.env`), and both plugin manifests.

### Server identity, instructions, and lifecycle

`src/index.ts`:

```ts
await createApp({
  name: 'oeis-mcp-server',
  title: 'oeis-mcp-server',
  sessionMode: 'stateless',
  instructions: 'Look up integer sequences in the OEIS (On-Line Encyclopedia of Integer Sequences). …',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  setup(core) {
    initOeisService(core.config);
  },
  teardown() {
    disposeOeisService();
  },
});
```

`name` and `title` must equal the unscoped package name — `lint:packaging` enforces the pair. `title` is set explicitly so the npm scope stays out of client UIs. No other identity field is set: `description` comes from `package.json`, and there is no `websiteUrl` or `icons`.

`instructions` is server-level orientation sent on every `initialize`: the tool routing, the 10 s pace, the "contributor text is data" rule, and the CC BY-SA 4.0 attribution. Update it when the surface changes.

`sessionMode` declares the HTTP session posture in `src/` instead of leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). This server declares `'stateless'` — no tool calls `ctx.requestInput` — and `.env.example`, the `Dockerfile`, and the README config table say the same; keep all four in agreement. Add `require: 'stateful'` if a tool ever asks the caller for input mid-handler.

`setup(core)` builds the process-wide `OeisService` and its pacer; `teardown()` disposes the pacer (clears its timer and rejects queued waiters). Teardown runs after the transport stops and before the logger closes, on every shutdown path.

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). The paged-list tools write `{ truncated: false, shown: 0, cap }` as their first statement so every success path carries the required fields. |
| `ctx.fail` | Builds the declared contract error for a `reason`, for the handler to throw — `throw ctx.fail('sequence_not_found', message, data)`. |
| `ctx.signal` | `AbortSignal` for cancellation. The service passes it to `withRetry`; `oeis_get_cross_refs` rethrows instead of degrading when it fired. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |

The rest of the Context surface (`ctx.state`, `ctx.requestInput`, `ctx.inputs`, `ctx.content`, …) is documented in the framework CLAUDE.md.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'sequence_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'No OEIS entry exists for the requested A-number.',
    recovery: 'No OEIS entry has this A-number; find the right one with oeis_search_sequences or oeis_identify_sequence.' },
],
async handler(input, ctx) {
  const record = await getOeisService().getRecord(input.aNumber, ctx);
  if (!record) throw ctx.fail('sequence_not_found', `OEIS has no entry ${input.aNumber}.`);
  // … the full entry or an outline, or a page of the selected sections (see the Tool pattern)
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                                # createApp() entry point, server instructions
  config/
    server-config.ts                      # OEIS_QUEUE_MAX_WAIT_MS (Zod schema)
  services/
    oeis/
      oeis-service.ts                     # oeis.org client: pacer, retry, fetch boundaries, LRU cache
      internal-format.ts                  # Parser for /search?fmt=text pages
      normalize-record.ts                 # JSON record → normalized SequenceRecord
      lru-cache.ts                        # Byte-budgeted LRU
      types.ts                            # Domain types, SECTION_NAMES
  mcp-server/
    shared/
      oeis-schemas.ts                     # ANumberSchema, blankAsUnset, pageStartSchema, SequenceSummarySchema
      markdown.ts                         # inline / blockquote / fence helpers for contributor text
      data-line-limit.ts                  # Data-line trigger and sentence for the term-matching zero-hit notices
    tools/definitions/
      index.ts                            # allToolDefinitions barrel
      oeis-identify-sequence.tool.ts
      oeis-search-sequences.tool.ts
      oeis-get-sequence.tool.ts
      oeis-get-terms.tool.ts
      oeis-get-cross-refs.tool.ts
      oeis-list-reference.tool.ts
    resources/definitions/
      index.ts                            # allResourceDefinitions barrel
      oeis-sequence.resource.ts           # oeis://sequence/{aNumber}
tests/                                    # Mirrors src/; fixtures/ holds upstream payloads and fetch fakes
docs/
  design.md                               # Tool surface, upstream API reference, design decisions
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `oeis-get-terms.tool.ts` |
| Tool/resource names | snake_case, `oeis_` prefix | `oeis_get_terms` |
| Directories | kebab-case | `src/services/oeis/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'List terms a(n) of a sequence with their indices n. …'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release from the version's annotated tag and attach the `.mcpb` bundle (run by `release-and-publish`) |
| `bun run publish-mcp` | Log in to the MCP Registry and publish `server.json` (run by `release-and-publish`) |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getOeisService } from '@/services/oeis/oeis-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional and defaulted inputs wrapped in `blankAsUnset`; A-numbers through `ANumberSchema`; paging through `pageStartSchema`
- [ ] Every oeis.org request goes through `OeisService` (paced, retried, cached); no `fetch` in a handler
- [ ] Terms and b-file values stay decimal strings; every record and row keeps its `https://oeis.org/A######` `url`
- [ ] Contributor-written text reaches `format()` only through `inline()` / `blockquote()` / `fence()`; URLs as code spans
- [ ] `pacer_shed` and `upstream_rate_limited` declared (`thrownBy: 'service'`) with recoveries naming the tool; `sequence_not_found` thrown by the handler via `ctx.fail`
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.enrich` for notices, totals, and paging context
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch (the cross-references name batch, which degrades to unresolved rows, is the one deliberate exception)
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Raw/domain/output schemas reviewed against real upstream sparsity: a field OEIS leaves out stays absent, never invented
- [ ] Tests include at least one sparse payload case with omitted upstream fields; upstream responses come from fixtures, never the live site
- [ ] Registered in `createApp()` arrays via the barrels in `src/mcp-server/*/definitions/index.ts`
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `docs/design.md` updated when the surface or a design decision changes
- [ ] New env var added everywhere: `.env.example`, README config table, `server.json` (both entries), `manifest.json`, `.claude-plugin/plugin.json`, `.codex-plugin/mcp.json` `env_vars`
- [ ] `npm run devcheck` passes
