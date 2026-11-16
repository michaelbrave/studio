# Ideas, decisions, and attribution

This is Studio's record of where ideas came from, why we adopted them, and how they
changed. Started **2026-11-15**. The initial entries reconstruct earlier work from Mike's
recollection on that date and the repository's existing documentation and history.
Their original decision dates are unknown unless stated otherwise. Entry numbers are
stable references, not a claim about the exact order in which ideas occurred.

**History review (2026-11-15):** Later the same day, the local Claude Code and Codex
transcripts for this project were reviewed (listed under [Conversation sources](#conversation-sources)).
That review added dated **Updates** to the entries below and added IDEA-009 onward.
Dates are local (Pacific) dates. Transcript timestamps are UTC, so a late-evening
conversation can appear in the transcript under the next day.

Record future decisions as we make them. Keep the reasoning and attribution even when
an idea is rejected or replaced. This document complements the current design in
[PLAN.md](PLAN.md), the T3 integration findings in [UPSTREAM.md](../UPSTREAM.md), and
the asset/license credits in [CREDITS.md](../apps/web/assets/CREDITS.md).

## How to keep this record

- Add an entry when we adopt, materially change, or reject a product, architecture,
  visual, or workflow idea. Routine fixes do not need their own entries.
- Say what problem led to it, what we chose, why, and the meaningful tradeoffs.
- Credit the person or project that introduced the idea. Distinguish inspiration,
  an adapted design, reused code/assets, and a dependency. Several sources can contribute
  to the same feature; record each one's contribution.
- Link the source and the resulting design/code/PR where available. For direct reuse,
  identify the original file/version and retain the applicable license notices.
- Record a source's address (repository URL, post or video link, author) when it is first
  saved or brought in, not later. A downloaded copy without its address is hard to attribute.
- Separate explicit recollection, repository evidence, and inference. Mark missing
  details as unknown; a similar feature elsewhere does not establish its origin here.
- For a changed decision, add a dated update or a new entry referencing the old one.
  Preserve the earlier reasoning rather than silently rewriting it as today's view.

## Initial record

### IDEA-001 — A game development studio as the interface

**Recorded:** 2026-11-15 · **Status:** Adopted · **Relationship:** Conceptual inspiration

**Sources:** *Game Dev Tycoon*; Mike's recollection; [PLAN.md §1 and §10](PLAN.md).

**Idea and reasoning:** Present real agent work as a small game development studio.
Staff, desks, project phases, and releases give the work a familiar visual structure.
The existing README explains the practical aim: make it easy to see who is working,
waiting, or failing across several agents.

**Our adaptation:** The office represents real work and observed states. The plan's
project phases draw on Game Dev Tycoon, while progress must come from verified milestones.
The game is credited for the concept and feel; the README records that its art and code
were not borrowed. See [README: Why this exists](../README.md#why-this-exists).

**Updates:** 2026-11-15 (history review): Mike first described the idea on 2026-10-22 (S1).
He wanted the frontend to "somewhat resemble the game 'indie dev tycoon'", but with the little
people working on our actual projects, some of them games: "have art (the video game) inspire
life (agents actually making games)". The plan uses *Game Dev Tycoon*. That name is assumed to
mean the same game. `AI-Harness/Art Inspo/` (2026-10-27) holds Game Dev Tycoon screenshots
and two other studio-sim reference images (`city-game-studio.jpg`, `My-Leisure-Time*.jpg`);
the games those two show have not been identified.

### IDEA-002 — Little office workers representing LLM agents

**Recorded:** 2026-11-15 · **Status:** Adopted · **Relationship:** Interface inspiration

**Sources:** [Claw-Empire](https://github.com/GreenSheep01201/claw-empire);
Mike's recollection; [PLAN.md §2](PLAN.md). The URL is recorded in the local reference
checkout's origin configuration.

**Idea and reasoning:** Represent agents as little people in an office, making a team
of otherwise separate sessions visible in one place. This contributed to the original
interface concept alongside Game Dev Tycoon.

**Our adaptation:** Staff at desks represent agents and their actual state. The plan
names Claw-Empire as a reference for frontend feel, rather than code or architecture.
Its mention of XP is historical inspiration: Studio subsequently chose job ratings
instead (IDEA-007).

**Updates:** 2026-11-15 (history review): Claw-Empire, OpenRig and T3 Code were the three
orchestration projects Mike put in the folder on 2026-10-22 "to learn from them and create our
own" (S1). His framing then: "claw empire is an example of how the frontend could be ... rather
than trying to copy claw empire."

### IDEA-003 — Build the Studio layer on T3 Code

**Recorded:** 2026-11-15 · **Status:** Adopted · **Relationship:** Dependency and architectural decision

**Sources:** [T3 Code](https://github.com/pingdotgg/t3code); Mike's recollection;
[PLAN.md §2–4](PLAN.md); [README: How it fits together](../README.md#how-it-fits-together).

**Decision and reasoning:** Make Studio an interface and coordination layer over T3,
instead of rebuilding the underlying agent harness. Reuse its provider integration,
sessions, worktrees, approvals, and recovery so Studio can concentrate on staff,
Roles/Kits, shared memory, reviews, and the office.

**Tradeoff:** Studio depends on T3's exposed interfaces and version compatibility.
Stock T3 runs on workers; the hub talks to it through MCP/RPC. Missing interfaces and
workarounds are tracked in [UPSTREAM.md](../UPSTREAM.md). This choice is already present
in the first Studio commit, `b79615d` (2026-11-13); that is evidence of when it was
recorded in this repository, not when it was first conceived.

**Updates:** 2026-11-15 (history review): Mike made this call on 2026-10-22 (S1): "t3 is the
best foundation ... if I was cloning something it would be t3 and then the other features would
be addons on top of it." In the same conversation he also asked that Studio:

- "sits on top of t3 so we can receive updates";
- sends T3 pull requests for things worth fixing, the origin of [UPSTREAM.md](../UPSTREAM.md);
- keeps T3's multi-computer pairing (IDEA-009).

On 2026-10-27, Codex reviewed and critiqued the plan at Mike's request, and the plan was then
updated (S2). The changes it made are not separately recorded.

### IDEA-004 — Agent specifications, team relationships, and continuity

**Recorded:** 2026-11-15 · **Status:** Design influence; implementation varies by feature
**Relationship:** Feature/design inspiration

**Sources:** [OpenRig](https://github.com/mvschwarz/openrig);
[PLAN.md §2 and §5](PLAN.md). The URL is recorded in the local reference checkout's
origin configuration. Mike recalls the influence but not the particular features;
the existing plan supplies the list below.

**Ideas recorded in the plan:** Agent specification format; team edges; startup files
and actions; handover/continuity. Section 5 explicitly attributes the relationship names
`delegates_to`, `reviews`, `critiques`, and `observes` to OpenRig.

**Reasoning and adaptation:** These concepts help describe agents' responsibilities,
how they relate, and how work continues between sessions. This explanation follows
their role in the plan; the original discussion is unavailable. OpenRig was identified
as a source of features to add above T3. This entry does not establish that every
listed feature has shipped or identify any copied implementation.

**Updates:** 2026-11-15 (history review): On 2026-10-22 Mike said "openrig has some features
that are good" and that they would be "addons" on T3 (S1). Its pause-and-resume around 5-hour
subscription limits came up in the same conversation (IDEA-011). The transcripts do not list
the other features in more detail than the plan does.

### IDEA-005 — Game studio roles and skills

**Recorded:** 2026-11-15 · **Status:** Adopted · **Relationship:** Role/skill inspiration

**Sources:** Claude Code Game Studios; Mike's recollection; [PLAN.md §2 and §6](PLAN.md).
A local reference archive is named `Claude-Code-Game-Studios-main.zip`; its canonical
project URL and a file-by-file attribution map have not yet been established here.

**Idea and reasoning:** Use game development roles and relevant skills to give agents
clear duties and ways of working. Mike recalls that some skill files were inspired by
this project. The plan describes the game roles and skills as rewritten for Studio.

**Our adaptation:** Roles live in [roles/](../roles/), and reusable skill/tool bundles
live in [kits/](../kits/). The source influenced their content; job-specific loading
also has a separate origin in Mike's Freelancer project (IDEA-006).

**Still to recover:** Which particular skills and roles drew from which source files,
and the source revision. The plan labels the source MIT; direct reuse should be
documented against the actual source files and notices when identified.

**Updates:** 2026-11-15 (history review): Mike introduced the archive on 2026-10-27 because
it "might contain things we can add to our kits and as tools for roles" (S3). After Claude's
assessment he decided it was "good to pull ideas from but not to just copy it blindly". That
decision is the origin of IDEA-021. Claude proposed "turning roles into kits", and Mike
then defined the Role/Kit split (IDEA-013).

### IDEA-006 — Equip skills and tools for the job

**Recorded:** 2026-11-15 · **Status:** Adopted · **Relationship:** Mike's prior project/design experience

**Sources:** Mike and his earlier **Freelancer** project, explicitly credited by Mike
on 2026-11-15; [PLAN.md §5–6](PLAN.md) describes the resulting Studio design.
The earlier project's repository and original design records are not available in this record.

**Idea and reasoning:** Load the skills and tools an agent needs for its current job,
rather than keeping every capability loaded into the harness at all times. The job
determines the relevant equipment.

**Our adaptation:** A Role describes who an agent is; Kits describe its skills, rules,
MCP servers, and permissions. A job selects a loadout, which is compiled into the
provider's format for that attempt. See [packages/kits](../packages/kits/src/compile.ts).
This is the lineage of the loading idea; it does not claim the mechanism is unique
to Studio or that code from Freelancer was reused.

**Updates:** 2026-11-15 (history review): Mike described the idea on 2026-10-22 (S1), without
naming Freelancer. He wanted premade setups of "both personality and preloaded tools based on
the type of job". His examples:

- a designer with design workflows or MCP servers and a designer personality;
- a researcher with search tools, kept token-efficient, with rules for formatting research;
- a second designer spun up to critique the first.

He said it was "mostly inspired by people making openclaw agents with soul.md files"
(OpenClaw community practice; inspiration only; no specific project or link recorded). He
thought "it makes more sense to have the entire toolkit set aside in a custom way". He had lost
the old repo and judged that rebuilding it inside this "harness of harnesses" was better
anyway. The `soul.md` file in Roles keeps that lineage. PLAN §2 records the decision to rebuild
rather than recover.

### IDEA-007 — Ratings and observed state instead of invented stats

**Recorded:** 2026-11-15 · **Status:** Adopted · **Relationship:** Documented Studio design decision; individual proposer unknown

**Evidence:** [PLAN.md §2, §10 and §10a](PLAN.md);
[README: Principles](../README.md#principles).

**Decision and reasoning:** Use human ratings of completed jobs to learn which model,
harness, Role, and Kit combinations work well. Derive office activity and progress
from actual events and verified milestones. This makes the display useful for real
work and avoids treating activity counts as proof of quality.

**Tradeoff:** Ratings need human feedback and enough observations to be informative;
unknown state must remain visible. This records reasoning already in the plan.
The available evidence does not establish who first proposed it or an external source.

**Updates:** 2026-11-15 (history review): Correction: the proposer is known. On 2026-10-22
Mike proposed it (S1): "rather than stats we should give the agents awards for work they did
well, like star stickers". The awards would cover categories such as writing, coding, design
and administrative work. His example was Codex being good at coding and bug-fixing but bad at
design. Over time this would show "the star rating for certain types of tasks for that model,
in that particular harness, and maybe with that particular personality and skillset and
toolbox". His simplest version: "me give ratings on tasks out of 5 stars, and we average this
over time". The "real state only" half was also Mike's. On 2026-11-07 he removed the demo
office: "let's have it just show what's actually happening though going forward" (S5).

### IDEA-008 — Refine the office art direction

**Recorded:** 2026-11-15 · **Status:** Adopted as visual direction · **Relationship:** Visual inspiration

**Source:** Grokbot's office view, credited by Mike on 2026-11-15.

**Idea and reasoning:** Refine Studio's office art style using that office view as a
reference. This is a later visual influence alongside the original Game Dev Tycoon
and Claw-Empire concept influences.

**Still to recover:** The exact Grokbot project/page, screenshot or revision, and the
particular visual choices it informed. No code or asset reuse is established by this
recollection. Studio's shipped asset sources are recorded separately in
[the art credits](../apps/web/assets/CREDITS.md) and [README credits](../README.md#credits).

**Updates:** 2026-11-15 (history review): The reference is very likely the pair of X posts Mike
saved on 2026-11-07 in `AI-Harness/Example/` (S5). Both show a live office dashboard for Grok Bot
agent teams:

- a video and post text by Anatoli Kopadze ("set up a live dashboard for your Grok Bot agent
  teams"). Each bot posts a status line, teams get a floor each, and usage per bot is shown;
- `example2/`: codila's video "Introducing GrokBot's first live dashboard" and its prompt
  (`x-prompt.txt`).

This identification is inferred from the file names and contents; Mike can confirm it. Mike's
direction was explicitly a *difference* in style. The example used stars, triangles and other
shapes as agents, and he wanted "little 3D guys who wear t-shirts and hats with labels/logos".
That day Claude rebuilt the office in 3D with three.js (`apps/web/office3d.js`, 2D kept as a
fallback). The shirts use the logos in `AI-Harness/Icons`. No code or assets from the examples
were used. The example's per-bot usage and "needs me" states resemble Studio's later plan meter
and needs-attention box (IDEA-020), but no transcript links them.

## Recovered from conversation history (2026-11-15)

These entries were added after the history review. Each one cites the conversations
it comes from (S1–S8, listed under [Conversation sources](#conversation-sources)).
Quotes are Mike's words from those transcripts.

### IDEA-009 — Every computer in the house, one main hub

**Recorded:** 2026-11-15 · **Decided:** 2026-10-22, revised 2026-11-13 · **Status:** Adopted (main/support shipped)
**Relationship:** Mike's requirement; builds on a T3 feature

**Sources and contributors:** Mike (S1, S6); T3 Code's multi-machine pairing; Claude (S6).

**Problem:** Mike's agents run on several home machines, and he wants to use one dashboard
from any of them. On 2026-10-22 he said: "The other thing I really liked about t3 was that I
can install it on multiple computers in my home and they will sort of talk to each other via
this t3, and so I had really hoped to have that feature too."

**Decision and reasoning:** In the 2026-10-22 plan, a low-power always-on mini PC would act as
the hub and run no agents. It might also run a small voice-to-text agent (PLAN §2, §8; the voice
inbox is deferred to Stage 4). On 2026-11-13 two hubs started competing for the same port. Mike
rejected that: "I don't really want them fighting for the port ... we could just simplify and
say if one is already running it becomes the 'main' and the ones that come after are
'support' instances ... I don't think it needs to be complicated and fighting with itself."

**Result:** `studio join <link>` makes a machine a support machine. It runs only T3, is paired
into the main hub automatically, and `studio` there opens the main's dashboard
(commit `7847337`, [README](../README.md), `bin/studio.ts`). In practice the main is currently
Mike's laptop, not a mini PC.

### IDEA-010 — Shared memory as a markdown vault (Obsidian)

**Recorded:** 2026-11-15 · **Decided:** 2026-10-22 · **Status:** Adopted (vault shipped; tooling choice still a research spike)
**Relationship:** Mike's direction; pattern inspired by Karpathy's LLM Wiki and community tools

**Sources and contributors:** Mike (S1); [PLAN §7](PLAN.md) names Karpathy's LLM Wiki gist and the
tools compared. `AI-Harness/Inspiration/New Inspo/karpathy_graph_prompt.docx.md` is a later local
reference (2026-11-05); no transcript connects it to a decision.

**Decision and reasoning:** On 2026-10-22 Mike said "agent memory should be stored somewhere,
likely we will use another system that builds out markdown files for an obsidian vault". He
asked for research because "lots of people have developed solutions for it ... since
Karpathy did his autoresearch project". The vault keeps memory readable and versionable, and
the task board lives in it too (IDEA-014).

**Result:** Vault at `~/.config/studio/vault` ([PLAN §7](PLAN.md)). Sync is by git.

### IDEA-011 — Budgets are subscription windows, not token caps

**Recorded:** 2026-11-15 · **Decided:** 2026-10-22 · **Status:** Adopted
**Relationship:** Mike's clarification; relies on T3 behaviour

**Sources and contributors:** Mike (S1); T3 and OpenRig's handling of usage limits.

**Decision and reasoning:** Mike said budgets "are when subscriptions run out", which the
harnesses already report. T3 pauses an agent until the 5-hour limit resets and then resumes
automatically ("I think openrig does too"). Studio therefore builds on the providers' 5-hour
and weekly windows instead of counting tokens (PLAN §2).

**Result:** The plan usage meter, showing session and weekly allowance left, shipped
2026-11-14 (`/api/usage`, commit `2c99c24`). The 2026-11-14 idea "carry on with another
harness" builds on it (PLAN §11).

**Updates:** 2026-11-16: The meter showed stale numbers: it did not reset after a 5-hour
window ended, and Mike also saw it stuck on "updating" (where that text came from was not
established). Cause: T3 re-checks usage only during turns or when asked, and Studio never
asked. Mike decided that roughly 10-minute-old data is enough rather than real time. Usage
is now checked when a job finishes and on a 10-minute timer, and the newer reading is shown.
Mike asked for a refresh button. Claude added the remaining choices:

- the page never waits for a check;
- a window whose reset time has passed is shown as full ("≈") until the next check confirms it;
- each plan shows when it was last checked, and readings over an hour old are greyed out.

T3 caches Claude's reading for 5 minutes, so a refresh within that time returns the same number.
Code: `Hub.checkUsageIfDue` and `refreshUsage` in `apps/hub/src/hub.ts`, `POST /api/usage/refresh`,
`renderUsage` in `apps/web/app.js`.

### IDEA-012 — Producer: a cheap API model now, decision models later

**Recorded:** 2026-11-15 · **Decided:** 2026-10-22 · **Status:** Adopted (cheap model); decision models deferred
**Relationship:** Mike's proposal; external models as candidates

**Sources and contributors:** Mike (S1): he suggested Jev, then Microsoft-Decision-1
([link he gave](https://commandline.microsoft.com/microsoft-decision-1-model-foundry/)). He also
noted that NVIDIA and others have similar models, and that tools exist to turn local models
into decision models, "but I think these can be slow". Claude researched the alternatives
(PLAN §8a).

**Decision and reasoning:** The hub machine is weak, so the Producer that plans and assigns
work uses an inexpensive API model rather than a local one. Mike asked whether "a decision
making model like jev might be appropriate for assigning tasks". The plan adopted
deterministic scoring first and decision models as a measured later experiment. Since several
vendors offer such models, the choice is replaceable.

**Result:** A Producer that proposes cards shipped in Stage 1. The decision-model experiment
is Stage 4 ([PLAN §8a, §11](PLAN.md)).

### IDEA-013 — How an agent looks: hat = Role, shirt = harness and model, Kits on the desk

**Recorded:** 2026-11-15 · **Decided:** 2026-10-27, 3D on 2026-11-07 · **Status:** Adopted and shipped
**Relationship:** Mike's original design

**Sources and contributors:** Mike (S3, S5); Claude proposed "turning roles into kits" (S3);
the 3D version followed the Grok Bot example (IDEA-008).

**Decision and reasoning:** Mike's description on 2026-10-27:

- "a little guy represents an agent";
- its shirt carries the vendor logo and model name ("so an anthropic logo, then name of model
  on the shirt");
- the shirt colour shows the harness ("Claude code gets claude orange");
- "the hat will say what their role is, like 'lead programmer' or 'motion designer'";
- "kits are things that are equipped by agents, and roles are a broader thing that shows which
  kits they can load and use as needed". Kits appear as widgets on their desks.

On 2026-10-28 he asked for "little speech bubbles above their heads showing if they are
working, or idle or waiting etc, use emojis, just something simple". He had expected sprites
and accepted shapes for now, deferring sprites. On 2026-11-07 the office moved to 3D people.

**Result:** [PLAN §6 and §10](PLAN.md), `roles/`, `kits/`, `apps/web/office3d.js`. Logos come
from `AI-Harness/Icons`; Kenney CC0 art is credited in [CREDITS.md](../apps/web/assets/CREDITS.md).

### IDEA-014 — A task board kept in git, not a hosted Trello/Jira

**Recorded:** 2026-11-15 · **Decided:** 2026-10-28 · **Status:** Adopted and shipped
**Relationship:** Mike's direction; kanban as a general convention

**Sources and contributors:** Mike (S3).

**Decision and reasoning:** Mike said tasks need "something similar to a trello board or Jira
(ideally one we don't need to host maybe just a list and we push it and pull it from git?)" to
show who has which task. He also asked for "an agent that acts as product manager and assigns
tasks to departments". Hosted tools were rejected: "I don't want to just use trello or Jira".

**Result:** A kanban card per file in the vault (`board/cards/`, [PLAN §7](PLAN.md)), and a
Producer that proposes cards (Stage 1, 2026-10-28). From 2026-11-14 the Studio Manager owns the
board (IDEA-020).

### IDEA-015 — Guardrails by allowlist, and cross-checks on the other harness

**Recorded:** 2026-11-15 · **Decided:** 2026-10-28 and 2026-10-29 · **Status:** Adopted
**Relationship:** Mike's experience and decisions; Claude's proposals

**Sources and contributors:** Mike (S3, S4); Claude proposed the options, Mike chose.

**Problem:** Codex could not be run under Studio's guardrails as first built. Mike's experience
is that Codex is most valuable "for fixing coding bugs and getting a second opinion".

**Decision and reasoning:** Mike asked whether a blocklist could count as a guardrail as far as
Studio is concerned, and suggested Codex might help define it "since it knows itself well". He
accepted automatic cross-checks of finished work by the *other* harness. After test run 1 he
chose an allowlist of routine commands. He also noted that `approval_policy = "never"` with
`sandbox_mode = "workspace-write"` stops Codex's permission prompts. Full access limited to the
project folder was deferred: "it's harder to make sure nothing goes off the rails".

**Result:** The Guardrails Kit (`kits/guardrails/`) and automatic cross-checks
([PLAN §6](PLAN.md), [testrun-tetris.md](testrun-tetris.md)).

### IDEA-016 — Lessons from test run 1: keep the work flowing without babysitting

**Recorded:** 2026-11-15 · **Decided:** 2026-10-29 · **Status:** Partly adopted; rest planned
**Relationship:** Mike's decisions after the first real test; heartbeat idea inspired by OpenClaw and Hermes agents

**Sources and contributors:** Mike (S4); findings in [testrun-tetris.md](testrun-tetris.md).

**Decisions:** Studio built a browser Tetris (2026-10-29). Afterwards Mike decided:

- **Heartbeat project manager:** "openclaw and hermes agents both have a sort of heartbeat
  where they check on things after a timer". The manager would keep tasks flowing and show how
  they fit together. Mike called this incomplete; design it with him.
- **Send back with notes:** "a space for sending notes back with review", instead of
  rejecting the work and restarting.
- **No home-made browsers:** "I don't want them building a new browser, can't we just open
  it on the localhost?"
- **Git as step 0 for new projects:** set by a rule, not forced on every project.
- **Pull requests and merges** for integrating revisions.
- **Show what is being approved:** a prompt that says "no details available" is "a bit
  worrying".

**Result:** These are planned in [PLAN §11](PLAN.md), with test run 2 to exercise parallel work.
Which of them have shipped since is not recorded here.

### IDEA-017 — Reach Studio through Discord via Hermes; morning brief

**Recorded:** 2026-11-15 · **Decided:** 2026-11-07 · **Status:** Adopted (Discord bot setup pending on Mike's side)
**Relationship:** Mike's choice; Hermes Agent as a dependency

**Sources and contributors:** Mike (S5); Hermes Agent
(Nous Research). `AI-Harness/research.md`, written by Mike, compares Grok Bot, Hermes and Meta's
Muse.

**Decision and reasoning:** "I don't really want to install an app on my phone, t3 or
otherwise, I don't want text messages either. maybe a discord bot? I think we can use hermes
agent to do that?" Phone apps and SMS were rejected. Mike chose the scope "ask + approve":
notifications, read-only questions, and approving or denying pending requests. Starting,
accepting and integrating work from Discord is not allowed. A daily morning brief came out of
the same review of research.md.

**Result:** [docs/discord.md](discord.md), the hub's notifier and `/mcp` endpoint, and
`apps/hub/src/brief.ts`. "A Discord thread per job" is a next idea in PLAN §11.

### IDEA-018 — More harnesses and cost tiers

**Recorded:** 2026-11-15 · **Decided:** 2026-11-07 · **Status:** OpenCode shipped; others planned
**Relationship:** Mike's direction; T3 provider support as a dependency

**Sources and contributors:** Mike (S5).

**Decision and reasoning:** "I also use opencode so we should set that up too." OpenCode
became the third harness and uses free models. Mike noted that T3 already supports more harnesses
("things like pi, or deepseek's new harness"), so adding one should be easy. He also pointed out
OpenCode's new browser add-on as a later, optional Kit, "useful for scraping jobs or something".
Cheap models for routine Roles (cost tiers) came out of the same research.md review.

**Result:** OpenCode support in T3 settings and the Kit compiler (`packages/kits/src/compile.ts`).
Other harnesses, cost tiers and the browser Kit are in [PLAN §11 "Next ideas"](PLAN.md).

### IDEA-019 — The hardening ladder

**Recorded:** 2026-11-15 · **Decided:** 2026-11-07 · **Status:** Planned
**Relationship:** Mike's original idea, prompted by the research.md review

**Sources and contributors:** Mike (S5). Inference, not stated in the transcripts: research.md's
description of Hermes' self-improving skill memory may have prompted it. Mike's addition is
hardening skills further.

**Idea and reasoning:** "the first time we figure out the best way to do it, maybe refine it the
first couple of times we do it, that becomes a skill. If it becomes a skill we do often, look at
potential methods of hardening and choose the best one." The harder forms he listed were a
script, "symbolic AI rules", or a loop "using something akin to n8n". He also flagged the risk:
"This might be unnecessary and overengineering." The plan's version promotes work only on
evidence, keeps the lower rung as a fallback, and uses the hub's scheduler instead of n8n.

**Result:** [PLAN §11 "Next ideas"](PLAN.md). Not built.

### IDEA-020 — Studio Manager, hiring staff, restarting failures, plan meter

**Recorded:** 2026-11-15 · **Decided:** 2026-11-14 · **Status:** Shipped
**Relationship:** Unknown proposer

**Sources and contributors:** Commit `2c99c24` (2026-11-14, co-authored by Claude). No local
Claude Code or Codex transcript of that work was found, so who proposed each part and why is
unknown.

**What shipped:**

- Hiring staff (from a template, from scratch, or imported).
- A desk chat with a Studio Manager that runs Studio through its MCP tools, with the
  `studio-ops` Kit.
- Free staff get work before anyone new is hired.
- Every job gets a board card, and the Studio Manager owns the board.
- Restarting a failed agent in its own thread and worktree.
- "Open in T3" links and the plan usage meter (IDEA-011).
- A calmer office layout with a needs-attention box.

PLAN §11 also lists four "Ideas noted from use (2026-11-14)": carrying on with another harness,
a catalog of skills/MCP servers from GitHub, streaming the office with a host agent, and more
staff looks. Their origin is likewise unrecorded.

**Unknowns:** The proposer and reasoning for each part. Possible resemblances to the Grok Bot
example (IDEA-008: per-bot usage, a manager bot that runs the office) are unconfirmed.

### IDEA-021 — Borrow ideas, don't copy projects

**Recorded:** 2026-11-15 · **Decided:** 2026-10-27 · **Status:** Adopted (working principle)
**Relationship:** Mike's rule

**Sources and contributors:** Mike (S3), about Claude Code Game Studios: "good to pull ideas
from but not to just copy it blindly." The same view appears in IDEA-002 and IDEA-003.

**Decision:** Assess outside repos, templates and prompts as sources of ideas, then rewrite
what fits into Studio's own Roles/Kits format. Record the influence in this file. Direct
reuse, where it happens, is identified with its license.

**Result:** PLAN §2; Mike's art assets (Kenney packs, SFX, game design flashcards in
`AI-Harness/Assets`, which he says he holds rights to) are used under their own terms.

### IDEA-022 — Easy install, one `studio` command, public release

**Recorded:** 2026-11-15 · **Decided:** 2026-11-07 to 2026-11-13 · **Status:** Shipped
**Relationship:** Mike's requests; implementation by Claude

**Sources and contributors:** Mike (S5, S6).

**Decisions:**

- **Start at boot (2026-11-07):** start Studio and T3 at boot, "easy to turn off/on again later".
- **One command (2026-11-13):** an installer or makefile so Studio is easy to put on new machines,
  and "once installed just type studio in a terminal to load this up and its dependencies like
  t3 code underneath". Also a README explaining the features, the reasoning, and why Studio exists.
- **Windows (2026-11-13):** "can we make it support windows also? or at least let me load the
  visual webpage from another local computer".
- **Public release (2026-11-13):** scrub personal details, publish publicly as `studio`, MIT licence.

**Result:** `install.sh`, `install.ps1`, `Makefile`, `bin/studio.ts`, the access key for LAN use
(`apps/hub/src/access.ts`), and the [README](../README.md). Commits `b79615d`, `391bb83` and
`5e92f22`. The Windows install had not been tested on a real Windows machine as of 2026-11-13.

### IDEA-023 — This record, kept by every agent

**Recorded:** 2026-11-15 · **Status:** Adopted
**Relationship:** Mike's request

**Sources and contributors:** Mike. Codex created this file on 2026-11-15 (S7). Claude Code
reviewed the conversation history and set up agent instructions the same day (S8).

**Idea and reasoning:** Mike: "it would have been better to from the start but we will do so
going forward". The record also attributes ideas, "showing where ideas were sourced from, which
projects we were inspired by". Every future agent or harness working on the project should add
to it as features are added.

**Result:** [AGENTS.md](../AGENTS.md) holds the instructions. It is read natively by Codex,
OpenCode and other AGENTS.md-aware tools. [CLAUDE.md](../CLAUDE.md) imports it for Claude Code.
Studio's Kit compiler composes these project files with a Kit's instructions instead of
replacing them (`packages/kits/src/compile.ts`), so agents dispatched by Studio see them too.

## Conversation sources

These are local transcripts on Mike's laptop, under `~/.claude/projects/` (Claude Code) and
`~/.codex/sessions/` (Codex). The IDs are given so a later review can find them; they are not
public. Dates are local.

| Ref | Date | Harness, session | Topics |
|---|---|---|---|
| S1 | 2026-10-22 | Claude Code `576b7b16` | Original plan: tycoon frontend, T3 as base, OpenRig/Claw-Empire, loadouts, memory, budgets, multi-machine, star ratings, Producer and decision models |
| S2 | 2026-10-27 | Codex `01a18081` | Plan review and critique; plan updated |
| S3 | 2026-10-27/28 | Claude Code `1f6c7d2d` | Stage 0–2 build, Game Studios archive, agent look, Codex guardrails, cross-checks, task board, speech bubbles |
| S4 | 2026-10-29 | Claude Code `4a8f59cc` | Test run 1 (Tetris) and decisions from it |
| S5 | 2026-11-07 | Claude Code `157db104` | Grok Bot examples, 3D office, real state only, boot services, Discord/Hermes, OpenCode, research.md review, hardening ladder, morning brief |
| S6 | 2026-11-13 | Claude Code `9367ea0b` | Installer, `studio` command, README, Windows, public release, MIT, main/support |
| S7 | 2026-11-15 | Codex `01a1e32d` | Creation of this record |
| S8 | 2026-11-15 | Claude Code `17b76231` | History review; agent instructions |

Not found: a transcript for the 2026-11-14 work (IDEA-020). Codex sessions for other folders
and the T3 sandbox job transcripts were not reviewed for ideas.

## Gaps to fill as evidence or recollections surface

- Original dates and discussion records for the reconstructed decisions above.
- Canonical Claude Code Game Studios source and specific skill/role mappings.
- Confirmation that the Grok Bot X posts in `AI-Harness/Example` are the office reference
  (IDEA-008).
- Freelancer source/design records, if recoverable.
- Which OpenRig-inspired features were implemented, changed, deferred, or dropped.
- Who proposed the 2026-11-14 features and why (IDEA-020).
- What Codex's plan review on 2026-10-27 changed (S2).
- The games shown in `Art Inspo/city-game-studio.jpg` and `My-Leisure-Time*.jpg`.
- `AI-Harness/Inspiration/New Inspo/` holds about 100 downloaded repositories and documents
  (2026-11-05 to 2026-11-13). Mike saved them as possible future inspiration (2026-11-16) but
  did not record their GitHub addresses. Zip names alone are not reliable sources, so these
  will not be attributed from the download folder. Mike plans to look them up again and
  start a sourced list from scratch. No transcript shows any of them shaping a Studio decision.

The initial record used Mike's recollection and checked repository evidence. The history
review added what the transcripts above show. Other references in the plan or nearby
inspiration folders may have been considered; their presence alone does not prove they
contributed an adopted idea.

## Template for new entries

```markdown
### IDEA-NNN — Short name

**Recorded:** YYYY-MM-DD · **Status:** Proposed / Adopted / Rejected / Superseded
**Relationship:** Original contribution / Inspiration / Adaptation / Reuse / Dependency

**Sources and contributors:** Person/project, source links and revision where known.
State whether this is explicit recollection, documented evidence, or inference.

**Problem:** What prompted the idea?

**Decision and reasoning:** What did we choose, and why? What alternatives mattered?

**Tradeoffs:** Costs, constraints, and conditions for revisiting the choice.

**Result:** Links to the design, files, commit, or PR. Distinguish planned from shipped.
For reused material, identify the original files and applicable notices.

**Unknowns:** Attribution or reasoning still to recover, if any.

**Updates:** Dated changes; reference a successor entry if superseded.
```
