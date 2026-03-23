# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCode Dynamic Context Pruning (DCP) — an OpenCode plugin that reduces token usage by managing conversation context. It intercepts messages before they reach the LLM, pruning obsolete tool outputs and compressing completed task history into summaries. Published as `@tarquinen/opencode-dcp` on npm.

## Commands

```bash
npm run build          # Clean + compile TypeScript
npm run typecheck      # Type check without emitting
npm run test           # Run all tests (node --import tsx --test)
npm run format         # Format with Prettier
npm run format:check   # Check formatting (CI uses this)
npm run dev            # OpenCode plugin dev mode
```

Run a single test file:
```bash
node --import tsx --test tests/compress.test.ts
```

CI runs: format:check → typecheck → build → npm audit (on PRs to master/dev).

## Architecture

### Plugin Entry Point (`index.ts`)

Exports a `Plugin` function that receives an OpenCode context and returns hook handlers. Initializes config, logger, session state, and prompt store, then wires up hooks.

### Hook System (`lib/hooks.ts`)

The core processing pipeline. DCP hooks into OpenCode's lifecycle:
- **`experimental.chat.system.transform`** — injects DCP instructions into the system prompt
- **`experimental.chat.messages.transform`** — the main pipeline: assigns message IDs, syncs tool cache, syncs compression blocks, runs pruning strategies, injects nudges
- **`command.execute.before`** — handles `/dcp` slash commands (stats, context, sweep, manual, decompress, recompress)

### Message Processing Pipeline (`lib/messages/`)

Messages flow through transforms before reaching the LLM:
1. **Sync** (`sync.ts`) — reconciles compression block state with actual messages
2. **Prune** (`prune.ts`) — applies strategies and replaces pruned content with placeholders
3. **Inject** (`inject/`) — adds compression nudges, message IDs, and subagent result summaries

### Pruning Strategies (`lib/strategies/`)

Three independent strategies, each can be enabled/disabled:
- **Deduplication** — removes duplicate tool calls (same tool + args), keeps most recent
- **Supersede Writes** — when a file is written/edited multiple times, prunes older reads
- **Purge Errors** — removes input content from errored tool calls after N turns

### Compress Tool (`lib/tools/`)

A tool exposed to the LLM that selects a message range and replaces it with an AI-generated summary. Supports:
- Nested compression (new compressions can overlap earlier ones)
- Protected tool outputs and file patterns preserved through compression
- Auto-loop mode for multiple compression passes (`lib/tools/compress-loop.ts`)

### State Management (`lib/state/`)

Per-session state tracking compression blocks, tool caches, prune maps, and turn counts. State persists across messages within a session via `persistence.ts`.

### Prompts (`lib/prompts/`)

System prompt generation and nudge templates. The `PromptStore` supports user-customizable prompt overrides (experimental). Key prompts: compress instructions, context-limit nudges, iteration nudges, turn-based nudges.

### Config (`lib/config.ts`)

Loads JSONC config from `~/.config/opencode/dcp.jsonc` → `$OPENCODE_CONFIG_DIR/dcp.jsonc` → `.opencode/dcp.jsonc` (project override). Schema at `dcp.schema.json`.

## Code Style

- Prettier: 4-space indent, no semicolons, double quotes, trailing commas, 100 char width
- TypeScript strict mode, ESM (`"type": "module"`)
- Tests use Node's built-in test runner (`node:test`), run via tsx
