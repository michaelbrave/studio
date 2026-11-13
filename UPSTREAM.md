# Upstream log (T3 Code)

Pinned worker version: **t3 0.1.3** (reference source: T3 Code @ `339179f`, 0.0.45; re-read
the docs at 0.1.3 before relying on details below).

## Found

- **`t3_thread_launch` (MCP) has no retry key.** The internal launch command accepts a client
  `commandId`/`threadId`, but the MCP handler always generates them
  (`apps/server/src/mcp/toolkits/project/handlers.ts`). Studio works around it with a title marker +
  `t3_thread_list titleContains`. Candidate small PR: optional `clientRequestId` on
  `t3_thread_launch`, mirroring `create_threads` / `t3_thread_send`.
- **Claude sessions do not set `settingSources`** (`orchestration-v2/Adapters/ClaudeAdapterV2.ts`),
  so whether project `CLAUDE.md`, `.claude/rules/`, `.claude/settings*.json`, and `.mcp.json` load
  depends on the Agent SDK default. To verify in Stage 0.
- **No file-write over MCP.** Remote Kit delivery candidate: RPC `projects.writeFile` (paired
  client, not an MCP client; MCP sessions are refused on RPC paths).

- **MCP cannot answer permission requests** (`t3_pending_request` says so). Studio uses the typed
  RPC for approvals. Possibly intentional (MCP clients act under a runtime-mode ceiling); worth an
  Ideas discussion before a PR.
- **Thread status stays `running` while an approval is pending** (`t3_thread_read`); only
  `pendingRequestCount` reveals it. A `waiting` status there would match the run status vocabulary.
- **0.1.3 differs from the 0.0.45 source** read during planning: `t3_pending_request_{list,read,respond}`
  became one `t3_pending_request` tool with an `action`. Always check `docs/stage0/*-surface.json`.
- WebSocket RPC requires `?orchestrationProtocol=2` on `/ws` (426 otherwise); HTTP snapshot routes
  require header `x-t3-orchestration-protocol: 2`.

- **No delete over RPC, and `projects.writeFile` refuses `.git/`** (`resolved_path_outside_root`).
  Remote tooling cannot remove files it wrote or set per-repo excludes. A small seam idea: per-thread
  extra instructions/MCP at launch would make worktree file delivery unnecessary.

- **No local merge in 0.1.3.** `t3_thread_merge_back` (0.0.45 source) is gone; integration is push +
  PR (`git.runStackedAction`). Studio integrates locally through an agent job in the project root.

## Filed

(none yet)

## Merged

(none yet)
