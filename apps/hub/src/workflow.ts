// The work loop around Jobs (PLAN.md §8 and §11, Stage 1): job notes in the vault and the memory
// brief built from them, the task board, the Producer's plans, accept/reject, serial integration,
// and ratings. The Hub owns execution; this owns what the results mean.

import type { Provider, RoleManifest } from "@studio/kits";
import { Board, type Card, type Column } from "./board.ts";
import { TERMINAL_STATES, type Attempt, type Job } from "./db.ts";
import { parseCards, type Handoff } from "./handoff.ts";
import { HARNESSES, INSTANCE, type Hub } from "./hub.ts";
import { slug, type Vault } from "./vault.ts";

const MAX_NOTES_IN_BRIEF = 6;
const MAX_FEEDBACK_LINES = 8;
/** Roles the Producer may assign cards to; the others support the loop rather than doing cards. */
const NOT_ASSIGNABLE = new Set(["critic", "integrator", "producer"]);

export interface RatingInput {
  category: string;
  stars: number;
  note?: string;
}

export class Workflow {
  readonly board: Board;
  private readonly hub: Hub;
  private readonly vault: Vault;

  constructor(hub: Hub, vault: Vault) {
    this.hub = hub;
    this.vault = vault;
    this.board = new Board(vault);
  }

  private job(id: string): Job {
    const job = this.hub.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
    if (!job) throw new Error(`no job ${id}`);
    return job;
  }

  private latestAttempt(jobId: string): Attempt | undefined {
    return this.hub.db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId) as
      | Attempt
      | undefined;
  }

  private projectDir(worker: string, project: string) {
    return `projects/${slug(`${worker}-${project}`)}`;
  }

  // ---------------------------------------------------------------- memory

  /**
   * What the studio already knows, for an agent's instructions: recent job notes for the project
   * and your rating feedback for the role. Only immutable notes are read; the compiler bounds size.
   */
  async memoryBrief(worker: string, project: string, role: RoleManifest): Promise<string> {
    const dir = `${this.projectDir(worker, project)}/inbox`;
    const files = (await this.vault.list(dir)).slice(-MAX_NOTES_IN_BRIEF).reverse();
    const notes: string[] = [];
    for (const f of files) {
      const text = (await this.vault.read(`${dir}/${f}`)) ?? "";
      notes.push(text.split("\n").filter(Boolean).slice(0, 4).join("\n"));
    }
    const feedback = ((await this.vault.read(`roles/${role.name}/feedback.md`)) ?? "")
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .slice(-MAX_FEEDBACK_LINES);
    const parts: string[] = [];
    if (notes.length) parts.push("Recent jobs in this project, newest first:", "", notes.join("\n\n"));
    if (feedback.length) parts.push("", `Feedback the user gave on earlier ${role.title} work:`, ...feedback);
    return parts.join("\n").trim();
  }

  /** Called once per finished Attempt, after its handoff was read. */
  async onResult(a: Attempt, job: Job, handoff: Handoff | undefined, finalMessage: string): Promise<void> {
    await this.recordJob(a, job, handoff, finalMessage);
    if (job.kind === "planning") await this.proposeCards(a, job, finalMessage);
    if (job.kind === "integration") this.finishIntegration(a, job, handoff);
  }

  private async recordJob(a: Attempt, job: Job, handoff: Handoff | undefined, finalMessage: string) {
    const harness = HARNESSES[a.provider as Provider]?.label ?? a.provider;
    const result = [
      handoff?.status ?? "no handoff",
      handoff?.commit ? `commit ${handoff.commit.slice(0, 10)}` : null,
      handoff?.verdict ? `verdict ${handoff.verdict}` : null,
      handoff?.outcome ? `outcome ${handoff.outcome}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const when = new Date().toISOString();
    const raw = [
      `# ${job.title}`,
      "",
      `- Job: ${job.id} (${job.kind}) · Attempt: ${a.id}`,
      `- Project: ${a.worker}/${job.project}`,
      `- Role: ${a.role} · Kits: ${a.kits ? (JSON.parse(a.kits) as string[]).join(", ") : "none"} · ${harness} ${a.model ?? ""} · loadout ${a.snapshot ?? "?"}`,
      `- Result: ${result}`,
      "",
      "## Brief",
      "",
      job.brief,
      "",
      "## Final message",
      "",
      finalMessage,
      "",
    ].join("\n");
    // Records are immutable: one per Attempt, never rewritten.
    if (!(await this.vault.write(`raw/jobs/${slug(a.id)}.md`, raw, { overwrite: false }))) return;
    const note = [
      `# ${job.title}`,
      `- ${when.slice(0, 10)} · ${a.role} on ${harness} (${a.model ?? "default model"}) · ${job.kind}`,
      `- Result: ${result}`,
      handoff?.notes ? `- Notes: ${handoff.notes}` : null,
      `- Record: raw/jobs/${slug(a.id)}.md`,
    ]
      .filter(Boolean)
      .join("\n");
    await this.vault.write(`${this.projectDir(a.worker, job.project)}/inbox/${when.replace(/[:.]/g, "-")}-${slug(a.id)}.md`, note + "\n", {
      overwrite: false,
    });
  }

  // ---------------------------------------------------------------- board

  async linkCard(cardId: string, jobId: string) {
    const card = await this.board.get(cardId);
    await this.board.update(cardId, { jobs: [...card.jobs, jobId], column: "doing" });
  }

  async createCard(input: { project: string; title: string; role: string; priority?: Card["priority"]; body?: string; column?: Column }) {
    if (!input.project.includes("/")) throw new Error("project must be <worker>/<projectId>");
    return this.board.create({
      title: input.title,
      project: input.project,
      role: input.role,
      priority: input.priority ?? "normal",
      column: input.column ?? "backlog",
      createdBy: "you",
      body: input.body ?? "",
    });
  }

  async updateCard(id: string, patch: Partial<Pick<Card, "title" | "role" | "priority" | "body" | "column">>) {
    return this.board.update(id, patch);
  }

  async discardCard(id: string) {
    await this.board.get(id);
    await this.vault.remove(`board/cards/${id}.md`);
  }

  /** Start a Job from a card: its Role, the Role's default Kits and runtime unless overridden. */
  async startCard(id: string, opts: { provider?: Provider; kits?: string[]; autoReview?: boolean } = {}) {
    const card = await this.board.get(id);
    if (!card.role) throw new Error("assign the card to a role first");
    const [worker, ...rest] = card.project.split("/");
    const project = rest.join("/");
    const role = (await this.hub.catalog()).roles.find((r) => r.name === card.role);
    if (!role) throw new Error(`unknown role ${card.role}`);
    return this.hub.startJob({
      worker: worker!,
      project,
      title: card.title,
      brief: `${card.title}\n\n${card.body}`.trim(),
      role: card.role,
      provider: opts.provider ?? (role.preferred as Provider),
      ...(opts.kits ? { kits: opts.kits } : {}),
      ...(opts.autoReview === false ? { autoReview: false } : {}),
      card: id,
    });
  }

  /** Keep each card's column in step with its latest work Job. Cards without jobs are yours to move. */
  private async syncBoard() {
    for (const card of await this.board.list()) {
      const jobId = card.jobs.at(-1);
      if (!jobId) continue;
      let job: Job;
      try {
        job = this.job(jobId);
      } catch {
        continue;
      }
      const a = this.latestAttempt(jobId);
      let column: Column = card.column;
      if (job.milestone === "integrated") column = "done";
      else if (job.milestone === "rejected") column = "ready";
      else if (a?.state === "result_available") column = "review";
      else if (a?.state === "failed" || a?.state === "stopped") column = "blocked";
      else if (a) column = "doing";
      if (column !== card.column) await this.board.update(card.id, { column });
    }
  }

  // ---------------------------------------------------------------- planning

  /** Ask a Producer to turn a goal into proposed cards for one project. */
  async plan(input: { worker: string; project: string; goal: string; provider?: Provider }) {
    const { roles } = await this.hub.catalog();
    const roster = roles
      .filter((r) => !NOT_ASSIGNABLE.has(r.name))
      .map((r) => `- \`${r.name}\` — ${r.title} (${r.department}): ${r.description}`)
      .join("\n");
    const brief = [
      "Plan this goal as task cards for the studio board:",
      "",
      input.goal,
      "",
      "Roles you can assign cards to:",
      roster,
      "",
      "Acceptance criteria:",
      "- One `cards` block with 3–8 cards, each assigned to a role from the roster",
      "- Every card has acceptance criteria someone else can check",
      "- Assumptions are stated; open questions are listed in the handoff",
    ].join("\n");
    return this.hub.startJob({
      worker: input.worker,
      project: input.project,
      title: `Plan: ${input.goal.split("\n")[0]!.slice(0, 80)}`,
      brief,
      role: "producer",
      provider: input.provider ?? "claude",
      kind: "planning",
      autoReview: false,
    });
  }

  private async proposeCards(a: Attempt, job: Job, finalMessage: string) {
    const known = new Set((await this.hub.catalog()).roles.map((r) => r.name));
    const proposed = parseCards(finalMessage);
    if (proposed.length === 0) {
      this.hub.note(a, "the Producer's final message had no cards block");
      return;
    }
    for (const c of proposed) {
      const deps = c.dependsOn.length ? `\n\nDepends on: ${c.dependsOn.join("; ")}` : "";
      await this.board.create({
        title: c.title,
        project: `${a.worker}/${job.project}`,
        role: known.has(c.role) && !NOT_ASSIGNABLE.has(c.role) ? c.role : "",
        priority: c.priority,
        column: "proposed",
        createdBy: `producer (${job.id})`,
        body: `${c.description}${deps}${known.has(c.role) ? "" : `\n\n(The Producer suggested role "${c.role}", which does not exist.)`}`,
      });
    }
    this.hub.note(a, `proposed ${proposed.length} cards for your approval`);
  }

  // ---------------------------------------------------------------- review milestones

  accept(jobId: string) {
    const job = this.job(jobId);
    const a = this.latestAttempt(jobId);
    if (job.kind !== "work") throw new Error("only work jobs are accepted");
    if (a?.state !== "result_available") throw new Error("the job has no result to accept yet");
    this.hub.db.prepare("UPDATE jobs SET milestone = 'accepted' WHERE id = ?").run(jobId);
    this.hub.note(a, "you accepted the result");
  }

  reject(jobId: string, note?: string) {
    const job = this.job(jobId);
    const a = this.latestAttempt(jobId);
    if (job.kind !== "work") throw new Error("only work jobs are rejected");
    if (job.milestone === "integrated") throw new Error("the job is already integrated");
    this.hub.db.prepare("UPDATE jobs SET milestone = 'rejected' WHERE id = ?").run(jobId);
    if (a) this.hub.note(a, `you rejected the result${note ? `: ${note}` : ""}`);
  }

  // ---------------------------------------------------------------- integration

  /**
   * Merge an accepted Job's branch into the project's main branch, one integration per project at a
   * time. The merge runs in the project's own checkout, which must be clean and on the base branch.
   */
  async integrate(jobId: string, opts: { provider?: Provider; base?: string } = {}) {
    const job = this.job(jobId);
    if (job.milestone !== "accepted") throw new Error("accept the result before integrating it");
    const a = this.latestAttempt(jobId);
    if (!a || a.state !== "result_available" || !a.thread_id) throw new Error("the job has no result to integrate");
    if (!a.result_commit) throw new Error("the agent did not report a commit, so there is nothing exact to integrate");

    const busy = this.hub.db
      .prepare(
        `SELECT 1 FROM jobs j JOIN attempts x ON x.job_id = j.id
         WHERE j.kind = 'integration' AND j.project = ? AND x.state NOT IN ('stopped', 'failed', 'result_available')`,
      )
      .get(job.project);
    if (busy) throw new Error("another integration is running in this project; integrations run one at a time");

    const t3 = this.hub.t3(a.worker);
    if (!t3.rpc) throw new Error(`worker ${a.worker} was paired without RPC access`);
    const { thread } = await this.hub.readThread(a);
    if (!thread.branch || !thread.worktreePath) throw new Error("the job's thread has no branch");
    const branchStatus = await t3.rpc.call<{ branchChanges?: { baseRef?: string } }>("vcs.refreshStatus", { cwd: thread.worktreePath });
    // A revision starts from the previous attempt's branch; its target is still the project's branch.
    const base = opts.base ?? branchStatus.branchChanges?.baseRef;
    if (!base) throw new Error("could not tell which branch the job started from");

    const root = (await t3.call<{ projects: Array<{ id: string; workspaceRoot: string }> }>("t3_project_list")).projects.find(
      (p) => p.id === job.project,
    )?.workspaceRoot;
    if (!root) throw new Error("project not found on the worker");
    const rootStatus = await t3.rpc.call<{ refName?: string; hasWorkingTreeChanges?: boolean }>("vcs.refreshStatus", { cwd: root });
    if (rootStatus.hasWorkingTreeChanges) throw new Error(`${root} has uncommitted changes; commit or stash them first`);
    if (rootStatus.refName !== base) throw new Error(`${root} is on ${rootStatus.refName ?? "?"}, not ${base}; switch it to ${base} first`);

    const provider: Provider =
      opts.provider ?? (this.hub.workers.get(a.worker)?.models[INSTANCE.claude] ? "claude" : "codex");
    const brief = [
      `Integrate the reviewed branch \`${thread.branch}\` (commit ${a.result_commit}) into \`${base}\` for the job "${job.title}".`,
      "You are in the project's own checkout. Follow these steps exactly and stop at the first problem.",
      "Do not edit files, resolve conflicts, push, or run any other command that changes git history.",
      "",
      "1. `git status --porcelain` must print nothing, and `git rev-parse --abbrev-ref HEAD` must print " +
        `\`${base}\`. Otherwise stop with Outcome: NOT CLEAN.`,
      `2. \`git merge --no-ff --no-commit ${thread.branch}\`. If it reports conflicts, run \`git merge --abort\` ` +
        "and stop with Outcome: CONFLICT, listing the conflicting files.",
      `3. \`git rev-parse MERGE_HEAD\` must start with ${a.result_commit.slice(0, 7)}. Otherwise run \`git merge --abort\` ` +
        "and stop with Outcome: NOT CLEAN.",
      "4. Run the project's tests and checks. If any fail, run `git merge --abort` and stop with Outcome: TESTS FAILED, " +
        "quoting the failures. If the project has no tests, say so and continue.",
      `5. \`git commit -m "Merge ${thread.branch}: ${job.title.replace(/"/g, "'")}"\`, then \`git rev-parse HEAD\`.`,
      "",
      "End your final message with exactly this block, filled in (Studio reads it):",
      "",
      "```",
      "## Handoff",
      "Status: done | blocked",
      "Commit: <full sha of the merge commit, or none>",
      "Outcome: MERGED | CONFLICT | TESTS FAILED | NOT CLEAN",
      "Acceptance:",
      "- [x] or [ ] <criterion> — <evidence>",
      "Checks run:",
      "- `<command>` → <result>",
      "Notes for the reviewer: <one line>",
      "```",
      "",
      "Acceptance criteria:",
      "- Either the branch is merged and the tests pass on the merged result, or the checkout is exactly as it was",
      "- The Outcome line states which",
    ].join("\n");
    return this.hub.startJob({
      worker: a.worker,
      project: job.project,
      title: `Integrate: ${job.title}`,
      brief,
      role: "integrator",
      provider,
      kind: "integration",
      targetJob: jobId,
      workspace: "root",
      autoReview: false,
    });
  }

  private finishIntegration(a: Attempt, job: Job, handoff: Handoff | undefined) {
    if (!job.target_job) return;
    const target = this.latestAttempt(job.target_job);
    if (handoff?.outcome === "MERGED" && handoff.commit) {
      this.hub.db
        .prepare("UPDATE jobs SET milestone = 'integrated', integrated_commit = ? WHERE id = ?")
        .run(handoff.commit, job.target_job);
      if (target) this.hub.note(target, `integrated as ${handoff.commit.slice(0, 10)}`);
    } else if (target) {
      this.hub.note(target, `integration did not merge: ${handoff?.outcome ?? "no outcome reported"}`);
    }
  }

  // ---------------------------------------------------------------- ratings

  /** Rate a finished Attempt 1–5 per category. Notes become feedback in the role's vault page. */
  async rate(attemptId: string, ratings: RatingInput[]) {
    const a = this.hub.dispatcher.get(attemptId);
    if (!TERMINAL_STATES.has(a.state)) throw new Error("rate a job once it has finished");
    const job = this.job(a.job_id);
    for (const r of ratings) {
      if (!Number.isInteger(r.stars) || r.stars < 1 || r.stars > 5) throw new Error("stars must be 1 to 5");
      this.hub.db
        .prepare("INSERT OR REPLACE INTO ratings (attempt_id, category, stars, note, at) VALUES (?, ?, ?, ?, ?)")
        .run(attemptId, r.category, r.stars, r.note ?? null, Date.now());
      if (r.note && a.role) {
        await this.vault.append(
          `roles/${a.role}/feedback.md`,
          `- ${new Date().toISOString().slice(0, 10)} · ${r.category} ${"★".repeat(r.stars)} · "${job.title}": ${r.note}\n`,
        );
      }
    }
  }

  /** Ratings given so far, by attempt, for the UI. */
  ratedAttempts(): Record<string, Array<{ category: string; stars: number; note: string | null }>> {
    const out: Record<string, Array<{ category: string; stars: number; note: string | null }>> = {};
    for (const r of this.hub.db.prepare("SELECT attempt_id, category, stars, note FROM ratings").all() as Array<{
      attempt_id: string;
      category: string;
      stars: number;
      note: string | null;
    }>) {
      (out[r.attempt_id] ??= []).push({ category: r.category, stars: r.stars, note: r.note });
    }
    return out;
  }

  /**
   * Average stars per category for each setup (harness + model, and harness + model + role), as a
   * weighted average pulled towards the category mean so one 5★ job does not top the board (§10a).
   */
  leaderboard() {
    const rows = this.hub.db
      .prepare(
        `SELECT r.category, r.stars, a.provider, a.model, a.role
         FROM ratings r JOIN attempts a ON a.id = r.attempt_id`,
      )
      .all() as Array<{ category: string; stars: number; provider: string; model: string | null; role: string | null }>;
    const PRIOR_WEIGHT = 3;
    const byCategory = new Map<string, typeof rows>();
    for (const r of rows) byCategory.set(r.category, [...(byCategory.get(r.category) ?? []), r]);
    return [...byCategory].map(([category, rs]) => {
      const mean = rs.reduce((s, r) => s + r.stars, 0) / rs.length;
      const group = (key: (r: (typeof rs)[number]) => string) => {
        const groups = new Map<string, number[]>();
        for (const r of rs) groups.set(key(r), [...(groups.get(key(r)) ?? []), r.stars]);
        return [...groups]
          .map(([setup, stars]) => ({
            setup,
            count: stars.length,
            average: (stars.reduce((s, x) => s + x, 0) + PRIOR_WEIGHT * mean) / (stars.length + PRIOR_WEIGHT),
          }))
          .sort((x, y) => y.average - x.average);
      };
      return {
        category,
        byModel: group((r) => `${HARNESSES[r.provider as Provider]?.label ?? r.provider} · ${r.model ?? "default"}`),
        bySetup: group((r) => `${r.role} · ${HARNESSES[r.provider as Provider]?.label ?? r.provider} · ${r.model ?? "default"}`),
      };
    });
  }

  // ---------------------------------------------------------------- tick

  async tick() {
    await this.syncBoard();
    await this.vault.commit();
  }
}
