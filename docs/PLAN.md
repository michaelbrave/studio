# Studio — a harness of harnesses, shown as a game dev tycoon

> Working name: **Studio** (placeholder). This is a living plan; edit freely.

## 1. The idea in one paragraph

A local-first app that runs real coding agents (Claude Code, Codex, Hermes, OpenCode, …) on real
projects across **every computer in the house**, shown as a *Game Dev Tycoon*–style studio:
little staff at desks, points bubbling up as they work, projects with progress bars, releases and
reviews at the end. Every agent is hired into a **Role** (personality, duties, model; worn as its
hat: Designer, Researcher, Critic, Engineer, QA…) and equips **Kits**, bundles of skills, MCP
servers and permissions that sit on its desk as tools. Agents remember what they learn in a shared **markdown vault**
you can open in Obsidian. Art inspires life: the game is how you see the work, and the work is real.

### First release

Studio lets me assign a real coding job to either of two household machines, watch its actual
state in a small animated office, review the resulting change, and retain feedback for the next
job. It recovers from connection loss without duplicating work or losing track of the result.

The stages below have observable exit criteria rather than calendar estimates. Manual assignment
comes first; a small studio view comes before autonomous coordination. Voice, decision-model
routing, extra adapters, and richer game systems follow demonstrated needs.

## 2. Decisions so far

| Decision | Choice |
|---|---|
| Foundation | **T3 Code** (MIT). Stock T3 runs on every worker; Studio **sits on top** and drives it. Pin a tested version initially and verify compatibility before upgrades. Fork only for missing seams, and send those upstream as PRs (§4). |
| OpenRig | A source of **features to add on top**: agent spec format, team edges, startup files and actions, handover/continuity. |
| Claw-Empire | **Reference for the frontend feel** only (pixel office, XP, meetings). We don't copy its code or architecture. |
| Roles & Kits | Rebuild from scratch (the old repo is lost and out of date anyway). Built into Studio, not a separate tool. A **Role** is who an agent is (its hat); **Kits** are tool bundles it equips (desk widgets) (§6). Claude Code Game Studios (MIT) is a source of ideas for game roles and skills, rewritten for Studio rather than copied. |
| Memory | Markdown vault (Obsidian-compatible), LLM-wiki pattern. Exact tooling is a research spike (§7). |
| Budgets | Not token caps. Budgets are **subscription windows** (5-hour / weekly limits). T3 already pauses and auto-resumes; we build on that. |
| Multi-machine | Must have. T3 already gives one client → many machines; we add studio-wide coordination (§8). |
| Hub | A **low-power always-on mini PC** hosts the studio: shared state, dispatch, voice-to-text. It runs no coding agents and no local LLM; those run on the other machines or through APIs. |
| Producer | **Cheap API model** plans the work; plain scoring code picks eligible setups first. Decision models are a later experiment (§8a). |
| Sync | **Git** for Kits and the vault. |
| Agent "stats" | **No RPG stats/XP.** You rate finished jobs **1–5 stars** by task type; averages build up per model / harness / Role / Kits (§10a). Stars show up as stickers. |

## 3. What T3 gives us for free (checked in the code)

- **Provider adapters** behind one interface (`packages/provider-core/src/server/ProviderAdapter.ts`),
  with Claude (Agent SDK), Codex (app-server), Cursor, Grok, OpenCode, Pi, Antigravity and ACP agents.
  Adding Hermes = one new adapter package (`docs/internals/adding-a-provider.md`).
- **Event-sourced orchestration** (`apps/server/src/orchestration-v2/`): commands → events → projections,
  side effects in an outbox. This normalized event stream is what drives the game.
- **Usage-limit recovery**: `UsageLimitRecoveryWorker.ts` + `limitRecovery { resetAt, autoResume, snooze }`
  on threads, plus per-provider limit readers (`provider/claudeUsageLimits.ts`, `codexUsageLimits.ts`).
- **Kit injection points already exist.** The Claude adapter passes `mcpServers`, `allowedTools`, and
  `disallowedTools` to the SDK (`Adapters/ClaudeAdapterV2.ts`). The Codex adapter sets `developer_instructions`
  and `mcp_servers` (`Adapters/CodexAdapterV2.ts`).
- **Remote environments**: each machine runs a server with a stable environment ID. Clients
  (web/desktop/mobile) connect to several at once over LAN, Tailscale, SSH, or T3 Connect.
- Git checkpoints using hidden refs, worktrees, PR linking, terminals, and the mobile app.

**What T3 lacks (our work):** the idea of agents as persistent staff with identity, Kits, teams and
relationships between agents, shared memory, coordination across machines, and the game.

## 4. Build on top of T3 (fork only if we must)

Goal: **stock T3 on every worker machine, upgraded after compatibility checks**, and Studio as our own
app that drives it from outside. We fork only for a seam we can't get any other way, and then
offer that seam upstream as a PR.

**Why this looks doable** (checked in the code): T3 already exposes an **MCP server for outside
agents** at `https://<environment>/mcp` (`apps/server/src/mcp/`, `docs/user/outside-agents.md`).
It has sign-in/pairing and access levels (read-only → full), and orchestrator tools such as
`create_threads`, `delegate_task`, `task_status`, `task_cancel`, plus scheduled tasks. Its typed
RPC (`packages/contracts`, `packages/client-runtime`) is what its own web/mobile clients use, and we
can use it too for live event subscriptions.

**Layers**

| Layer | What | Changes to T3? |
|---|---|---|
| 0. Workers | Stock T3 server on each machine with the agent CLIs signed in | None |
| 1. Studio hub | Our app on the mini PC: roster, dispatch, Producer, ratings, Kits, vault, game UI. Talks to each worker over T3's MCP/RPC | None |
| 2. Kit delivery | Before starting a thread, Studio writes the Kit into the Attempt's worktree in each CLI's own format: `CLAUDE.md`/`AGENTS.md` (soul + rules + memory brief), `.mcp.json`, `.claude/skills/`, `.agents/skills/` | None, *if* T3's sessions load project-level files (to check in Stage 0) |
| 3. Seams | Anything blocked, e.g. "per-thread extra instructions / MCP servers / tool allowlist" passed through the start-thread call | Small PR upstream first; fork patch only while it's pending |

**Fork hygiene, if we do fork:** patches live as a short stack of commits on top of upstream,
rebased regularly; each one is either an open upstream PR or clearly marked "ours only". No large changes inside T3's core.

**Contributing back:** T3 takes small fixes and is cautious about big features. So: bugs and small
seams → PRs; bigger ideas → their Ideas discussion first. Keep a `UPSTREAM.md` log of what we found, filed, and got merged.

**Studio repo layout** (separate repo, T3 used as a dependency):

```
apps/
  hub/               # server on the mini PC: roster, dispatch, Producer, ratings, sim, vault, voice inbox
  web/               # studio UI (React + PixiJS), served by the hub
packages/
  t3-bridge/         # client for each worker's T3 (MCP + RPC), event subscription → normalized events
  kits/              # Kit schema, loader, compiler → files written into the worktree
  sim/               # pure: events → game state (no I/O, heavily unit-tested)
  memory/            # vault layout, inbox → wiki ingest/lint helpers, memory MCP server
kits/                # built-in Kits
```

Hermes (and other harnesses T3 doesn't support) becomes a T3 provider adapter, which is a natural upstream PR.

## 5. Core concepts

- **Environment / Floor**: one worker machine running a stock T3 server (T3 environment). In the game, each
  machine is a floor or room of the studio, labeled with its name and what it can do (GPU, OS, installed CLIs, signed-in accounts).
- **Role**: who an agent is: title (worn on its hat), personality, duties, permission preset,
  preferred runtime and model, and which Kits it may equip. Versioned folder, synced to every machine.
- **Kit**: an equipable bundle of tools: skills, MCP servers, tool-usage rules, extra permissions.
  Shown as a widget on the agent's desk. Several Roles can share a Kit.
- **Loadout**: a Role plus the Kits equipped for one job (the Role's defaults, plus any optional
  Kits it lists). Frozen into an immutable snapshot recorded on the Attempt.
- **Staff (agent)**: a persistent identity hired into a Role: name, sprite, sticker wall, memory folder,
  overrides. Two staff can share a Role with different souls ("brutal critic" vs "gentle mentor").
- **Project**: a real repo/folder. Has a genre/type that suggests which Roles to use.
- **Job**: a desired outcome with acceptance criteria, dependencies, project, and review/integration status.
- **Attempt**: one execution of a Job, associated with a worker and T3 thread. Records its base
  commit, isolated worktree, output branch/commit, staff, immutable loadout snapshot, and runtime
  fingerprint. Retries and moves create linked attempts without replacing the Job.
- **Artifact**: an identified output of an Attempt, such as a commit or report. Reviews target an
  exact artifact version; changing that artifact requires renewed review.
- **Capacity resource**: a provider/account subscription pool or worker concurrency slot.
  Multiple machines may share the same subscription pool.
- **Team edges**: `delegates_to`, `reviews`, `critiques`, `observes` (from OpenRig). How a Critic gets
  pointed at the Designer's output, and how a Producer hands out work.

## 6. Roles and Kits (the loadout system)

A Role says who the agent is; Kits are what it has on its desk. A job picks a Role, and the Role's
default Kits are equipped unless the job adds optional ones (or leaves defaults off). Two Kits may
not provide the same skill or MCP server name.

```
roles/game-designer/            kits/balance/
  role.yaml   # manifest           kit.yaml   # manifest
  soul.md     # personality        rules.md   # how to use these tools (optional)
  rules.md    # duties, done-ness  skills/    # Agent Skills (SKILL.md folders)
                                   mcp.json   # MCP servers this Kit brings (optional)
```

```yaml
# roles/game-designer/role.yaml
name: game-designer
version: "0.1"
title: Game Designer                       # printed on the hat
description: Designs mechanics and systems as specs programmers and testers can work from.
runtime: { preferred: claude, fallback: [codex] }
model: { default: claude-opus-5-5, effort: high }
soul: soul.md
rules: rules.md
permissions: { preset: workspace-write }
kits:
  default: [handoff, design-docs, guardrails]
  optional: [balance, playtesting]
memory:
  read: ["studio/", "projects/{project}/", "staff/{staff}/"]
  write: ["staff/{staff}/", "projects/{project}/inbox/"]
game: { points: [design], categories: [design, writing] }   # bubbles; rating categories (§10a)
```

```yaml
# kits/guardrails/kit.yaml
name: guardrails
version: "0.1"
title: Guardrails
description: Blocks destructive shell and git commands, and reading secrets files.
rules: rules.md
skills: []
permissions: { deny: ["Bash(rm -rf *)", "Bash(git push --force*)", "Bash(git reset --hard*)", ...] }
requires: { capabilities: [] }             # used to choose a machine (§8)
game: { widget: shield }                   # desk widget
```

Quote templated paths (`"projects/{project}/"`): `{` starts a mapping in YAML flow lists.

**Built in so far:** Roles Software Engineer, Code Critic, Game Designer, Gameplay Programmer, QA Lead,
Creative Director. Kits Handoff, Guardrails, Code Review, Design Docs, Balance, Playtesting.
**Still to come:** Producer (lead: breaks down goals, hires, assigns), Researcher (search/fetch
MCPs, citation format, aggressive context trimming), Writer, Librarian (looks after the vault, §7).

**Loadout compiler.** Plan A (no fork) writes the loadout into the Attempt's worktree as files each CLI already
reads. Plan B, if Stage 0 shows the files aren't picked up, passes the same pieces as session options
through a small upstream seam. T3's adapters already accept these options internally.

| Kit piece | Plan A: files in the worktree | Plan B: Claude (Agent SDK) | Plan B: Codex (app-server) |
|---|---|---|---|
| soul + rules + memory brief | `CLAUDE.md` / `AGENTS.md` | `systemPrompt` append | `developer_instructions` |
| skills | `.claude/skills/`, `.agents/skills/` | skills dir | `.agents/skills/` |
| mcp | `.mcp.json`, `.codex/config.toml` | `mcpServers` | `mcp_servers` |
| permissions | `.claude/settings.json` + T3 runtime mode | `allowedTools` / `disallowedTools` | sandbox + approval policy |

Kit-generated files must stay out of deliverable commits, and a Kit never touches global
`~/.claude` / `~/.codex`. Local git excludes only help with untracked files: they do not protect
existing tracked instructions or configuration. Preserve project instructions and define their
composition with Kit instructions. Prefer session injection where a file would collide; otherwise
use a validated, reversible overlay with cleanup and a diff check before handing off artifacts.

The compiler returns a capability report for each provider: **supported**, **unsupported**, or
**degraded**, with reasons. Unsupported permission enforcement blocks launch; optional presentation
or personality differences can be reported as degraded. Verify actual tools, MCP visibility, and
denied operations rather than relying on the agent's account of what it loaded.

Remote preparation is an explicit bridge operation: create/select the isolated worktree, deliver
and validate the Kit, then start execution. Stage 0 must establish which supported T3 operation
can prepare files before the agent starts. If none exists, specify a narrow upstream seam or an
explicit worker-side helper; do not assume the hub can write worker paths directly.

## 7. Memory: the vault

Approach: Karpathy's **LLM Wiki** pattern (April 2026 gist). Agents *compile* knowledge into
linked markdown pages once and keep them current, rather than searching raw history again every
time. Obsidian is just the viewer ("Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase").

```
vault/
  index.md                 # master index: every page + one-line summary (agents read this first)
  studio/                  # studio-wide: conventions, people, machines, lessons learned
  projects/<project>/
    index.md  hot.md       # hot.md = short rolling "what's happening now" cache
    decisions/ notes/ inbox/   # inbox = raw notes from agents, not yet merged in
  staff/<staff>/
    memory.md              # this agent's own lessons, preferences, past critiques
  raw/                     # unchanged sources: transcripts, job summaries, research dumps
  board/cards/<id>.md      # the task board: one kanban card per file (column, role, jobs, criteria)
```

**Task board.** Work is organised on a kanban board kept in the vault, so it is versioned and synced
with git and needs no hosting. Columns: Proposed → Backlog → Ready → Doing → Review → Done (and
Blocked). Each card is assigned to a Role, and so to its department (Programming, Design, QA,
Direction, Production). The Producer proposes cards; you approve them. A card's column follows its
latest job automatically. In the studio view the cards are the notes pinned to the wall.

- **Writing**: when an Attempt produces a result, the server writes a job summary to `raw/` and a short note to the
  project `inbox/`. Each submission has a unique ID for deduplication. The **Librarian** (a cheap model, idle-time job) *ingests* the inbox into wiki
  pages, updates `index.md`/`hot.md`, and *lints* (contradictions, stale pages, broken links).
- **Reading**: the Kit compiler adds a short memory brief (index + hot.md + staff memory.md) to the
  instructions within a fixed size budget; use project-scoped summaries rather than injecting the complete vault index. Record the memory snapshot used by each Attempt. Deeper reads go through files or a small `studio-memory` MCP (search with SQLite FTS5 first; embeddings only if needed).
- **Ownership and sync**: the hub Librarian is the sole writer of canonical wiki pages. Workers
  submit immutable inbox notes; they do not concurrently edit/push canonical pages. The hub commits
  canonical updates to git and workers consume snapshots. Pages retain source note/artifact IDs,
  timestamps, and supersession links so corrections can be traced.

**Stage 3 research spike (before adopting memory tooling):** compare the existing projects — e.g.
[ar9av/obsidian-wiki](https://github.com/ar9av/obsidian-wiki),
[akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory), and the Obsidian MCP servers
(mcp-obsidian etc.) — on: works without Obsidian running, works with several agents writing at
once, cost of ingest, and quality of what's retrieved. Choose whether to adopt one, vendor one, or write our own thin version.

## 8. Multiple machines

**What T3 does today:** one client connects to many environments (machines). But each project and
thread belongs to one environment, and *environments never send work to each other*
(`docs/internals/remote.md`). So it's "one remote control, many TVs", not machines working together.

**What we add:**

1. **Studio roster**: a shared list of environments with capabilities (OS, GPU, installed CLIs,
   signed-in accounts, account-linked subscription headroom and observation time), shown as floors in the game.
2. **Dispatch**: the Producer (or you) can assign a job to the best machine: "needs Windows build",
   "needs GPU", "Claude account on desktop is limited until 3pm → run on the laptop's Codex".
   Dispatch runs on the **hub**, so it works with no client open. The hub connects to each
   worker machine as a client (the same route/auth T3 already uses) and starts the thread there.
3. **The hub machine** (small, always on, no coding agents): Studio server in "hub mode" (studio
   state, roster, dispatch, ratings, vault/Kits git remotes), the web UI, and a **voice inbox**:
   local speech-to-text (e.g. whisper.cpp / faster-whisper) turns a voice note into a text request
   to the Producer, or a reply to a pending decision. The mini PC is weak, so use a small model
   (whisper `base`/`small` on CPU is fine for short notes) or a speech-to-text API as a fallback. The
   Librarian also runs here, using a cheap API model.
4. **Shared state** across machines: Kits (git repo), memory vault (git repo), staff identities and
   ratings (authoritative on the hub). Project checkouts stay per machine. Handoffs between machines go through git branches + T3's existing
   context-handoff summaries. A move creates a new Attempt only after the previous Attempt is confirmed stopped or explicitly reconciled.
5. **Subscription-aware scheduling**: capacity belongs to a provider/account pool, not a staff member or machine. Two workers using the same account share that pool. Store observation timestamps and an explicit unknown state. Filter candidates by required capabilities, enforceable permissions, available slots, and known capacity before scoring. Then, when one account is limited, pause (existing T3 behaviour)
   *or* offer to move the job to another machine/account with headroom. The game shows it as a staff member "on a
   break" with a countdown.

### Execution, recovery, and integration contract

- Persist a dispatch intent and stable request ID before starting an Attempt. After a timeout,
  reconcile that request against worker state before retrying. Stage 0 must prove the necessary
  idempotency or lookup behavior through the bridge; ambiguous results stay **status unknown**.
- On hub restart or worker reconnect, reconcile persisted Attempts with worker snapshots and
  resume event consumption. Deduplicate events and recover gaps through snapshots/replay where
  supported. A disconnect alone never triggers a replacement Attempt.
- Track execution states separately from review: queued, preparing, running, awaiting input,
  capacity-paused, status unknown, stopped, failed, and result available. Record last observation
  time. Cancellation remains pending until confirmed; bound automated retries and log reasons.
- A result includes its base commit, output artifact, acceptance-check evidence, and handoff
  summary. Thread termination does not establish success. Job milestones are **ready for review**,
  **accepted**, and **integrated**; rejected work leads to another linked Attempt.
- Give each project an integration owner (the user initially). Review an exact artifact, then
  integrate serially into the target branch and validate the combined result. Changes after review,
  including conflict resolutions, require revalidation and any affected review again.
- Dependency edges identify required artifacts and acceptance milestones. Downstream Attempts
  receive explicit input versions, not an implicit view of whichever checkout happens to exist.
- The hub owns Jobs, Attempts, ratings, and dispatch intent; T3 owns actual thread execution.
  Studio clients use the hub for studio state. Direct T3 clients remain useful for inspection;
  changes made through them must be discovered by reconciliation.

## 8a. The Producer: planning vs. picking

Two different jobs, two different tools:

1. **Planning** (turn "make the inventory screen" into jobs, each with categories, requirements,
   and acceptance criteria). This needs a generative model: a **cheap API model** (e.g. Haiku-class).
   A local model isn't realistic on the mini PC.
2. **Picking** (which staff/setup gets each job). This is a bounded choice from a known list, which is
   exactly what **decision models** are built for. [Jev](https://shop.zimaspace.com/blogs/tech-ai-hub/what-is-jev-ai-decision-model-agents)
   (TypeSafe, Sept 2026) gives a **Choice** over a fixed candidate set, a **Score**, and yes/no
   probabilities, each with a confidence value, and lists routing between agents as a use case.

Design the picker as a pluggable interface so we don't depend on one vendor:

- **Inputs per candidate setup**: star averages for the job's categories (§10a) with counts, Role and Kit fit,
  machine capability match, subscription headroom / reset time, current queue, and cost.
- **v0: plain scoring code** (weighted sum of the inputs). Works on day one, easy to understand.
- **v1: a decision model** over the same candidates with the same context. Compare its picks against v0 and against your ratings.
- **Final decision stays in code**: the model *proposes*; when evidence is insufficient, or for
  risky/expensive jobs, it goes to the Decision Inbox for you to pick.
- Every pick is logged (`studio.job.assigned` with the candidates and reasons), so later ratings show whether the picker is getting better.

**The decision model is replaceable.** Since Jev, there are several models in the same category, so
the picker has one interface (`choose(candidates, context) → {pick, distribution, confidence}`)
and a backend per vendor:

| Backend | Notes |
|---|---|
| **Microsoft-Decision-1** (likely first choice) | Announced Oct 9, 2026 ([source](https://commandline.microsoft.com/microsoft-decision-1-model-foundry/)). Calibrated probability per option for yes/no, multiple-choice, and rating questions, plus rubric grading. Post-trained from Qwen3.5-9B. On **Foundry and OpenRouter**; $0.042 per 1M input tokens, output free. Very fast by Microsoft's own benchmarks. Routing and agent control (continue/stop/retry/hand off) are named use cases. Note: Microsoft plans to rebase it onto other models, so pin and log the version |
| Jev (TypeSafe) | The original; hosted API, waitlist |
| Other decision models | H2O-Lightning-4B (named in Microsoft's speed comparison), Strands Decider (open, ~1.9B, returns confidence; [source](https://clawaws.com/blog/strands-decider-decision-model-agent-routing/)); NVIDIA option still to confirm |
| Local model wrapped as a decider | Tools turn a local LLM into a decider (constrained choice + log-prob confidence). Slower, and no smarter, but no API dependency. Wouldn't run on the mini PC; a worker could host it |
| Cheap LLM with structured output | Last-resort fallback; confidence is less trustworthy |

**Other uses for the same decider** (cheap enough to call often):
- **Agent control**: when a job stalls or errors, choose continue / retry / hand off / ask me.
- **Gating**: "is this job ready for review?", "is this change risky enough to need approval?"
- **Suggested rating**: grade a finished job against its acceptance criteria as a *pre-filled*
  suggestion in the rating prompt. Only your rating counts toward the averages (§10a).

Every decision logs the backend name and model version, since a rebased model can behave differently.

**Evaluation:** replay and shadow mode measure agreement, latency, validity, and operational
behavior. They cannot establish which unchosen candidate would have produced a better result.
Start with manual assignment and deterministic scoring. Later compare eligible setups on repeated
benchmark tasks or limited randomized assignments, recording task difficulty, acceptance outcomes,
rework, elapsed time, and user ratings. Calibrate any confidence-based escalation on observed
outcomes in this workload; vendor confidence alone is not an authorization signal.

The backend list above is a research shortlist, not a release dependency. Verify availability,
pricing, and API behavior when the experiment is scheduled. Introduce a decision-model picker only
when it demonstrably improves outcomes over the simple baseline.

## 9. Architecture

```
  Studio clients (web / phone) ── connect to the hub
  T3 clients may connect directly to workers for inspection
  Hub (small, always on)                   Worker machines (desktop, laptop, …)
  ┌──────────────────────────────┐        ┌────────────────────────────────┐
  │ Studio hub (our app)         │──────► │ stock T3 server (MCP + RPC)    │
  │  roster, dispatch, Producer, │dispatch│  orchestration-v2              │
  │  ratings, sim, decision inbox│◄────── │  provider adapters:            │
  │  web UI (/studio)            │ events │  claude · codex · hermes ·     │
  │  voice inbox (speech-to-text)│        │  opencode · cursor · pi …      │
  │  git remotes: kits/ vault/   │        └────────────────────────────────┘
  └──────────────────────────────┘        (no coding agents run on the hub)
```

## 10. The game layer: real work → tycoon mechanics

Rule: **the sim is computed only from real events.** Activity is not progress or quality.
Progress advances through verified acceptance criteria or milestones, never tool-call counts.
Unknown, disconnected, awaiting verification, and genuinely blocked are distinct visible states.
If remaining subscription capacity is unknown, show that rather than inventing an energy level.

| Real signal | Game representation |
|---|---|
| Agent streaming work | Sprite typing; animation matches tool kind (reading → book, browsing → monitor glow, tests → beaker) |
| Tool calls by category | Activity bubbles (no progress credit): **Design**, **Tech**, **Research**, **Polish** |
| Failing tests / lint / review comments | Failure/review signals with context; expected test-first failures are not automatically bugs |
| Subscription usage | Shared account capacity indicator with freshness/unknown state; confirmed limit → coffee break |
| Approval needed / blocked | "!" bubble over head → Decision Inbox |
| Critic reviewing | Critic walks to the designer's desk; the critique links to the reviewed artifact and findings |
| PR merged / build shipped | Release screen with review scores, verified release milestones |
| You rate a finished job | Star stickers stuck on that staff member's desk/sticker wall (§10a) |
| Context compaction | Sprite stretches / refills coffee |
| Each machine | A floor of the building; new machine = "studio expansion" |
| Role | The agent's **hat**, labelled with the role title ("Lead Programmer", "Motion Designer") |
| Harness | The **shirt colour** (Claude Code = Claude orange, Codex = its own colour) |
| Model | Printed on the shirt: the vendor's logo and the model name |
| Equipped Kits | Little tools/widgets on the agent's **desk**, one per Kit |
| Librarian ingesting | Someone filing papers in the archive room (the vault) |

## 10a. Star ratings: learning which setup is good at what

Instead of made-up stats, **you** rate finished jobs, and the studio slowly learns things like
"Codex is a 4.6★ debugger but a 2.1★ designer".

- **Task categories** (each job has one or more, set by the Producer/Role, and you can change them):
  coding, debugging, design, writing, research, review/critique, admin/planning. The list can grow.
- **Rating**: when a job finishes (or its PR merges), the Decision Inbox asks for 1–5 stars per
  category, with an optional one-line note. One tap, skippable. Stored as a `studio.job.rated` event.
- **Fingerprint**: every Attempt records exactly what ran it: harness + version, model + effort, Role +
  version, equipped Kits + versions, soul (hash), skills and MCP set (hashes), machine. Ratings record the evaluated artifact and contributing Attempts; do not silently credit a multi-attempt outcome to one setup.
- **Averages at several levels**, so you can see the answer at whatever level matters:
  model × harness → + Role → + Kits and soul (the full setup). Use a weighted (Bayesian) average and
  show the count ("4.3★ · 12 jobs") so a single 5★ doesn't put a setup at the top. Keep task difficulty and acceptance/rework outcomes visible; these are personal observations, not controlled evidence that one setup is universally better.
- **What it's used for**: a leaderboard per category; the Producer is *suggested* the best-rated setup
  for each task; comparing Role and Kit versions ("did the new designer soul actually help?", "does the Balance Kit help?").
- **The game**: gold/silver/bronze stickers on the desk per category, a "Studio Awards" screen per
  project release, and the sticker wall shows each staff member's best categories at a glance.
- Your note goes into the vault (`staff/<staff>/memory.md`) so the agent learns from feedback, not just the scoreboard.

Phases per project, after Game Dev Tycoon: *Plan → Build → Polish → Review → Ship*.
Art: our own pixel art, starting from licensed open packs (Kenney / LimeZu-style). Only the feel comes from Game Dev Tycoon, not its assets or branding.

## 11. Roadmap

**Stage 0: Integration proof.** ✅ Done on two workers (studio/docs/stage0.md); Codex Kits on
remote workers and some recovery drills against real T3 remain open there.
- Pin a tested T3 version; establish two workers and hub pairing. Start `UPSTREAM.md` and record
  the MCP/RPC capabilities and compatibility checks the bridge requires.
- Remotely prepare one hard-coded Kit and isolated worktree, then start, observe, and cancel work.
  Test Claude and Codex instruction composition, MCP visibility, and permission enforcement.
- Exercise lost dispatch responses, hub restart, worker disconnect/reconnect, and duplicate events.
- **Exit:** lost responses and restarts do not duplicate work; ambiguous execution is visible;
  remote preparation and Kit behavior are verified. Document any required seam before expanding.

**Stage 1: Complete work loop (plain UI).** ✅ Done 2026-10-28 (studio/docs/stage1.md), together with
the task board and a first Producer that proposes cards (pulled forward from Stage 3).
- Hub SQLite state, roster, bridge, Projects/Jobs/Attempts, live log, and Decision Inbox.
- Manual assignment, Engineer and Critic Kits, artifact-specific review, serial integration.
- Immutable job notes and bounded memory briefs; simple ratings with Attempt fingerprints.
- **Exit:** a real change runs on a selected worker and becomes a reviewed, integrated result,
  with its execution, artifact, feedback, and recovery history retained.

**Stage 2: Minimal studio.** 🟡 First version built 2026-10-28 (studio/docs/stage2.md): canvas office
from Kenney CC0 art, scene from `packages/sim`. Canvas 2D was chosen over PixiJS: no build step, and
it redraws only on change. Exit still needs validation in daily use.
- Pure event-to-view simulation and a small PixiJS office: floors, desks, real activity,
  blocked/unknown/disconnected states, and clickable job details.
- Keep operational controls and detailed logs accessible from the studio.
- **Exit:** everyday work can be understood and managed from the studio view; progress displays
  are tied to verified milestones. Validate whether the game view is useful during real work.

**Test run 1** (2026-10-29, studio/docs/testrun-tetris.md): a browser Tetris built through Studio.
It worked end to end, but needed scripts to chain the steps and a person for many approvals. Next,
in order: a heartbeat Project Manager that keeps cards flowing and shows dependencies; sending a
review's notes back to the same work; git setup as step 0 for new projects; pull-request-style
integration; then test run 2 with parallel cards on both machines, driven from the UI.

**Stage 3: Assisted coordination.**
- API Producer proposes Jobs with acceptance criteria and dependencies; user reviews plans.
- Deterministic picker filters eligibility before ranking; assignments include reasons.
- Single-writer Librarian ingest, provenance, deduplication, retrieval, and bounded memory briefs.
- Add Designer/Researcher Kits when required by actual projects; collect outcome data.
- **Exit:** dependent Jobs complete with explicit artifact handoffs, understandable scheduling,
  and recovery. Evaluate planning quality and user intervention before increasing autonomy.

**Next ideas** (from research.md review, 2026-11-07; morning brief done, see studio/docs/discord.md):
- **Hardening ladder.** Work moves up a ladder only on evidence: first time, figured out (job
  notes) → refined over a couple of runs → **skill** (Librarian proposes it from accepted jobs'
  lessons; you approve, like cards) → once used often, a **harder form** chosen per case: a script
  the skill calls, a rule (Kit permission rule, hook, lint/test check), or a scheduled loop run by
  the hub's scheduler (as the brief is; no n8n needed). Promotion is proposed from usage counts
  and ratings (§10a); each rung keeps the rung below as fallback, and a hardened form that starts
  failing (project changed) is demoted back to the skill rather than left to rot.
- **Cost tiers per Role**: free OpenCode models for routine work (Librarian, first-pass checks),
  Claude/Codex for engineering; ratings show whether the cheap tier keeps up.
- **A Discord thread per job**: notifications and replies for one job in one thread, so "approve
  it" is never ambiguous; notes written there go back to the same work ("send back with notes").
- **More harnesses**: T3 supports more drivers (e.g. Pi, DeepSeek's harness); adding one should be
  an `INSTANCE`/`HARNESSES` entry plus a Kit compiler, as OpenCode was.
- **Browser automation, optional**: OpenCode's browser add-on as a Kit when a job needs it
  (scraping, playtesting); not agents building their own browsers.
- Later, maybe: a cheap model pre-screens approval requests (marks routine/unusual, never approves).

**Stage 4: Expansion driven by observed needs.**
- Decision-model experiments against a baseline using the evaluation method in §8a.
- Voice inbox, confirmed-stop cross-machine handoff, additional adapters such as Hermes.
- Kit editor/import/export, mobile refinements, richer studio animations and release screens.
- **Exit for each addition:** it solves an observed problem and passes its own operational and
  compatibility checks. None of these features blocks the first release.

**Ideas noted from use (2026-11-14), not started:**
- **Carry on with another harness or model.** When an agent stops on a plan limit, offer
  "continue on Codex" (or another model) next to Restart. T3 already switches models and harnesses
  for a thread and recovers from usage limits (`limitRecovery`); Studio would start the next
  attempt on the other harness from the stopped attempt's branch (`baseRef`), with a brief that
  says what was already done, and record the switch in the job's history. The plan meter
  (`/api/usage`) already tells which harness has room.
- **A catalog of skills, tools and MCP servers from GitHub.** An index of repositories that publish
  skills/MCP servers/agents, with what each does and how well it rates, so a Kit can mix and match
  from it without copying everything locally: Studio keeps only the pointer (repo, path, commit)
  and fetches a pinned version when a Kit is compiled. Ratings could come from our own job
  ratings (§10a) plus the source's stars.
- **Streaming the office (e.g. Twitch), with a host.** A host agent narrates what each agent is
  working on, reads the stream chat, and decides which viewer ideas are worth passing to the
  Studio Manager as proposed cards (never straight to an agent, never approving anything itself).
  Needs a read-only "broadcast" view of the office and a scope for the host like Hermes' (§ MCP).
- **More looks for the staff:** hairstyles, beards, glasses, hats under the cap, picked from `look`
  like skin and hair colour are today, so each agent keeps the same face.

## 12. Open questions

1. Which supported T3 surface permits remote worktree preparation and Kit delivery before launch?
2. Which operations and event-recovery guarantees are available through MCP versus RPC? What
   compatibility contract must the bridge test before accepting a worker upgrade?
3. Which cheap API model produces useful plans and memory updates on our actual workload?
   Choose through bounded Stage 3 trials.
4. Workers on different networks: which supported connection method best handles reconnects
   and pairing for the household's machines?
5. What is the minimal artifact/integration workflow for non-code projects? Establish it when
   adding the first such Kit, without assuming every output is a pull request.
