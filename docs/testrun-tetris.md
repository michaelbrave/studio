# Test run 1: a browser Tetris clone, built through Studio

2026-10-29. Goal handed to the Producer: a plain HTML/CSS/JS falling-block game, open `index.html`
to play. Project: a new `games/tetris` folder on the local worker; the Windows worker
was offline. Studio was driven through the hub API the web UI uses, with scripts that chained
the steps and approved an allowlist of commands; the last card was finished by hand from the UI.

**Outcome:** the game plays well (checked by the user). Four of six cards merged into `main`, 88
tests pass. The QA and Creative Director cards were not run; the user playtested instead.

## Where it got to

| Card | Role | Rounds | Result |
| --- | --- | --- | --- |
| Rules spec (`docs/design.md`) | Game Designer (Claude) | 3 work, 3 Codex reviews | merged `fe3b8b2` |
| Core board and piece logic | Gameplay Programmer | 1 | merged `7e0c0a4`, 51 tests |
| Scoring, levels, gravity, Next queue | Gameplay Programmer | 2 | merged `1e53767`, 76 tests |
| Browser page, rendering, keys | Software Engineer | 1 | merged `42c6f95`, 88 tests (finished from the UI) |
| Test plan and playtest | QA Lead | not run | the user played it |
| Ship review | Creative Director | not run | |

Card cost after the first one: about 2–7 minutes each. Approvals before the fixes below: 36 in the
first three and a half cards (27 auto-approved by the run's allowlist script, 9 by hand), plus the
ones the user answered from the UI.

What worked: the Producer's plan (6 cards, checkable criteria, about 1 minute); Codex cross-checks
found real bugs in Claude's work (an endless lock-delay stall in the spec, a soft-drop timing bug);
the Integrator ran the tests on every merge; the board moved cards on its own.

## Findings, by impact

**Blockers**
1. A new project is not a git repository, so T3 cannot make a worktree. The attempt sits in
   ❓ forever; the cause ("Failed to resolve the VCS driver") is only in T3's server log.
   *Open.* Decision: make `git init` a step-0 rule for new projects, and surface launch failures.
2. Integrating a revision failed: the Integrator merges into the branch the job started from, which
   for a revision is the previous attempt's branch. *Patched:* `integrate` takes `base`
   (`POST /api/jobs/:id/integrate {"base":"main"}`). Decision: move to pull-request-style merges.

**Bottlenecks**
3. Approvals. Every job stopped for its own `git commit` (which the Handoff Kit requires), for
   `sed -i`, Python heredoc edits, read-only checks, and Codex sandbox escalations; nothing
   notifies you. *Partly fixed:* the Guardrails Kit now allows routine commits, tests and reads,
   and its rules steer agents to their edit tools. Shell edits and anything outside the worktree
   still ask. Fallback if that is not enough: full access scoped to the project folder.
4. No autopilot. Studio has every step (work → cross-check → revise → accept → integrate → next
   card) but nothing chains them; the run needed a ~70-line script to do it. *Open.*
5. No "send back with notes". After CHANGES REQUESTED the only options are accept or reject; a
   restarted card starts from `main` without the work or the review. The run created revision jobs
   by hand, branched from the previous attempt's branch, with the review in the brief. *Open.*
6. No stopping rule for reviews. Each round finds something smaller; nothing says when P2-only
   findings are good enough. *Open.*
7. Dependencies are text only ("Depends on: …"). Cards run strictly one after another. *Open.*

**Missing capabilities**
8. Agents have no browser. Cards ask for checks in Chrome and Firefox; the engineer spent about
   10 minutes and 12+ approvals writing its own WebDriver BiDi harness for headless Firefox in
   /tmp. Decision: agents must not build browsers; the game is viewed on localhost. Plans should
   not ask agents for browser checks until a real browser tool exists (e.g. Playwright MCP in the
   Playtesting Kit).
9. Approval requests were hard to judge: file-change requests showed only the path, file-read
   requests nothing. *Fixed:* the hub finds the tool call each request gates (same native id in
   T3's turn items) and shows the command, the file read, or the file written. T3 does not record
   a write's content before approval, so writes show the path and the agent's reason.

**Smaller**
10. `worktree_path` is empty after an attempt finishes; tooling has to find the branch by commit.
11. Revisions appear as separate "Revise: …" jobs; nothing groups the rounds of one card.
12. A safe auto-approve rule must check every command in a `&&` chain. Claude Code's own
    permission rules do this, which is why the allowlist lives in the Kit rather than in a script.

## Changed in Studio after the run

- `apps/hub/src/hub.ts`: approvals describe the tool call they gate (`describeToolCall`, tested in
  `apps/hub/test/approvals.test.ts`).
- `apps/hub/src/workflow.ts`: `integrate` accepts `base`, the branch to merge into.
- `kits/guardrails/`: allow rules for routine git, test and read commands; rules text updated.

## Next session

The user's direction (also in PLAN.md §11):

1. **Project Manager with a heartbeat.** A role on a timer, like OpenClaw and Hermes agents, that
   keeps cards moving through the loop in finding 4 and shows how tasks depend on each other
   (findings 6 and 7). The idea is incomplete; design it with the user first.
2. **Review notes.** A place to send a review back to the agent with its notes, continuing the
   same work (findings 5 and 11).
3. **Step 0 for new projects.** A rule that sets up git before the first job (finding 1).
4. **Pull-request-style integration** for revisions (finding 2). T3 0.1.3 only opens real PRs by
   pushing to a remote; decide between giving game projects a remote and tracking local branches
   as Studio "pull requests".
5. **Test run 2.** The user picks a new game. Aim for cards that can run in parallel, both
   machines online, art assets from `Assets/`, and driving it from the Studio UI rather than
   scripts.

Update 2026-11-07: `deploy/studioctl on` now runs both as boot services (`status`, `logs`, `off`).
By hand: `t3 serve --host 127.0.0.1 --port 3773`, then `npm run hub` in `studio/`; Studio is at
http://127.0.0.1:4600. Restart the hub by its PID (`ss -ltnp | grep 4600`); `pkill -f` on the
server path can match the shell running it.
