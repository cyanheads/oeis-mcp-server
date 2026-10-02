<div align="center">
  <h1>@cyanheads/oeis-mcp-server</h1>
  <p><b>Identify integer sequences by terms, search the OEIS, read formulas, programs, b-files, cross-refs via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/oeis-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/oeis-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/oeis-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/oeis-mcp-server/releases/latest/download/oeis-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=oeis-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb2Vpcy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22oeis-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Foeis-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://oeis.caseyjhand.com/mcp](https://oeis.caseyjhand.com/mcp)

</div>

---

## Overview

Integer sequences from the [On-Line Encyclopedia of Integer Sequences](https://oeis.org/) (OEIS). Identify a sequence from a few observed terms, search with OEIS's own query syntax, read an entry's formulas and programs, page through extended terms from its b-file, and walk its cross-references. Every result links to its oeis.org page. Runs without an API key, as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `oeis_identify_sequence` | Identify sequences that contain a run of consecutive terms, in OEIS relevance order, with the index where the run begins |
| `oeis_search_sequences` | Search with OEIS query syntax: words, quoted phrases, term lists, and prefixes such as `keyword:` and `author:` |
| `oeis_get_sequence` | Fetch one entry by A-number: terms, offset, keywords, formulas, programs, comments, references, links, and cross-references |
| `oeis_get_terms` | List terms a(n) with their indices from the entry's b-file, or from its data line when it has none |
| `oeis_get_cross_refs` | List the sequences an entry cross-references, or the entries that mention it |
| `oeis_list_reference` | Decode keyword flags, search syntax, and identifier and offset conventions, with no upstream call |

### Resources

| Resource | Description |
|:---|:---|
| `oeis://sequence/{aNumber}` | One entry by A-number as JSON, always whole |

The same record is available through `oeis_get_sequence` for clients that only call tools.

## Capability reference

### `oeis_identify_sequence` <sub>tool</sub>

- `terms`: up to 60 consecutive terms separated by commas or spaces (a bracketed list or a trailing `...` is accepted), each an integer of at most 200 digits or `_` for one unknown term; `matchSigns` (default `false`) ignores signs unless set
- Up to 10 candidates per page, `start` 0–100 in steps of 10; each row carries the `oeis_search_sequences` row fields plus `matchStartIndex`, the n where the run begins in that entry's data line (absent when the run isn't there)
- No match and "too many results" both return an empty page; the `notice` says which and how to retry (drop leading terms, divide out a common factor, or add terms). OEIS matches a run only within each entry's data line (at most about 270 characters), never its b-file, and a zero-hit notice says so when every nonzero term has 10 or more digits, five or more terms of 4 or more digits lie within 10% of each other, or the run passes 270 characters

---

### `oeis_search_sequences` <sub>tool</sub>

- `query` (1–1,000 characters) is sent as written: words, `"quoted phrases"`, term lists, prefixes such as `keyword:`, `author:`, `name:`, `formula:`, `xref:`, and `id:`, `|` for OR, and a leading `-` to exclude
- `sort`: `relevance` (default), `number`, `created`, or `modified`; 10 per page, `start` 0–100 in steps of 10
- Rows carry `name`, `terms`, `offset` / `firstIndex`, `keywords`, `author`, `legacyIds`, `modified` (the last edit, ISO 8601 with offset), and `url`, in `oeis_get_sequence`'s formats; `author` and `legacyIds` are absent where OEIS has none
- Reports `totalCount` and `effectiveQuery`, the query as OEIS parsed it. A query OEIS parses as one run of terms (`effectiveQuery` reads `seq:` or `signed:` and the terms, as for bare numbers) is matched within each entry's data line, as in `oeis_identify_sequence`, and its zero-hit notice names that limit under the same conditions

---

### `oeis_get_sequence` <sub>tool</sub>

- Returns `name`, `terms`, `offset` / `firstIndex`, `keywords`, `author`, `legacyIds`, `referenceCount`, `revision`, `created` / `modified`, `url`, and `bFileUrl`, plus eight sections: `comments`, `formulas`, `examples`, `programs`, `references`, `links`, `crossReferences`, `extensions`
- When the sections exceed 24,000 characters of serialized JSON, `kind: "outline"` returns the core fields and a sized `sections` list; pass `sections` (e.g. `["formulas", "programs"]`) to get the chosen ones
- A selection past 100,000 bytes comes back in parts cut between whole items; pass each part's `nextFromItem` as `fromItem`, with the same `sections`, for the next. A `fromItem` naming a section not in `sections` fails as `from_item_not_selected`
- An unknown A-number fails as `sequence_not_found`; withdrawn (`dead`), reserved, and recycled entries come back with a `notice`

---

### `oeis_get_terms` <sub>tool</sub>

- `fromIndex` (default: the first available index) and `limit` 1–1,000 (default 100); a slice also stops at about 100,000 bytes or at the end of a 1 MiB part of the b-file, and `nextFromIndex` continues it
- `source: "bfile"` reads the entry's b-file in 1 MiB parts, so a `fromIndex` past the first 1 MiB costs one or two more paced requests; `bFileCut: true` means the file goes on past `lastAvailableIndex`. `source: "data"` means the entry has no b-file and the terms are its data line
- Terms come back as `{ n, value }`, `value` an exact decimal string; an unknown A-number fails as `sequence_not_found`

---

### `oeis_get_cross_refs` <sub>tool</sub>

- `direction: "outgoing"` (default) lists the A-numbers named in the entry's cross-reference lines, with the `note` written beside each and the `lines` verbatim; `"incoming"` lists the entries that mention the A-number
- 10 rows per page, `start` 0–100 in steps of 10; every row carries `url`, and resolved rows add the name, terms, offset, keywords, author, legacy IDs, and last edit (`modified`)
- If the name lookup for an outgoing page is rate-limited, unavailable, or times out, rows come back `resolved: false` with a retry notice instead of failing; `sequence_not_found` applies to `outgoing` only

---

### `oeis_list_reference` <sub>tool</sub>

- `topic`: `keywords` (flags such as `nonn`, `core`, `tabl`, `cons`), `search_syntax` (prefixes, operators, wildcards, sort orders, paging), or `identifiers` (A-numbers, legacy M/N numbers, offsets, b-files)
- Returns `entries` (`name`, `description`) and `notes` from static tables

---

### `oeis://sequence/{aNumber}` <sub>resource</sub>

- The full entry as `application/json`: the record `oeis_get_sequence` returns with `kind: "full"`, never outlined
- `aNumber` takes the same forms as the tools (`oeis://sequence/A108` reads A000108); an unknown A-number fails as `sequence_not_found`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OEIS-specific:

- One paced, cached oeis.org client (see [Pacing and caching](#pacing-and-caching)); searches tell "no results" apart from "too many results" and report the match total
- Forgiving A-numbers: `A000045`, `a000045`, `A45`, `45`, and an oeis.org sequence URL all resolve in every tool; a legacy M/N book number is pointed to `oeis_search_sequences`
- Exact terms: every term and b-file value is a decimal string, so values past 2^53 keep every digit
- Pasted term runs are normalized: brackets, a trailing `...`, the Unicode minus sign, and mixed comma and space separators

Agent-friendly output:

- Paging context on every page (`truncated`, `shown`, `cap`, plus `totalCount` and `effectiveQuery` where OEIS reports them) and a `notice` that says how to narrow or continue
- Typed failures with recovery hints: `sequence_not_found`, `from_item_not_selected`, `pacer_shed`, and `upstream_rate_limited`, the rate-limit errors carrying `retryAfter` when one is known
- Discriminated outputs (`kind`, `source`, per-row `resolved`), so callers branch on data, not string parsing
- Every record and row carries its `https://oeis.org/A######` URL; contributor-written text renders as blockquotes and code fences, and only `http` and `https` link URLs are kept

## Pacing and caching

oeis.org asks automated clients to wait 10 seconds between requests. The server sends one upstream request at a time and starts each at least 10 seconds after the last, across every tool. Results are cached in memory, so a repeated lookup returns at once and costs oeis.org nothing: records for 24 hours, or until a search result shows a later edit (then revalidated with a conditional request), search pages for 1 hour, and b-file parts for 7 days.

A call with nothing cached waits its turn in the queue. When the wait would pass `OEIS_QUEUE_MAX_WAIT_MS` (default 30,000 ms), the call fails with `pacer_shed` and a `retryAfter` instead of hanging. If oeis.org answers 429, the server holds every queued call back before trying again, and reports `upstream_rate_limited` once its retries are spent. The pace is per server process.

## Known limitations

- Anonymous paging is capped upstream at 110 results per query (`start` ≤ 100); A000045's 6,161 incoming references, for example, are reachable only through their first 110.
- A query OEIS judges too broad returns no rows ("Too many results"), which is common for a single word (`prime`) or a two-term run. The server reports it but cannot page it.
- OEIS searches an unknown prefix as plain words instead of rejecting it; the zero-hit notice names it.
- Term matching (`oeis_identify_sequence`, and an `oeis_search_sequences` query of bare numbers or `seq:` / `signed:` terms) searches each entry's data line only, not b-files, and data lines are short: at most 269 characters, signs included, across 105 measured (2026-10-01). A run that starts beyond the data line, or one longer than about 270 characters, is not found.
- `oeis_get_terms` reads at most two 1 MiB parts of a b-file past the first per call; an index deeper in comes back with a notice to call again, which continues from the parts already cached. A b-file served without byte ranges or a strong `ETag` is read only to its first 1 MiB.
- `oeis_get_cross_refs` outgoing shares the `start` ≤ 100 bound, so an entry naming more than 110 distinct A-numbers lists only the first 110; `lines` still names them all.

## Data and licensing

OEIS content is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) under the [OEIS End-User License Agreement](https://oeis.org/LICENSE). When you reuse it, credit "The On-Line Encyclopedia of Integer Sequences" with a link to [https://oeis.org/](https://oeis.org/) or to the sequence page; every record the server returns carries its `https://oeis.org/A######` URL for that purpose. ShareAlike applies: adaptations of OEIS content must be shared under the same license.

This server is an independent project and is not affiliated with or endorsed by the OEIS Foundation.

## Getting started

### Public Hosted Instance

A public instance is available at `https://oeis.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "oeis-mcp-server": {
      "type": "streamable-http",
      "url": "https://oeis.caseyjhand.com/mcp"
    }
  }
}
```

Every caller of the hosted instance shares one oeis.org pace of one request every 10 seconds; cached lookups return at once. For sustained use, run your own instance.

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "oeis-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/oeis-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "oeis-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/oeis-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "oeis-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/oeis-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: the server reads public oeis.org data.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/oeis-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd oeis-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optional: adjust OEIS_QUEUE_MAX_WAIT_MS, the transport, or the log level
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `OEIS_QUEUE_MAX_WAIT_MS` | Longest a call waits in the oeis.org request queue before failing with `pacer_shed` and a `retryAfter`, in ms. Each call's 50 s deadline also has to cover the request itself, so waits stop at about 35,000 ms whatever the setting. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for every server setting and the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and resource, sets the server instructions, and starts the OEIS service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six tools. |
| `src/mcp-server/resources` | Resource definitions. The `oeis://sequence/{aNumber}` resource. |
| `src/mcp-server/shared` | Schemas shared across definitions (A-number input, paging, summary rows), Markdown helpers for contributor-written text, and the data-line-limit test and sentence the term-matching zero-hit notices share. |
| `src/services/oeis` | oeis.org client: pacer, retries, fetch boundaries, LRU cache, record normalization, and the internal-format parser. |
| `tests/` | Unit tests mirroring the `src/` structure; upstream responses come from fixtures, never the live site. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging and `ctx.enrich` for notices, totals, and paging context
- Register new tools and resources in the barrels at `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
