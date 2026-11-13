# Stage 0: integration proof

Exit (PLAN.md §11): lost responses and restarts do not duplicate work; ambiguous execution is
visible; remote preparation and Kit behavior are verified. Document any required seam before expanding.

## Done (in-process, against a fake worker)

- [x] Dispatch intent persisted before launch; a lost launch response is resolved by marker lookup,
      never by relaunching (`apps/hub/test/dispatch.test.ts`).
- [x] Relaunch only after the launch is confirmed absent *and* a grace period passed; bounded retries.
- [x] Hub restart mid-launch recovers from SQLite via `reconcileAll()`.
- [x] Worker disconnect → `status_unknown`, same thread kept; no replacement Attempt.
- [x] Duplicate / out-of-order observations ignored; cancel stays pending until confirmed.
- [x] Kit compiler for Claude and Codex with a capability report; unsupported permission
      enforcement blocks launch (e.g. engineer's `deny` rule on Codex).
- [x] Reversible overlay: Kit files excluded from git, untracked originals restored, force-added
      Kit files detected before handoff.

## Verified on real T3 0.1.3 (this machine, 2026-10-27)

- [x] Headless pairing: one pairing code → RPC bearer session (`/oauth/token` exchange) → hub mints a
      second code → MCP OAuth approved via `/oauth/mcp/decision`. No browser, T3 UI never opened.
- [x] Remote preparation shape: `t3_thread_launch` without `message` creates an idle thread whose
      `worktreePath` appears shortly after; Kit applied there; `t3_thread_send` (with
      `clientRequestId`) delivers the first message. (Kit files written directly: hub = worker.)
- [x] Claude loads `.claude/rules/studio-kit.md` and discovers `.claude/skills/handoff-report`
      (observed: the handoff matched the skill's exact format; the role came from the rules file).
- [x] Kit files stay out of `git status`; overlay removal leaves a clean worktree.
- [x] Approvals: MCP cannot list or answer permission requests (by design). The hub reads
      `projection.runtimeRequests` over HTTP and answers with RPC `runtime-request.respond`.
- [x] T3 reports thread status `running` while an approval is pending; `pendingRequestCount` is the
      signal. The hub maps it to `awaiting_input` ("needs you").
- [x] Full loop through the hub API: job → Kit → agent → approval from Studio → commit → result.
- [x] Second worker (a Windows PC) (Windows 11, T3 0.1.3) paired over LAN with one code; tool surface
      identical to local. A T3 restart no longer leaves the hub with a dead session.
- [x] Remote Kit delivery over RPC (`projects.readFile/writeFile/listEntries`): T3 refuses writes in
      `.git`, so each new top-level Kit folder gets a `.gitignore` of `*`; T3 reports the files as
      ignored. No remote delete: files stay in the per-Attempt worktree. Root-level files (Codex
      `AGENTS.override.md`) cannot be hidden this way and are refused on remote workers.
- [x] Full loop on the Windows worker: remote Kit → Claude → approval answered from Studio → commit.
      Checked over RPC `vcs.refreshStatus`: clean tree, branch +1 commit / +1 line vs master, so
      no Kit files committed. (`vcs.refreshStatus` could become the hub's remote leak check.)
- [x] Codex (local, T3 0.1.3, `auto-accept-edits` → workspace-write sandbox): writing outside the job
      folder fails ("Read-only file system"), network is off (DNS fails), and `git commit` is blocked
      because a worktree's git data lives outside the folder. Codex then asks to commit; approved from
      Studio, it commits. Codex used `.agents/skills/` and followed `AGENTS.override.md`.
      Guardrails on Codex are therefore accepted as degraded in sandboxed modes, refused in full access.
- [x] Codex as read-only reviewer (Code Critic, `approval-required` → read-only sandbox with
      `untrusted` approvals) works, but asked ~18 approvals for one review, several identical
      repeats. Open: whether "approve for session" curbs this, or read-only Codex roles need a
      different mode.
- [x] A launch that failed during preparation was found by marker (no duplicate) and shown as
      unknown; cancelling it resolves to stopped once T3 reports nothing running.

## To do on real machines

1. Codex Kits on remote workers need a way to deliver root-level instructions (session injection
   seam, or T3 terminal RPC to write `.git/info/exclude`).
3. Kit behavior, per provider, in a throwaway worktree (`kit:compile --apply`):
   - [ ] Claude loads the project's `CLAUDE.md` alongside the Kit (sandbox had none).
   - [ ] Claude sees Kit MCP servers from `.mcp.json` without an approval prompt.
   - [ ] Claude enforces `permissions.deny` from `.claude/settings.local.json` (try `git push`).
   - [ ] Codex still follows a project's own AGENTS.md content when composed into the override.
   - [ ] Codex reads `.codex/config.toml` MCP servers in a T3 session (project trust).
   Verify by observing tools/behavior, not by asking the agent what it loaded.
4. Remote preparation (Open Question 1):
5. Recovery against real T3:
   - [ ] Kill the hub between launch and response; `reconcileAll()` finds the thread by marker.
   - [ ] Title marker survives (no automatic title regeneration for MCP launches with a title).
   - [ ] Stop the worker's T3 mid-run; Attempt goes `status_unknown`, then recovers on restart.
   - [ ] `t3_thread_interrupt` → Attempt reaches `stopped` only once T3 reports it.
6. Record findings here and in `UPSTREAM.md`; write any needed seam up as an upstream PR draft.
