// The hub: owns Jobs/Attempts, talks to each worker's T3, and keeps Attempts reconciled.
// Studio clients use this, never T3 directly (PLAN.md §8).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  applyOverlay,
  compileLoadout,
  loadKit,
  loadLoadout,
  loadRole,
  removeOverlay,
  scanWorktree,
  type Provider,
} from "@studio/kits";
import { buildScene } from "@studio/sim";
import { STUDIO_HOME, T3Worker, readWorker } from "@studio/t3-bridge";
import { TERMINAL_STATES, type Attempt, type Job, type JobKind } from "./db.ts";
import { Dispatcher, type LaunchSetup, type WorkerPort } from "./dispatch.ts";
import { BriefLog, briefDue, composeBrief, dayKey, type LogRow } from "./brief.ts";
import { parseHandoff, sameCommit } from "./handoff.ts";
import { Notifier, type AttemptView, type NotifyConfig } from "./notify.ts";
import { deliverKitRemote } from "./remoteKit.ts";
import { t3WorkerPort } from "./t3Worker.ts";
import type { Vault } from "./vault.ts";
import { Workflow } from "./workflow.ts";

/** Studio runtime name → T3 provider instance id. */
export const INSTANCE: Record<Provider, string> = { claude: "claudeAgent", codex: "codex", opencode: "opencode" };

/**
 * How each harness appears in the studio: the shirt colour, and the vendor whose logo and model
 * name are printed on it (PLAN.md §10).
 */
export const HARNESSES: Record<Provider, { label: string; vendor: string; color: string }> = {
  claude: { label: "Claude Code", vendor: "Anthropic", color: "#D97757" },
  codex: { label: "Codex", vendor: "OpenAI", color: "#10A37F" },
  // OpenCode's own brand is black and white; violet keeps its shirts apart from the other two.
  opencode: { label: "OpenCode", vendor: "OpenCode", color: "#6E56CF" },
};

export interface WorkerConn {
  name: string;
  url: string;
  /** Hub and worker share a filesystem, so the Kit overlay can be applied directly. */
  local: boolean;
  t3?: T3Worker;
  error?: string;
  models: Record<string, string[]>;
}

export class Hub {
  readonly db: DatabaseSync;
  readonly dispatcher: Dispatcher;
  readonly workflow: Workflow;
  readonly rolesDir: string;
  readonly kitsDir: string;
  readonly workers = new Map<string, WorkerConn>();
  /** Latest visible activity per running Attempt, refreshed each tick (for the studio view). */
  private readonly activity: Record<string, { kind: string; title: string | null }> = {};
  /** Desk assignments from the previous scene, so agents keep their desks. */
  private seats: Record<string, number> = {};
  private readonly ports: Record<string, WorkerPort> = {};
  readonly notifier: Notifier;
  private readonly briefs: BriefLog;
  /** Machine liveness for notifications, checked every 30 s (the page checks its own on each poll). */
  private liveness: { at: number; workers: Array<{ name: string; online: boolean }> } = { at: 0, workers: [] };

  constructor(db: DatabaseSync, dirs: { roles: string; kits: string }, vault: Vault, notify: NotifyConfig | null = null) {
    this.db = db;
    this.rolesDir = dirs.roles;
    this.kitsDir = dirs.kits;
    this.dispatcher = new Dispatcher(db, { workers: this.ports });
    this.workflow = new Workflow(this, vault);
    this.notifier = new Notifier(db, notify);
    this.briefs = new BriefLog(db);
  }

  /** Connect every worker the hub has credentials for. A worker that fails stays listed as offline. */
  async loadWorkers(): Promise<void> {
    const files = await readdir(join(STUDIO_HOME, "workers")).catch(() => [] as string[]);
    for (const f of files.filter((f) => f.endsWith(".json"))) await this.connect(f.slice(0, -5));
  }

  async pairWorker(name: string, url: string, code: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("worker name must be kebab-case");
    // Accept the worker's plain address (what `t3 serve` prints) as well as its /mcp URL.
    const mcpUrl = new URL(/^https?:\/\//.test(url.trim()) ? url.trim() : `http://${url.trim()}`);
    if (!mcpUrl.pathname.endsWith("/mcp")) mcpUrl.pathname = `${mcpUrl.pathname.replace(/\/$/, "")}/mcp`;
    await (await T3Worker.pair(name, mcpUrl.href, code)).close();
    await this.connect(name);
  }

  private async connect(name: string): Promise<WorkerConn> {
    const { url } = await readWorker(name);
    const host = new URL(url).hostname;
    const conn: WorkerConn = { name, url, local: host === "127.0.0.1" || host === "localhost", models: {} };
    this.workers.set(name, conn);
    try {
      conn.t3 = await T3Worker.connect(name);
      const caps = await conn.t3.call<{ providers: Array<{ providerInstanceId: string; models: Array<{ id: string } | string> }> }>(
        "orchestrator_capabilities",
      );
      for (const p of caps.providers) conn.models[p.providerInstanceId] = p.models.map((m) => (typeof m === "string" ? m : m.id));
      this.ports[name] = t3WorkerPort(conn.t3);
    } catch (e) {
      conn.error = (e as Error).message;
    }
    return conn;
  }

  t3(name: string): T3Worker {
    const conn = this.workers.get(name);
    if (!conn?.t3) throw new Error(`worker ${name} is offline${conn?.error ? `: ${conn.error}` : ""}`);
    return conn.t3;
  }

  private async subdirs(dir: string): Promise<string[]> {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  }

  /** Roles and Kits as the UI shows them: hats, and the widgets that go on desks. */
  async catalog() {
    const roles = await Promise.all((await this.subdirs(this.rolesDir)).map((n) => loadRole(join(this.rolesDir, n))));
    const kits = await Promise.all((await this.subdirs(this.kitsDir)).map((n) => loadKit(join(this.kitsDir, n))));
    return {
      roles: roles.map(({ manifest: r }) => ({
        name: r.name,
        title: r.title,
        department: r.department,
        categories: r.game.categories,
        description: r.description,
        preferred: r.runtime.preferred,
        runtimes: [r.runtime.preferred, ...r.runtime.fallback],
        model: r.model.default ?? null,
        kits: r.kits,
      })),
      kits: kits.map(({ manifest: k }) => ({
        name: k.name,
        title: k.title,
        description: k.description,
        widget: k.game.widget,
        skills: k.skills,
      })),
      harnesses: HARNESSES,
    };
  }

  async state() {
    const workers = await Promise.all(
      [...this.workers.values()].map(async (w) => {
        if (!w.t3) await this.connect(w.name); // retry workers that were down
        const conn = this.workers.get(w.name)!;
        let projects: Array<{ id: string; title: string; workspaceRoot: string }> = [];
        let error = conn.error ?? null;
        if (conn.t3) {
          // The project list doubles as the liveness check: a worker is online if it answers.
          try {
            projects = (await conn.t3.call<{ projects: typeof projects }>("t3_project_list")).projects;
          } catch (e) {
            error = (e as Error).message;
          }
        }
        return {
          name: conn.name,
          url: conn.url,
          local: conn.local,
          online: conn.t3 !== undefined && error === null,
          error,
          providers: Object.entries(conn.models)
            .filter(([id]) => Object.values(INSTANCE).includes(id))
            .map(([id, models]) => ({ id, models })),
          projects,
        };
      }),
    );
    const jobs = this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    const attempts = this.db.prepare("SELECT * FROM attempts ORDER BY created_at").all() as unknown as Attempt[];
    const catalog = await this.catalog();
    const jobsWithAttempts = jobs.map((j) => ({ ...j, attempts: attempts.filter((a) => a.job_id === j.id) }));
    const cards = await this.workflow.board.list();
    const scene = buildScene(
      {
        now: Date.now(),
        workers,
        roles: catalog.roles,
        kits: catalog.kits,
        harnesses: catalog.harnesses,
        jobs: jobsWithAttempts as never,
        cards,
        activity: this.activity,
      },
      this.seats,
    );
    this.seats = scene.seats;
    return {
      workers,
      ...catalog,
      jobs: jobsWithAttempts,
      cards,
      ratings: this.workflow.ratedAttempts(),
      scene,
    };
  }

  async createProject(worker: string, title: string, workspaceRoot?: string) {
    return this.t3(worker).call("t3_project_create", {
      title,
      ...(workspaceRoot ? { workspaceRoot, createWorkspaceRootIfMissing: true } : {}),
    });
  }

  /** What a loadout would do on a runtime: the compiler's capability report, before any job exists. */
  async preview(input: { role: string; kits?: string[]; provider: Provider }) {
    const loadout = await loadLoadout({
      rolesDir: this.rolesDir,
      kitsDir: this.kitsDir,
      role: input.role,
      ...(input.kits ? { kits: input.kits } : {}),
    });
    const result = compileLoadout({ loadout, provider: input.provider, existing: () => undefined });
    return { launchable: result.launchable, runtimeMode: result.runtimeMode, report: result.report };
  }

  /** Create a Job and its first Attempt, and launch it in the background. */
  async startJob(input: {
    worker: string;
    project: string;
    title: string;
    brief: string;
    role: string;
    /** Kits to equip; omitted means the role's defaults. */
    kits?: string[];
    provider: Provider;
    /** Branch or commit the Attempt's worktree starts from; the project's HEAD when omitted. */
    baseRef?: string;
    /** Makes this Job a cross-check of that Attempt. */
    reviewsAttempt?: string;
    /** Whether to cross-check this Job's result automatically (default true). */
    autoReview?: boolean;
    kind?: JobKind;
    /** Integration jobs: the work Job being integrated. */
    targetJob?: string;
    /** "root" runs in the project's own checkout, with no Kit files written there. */
    workspace?: "worktree" | "root";
    /** The board card this Job works on. */
    card?: string;
  }) {
    const loadout = await loadLoadout({
      rolesDir: this.rolesDir,
      kitsDir: this.kitsDir,
      role: input.role,
      ...(input.kits ? { kits: input.kits } : {}),
    });
    const conn = this.workers.get(input.worker);
    if (!conn?.t3) throw new Error(`worker ${input.worker} is offline`);
    const t3 = conn.t3;
    if (!conn.local && !t3.rpc) throw new Error(`worker ${input.worker} was paired without RPC access; pair it again`);
    const projects = (await t3.call<{ projects: Array<{ id: string }> }>("t3_project_list")).projects;
    if (!projects.some((p) => p.id === input.project)) throw new Error(`project ${input.project} not found on ${input.worker}`);

    // Check the loadout can be enforced on this runtime before anything is created.
    const dry = compileLoadout({ loadout, provider: input.provider, existing: () => undefined });
    if (!dry.launchable) {
      const why = dry.report.filter((r) => r.status === "unsupported").map((r) => r.reason);
      throw new Error(`${loadout.role.manifest.title} cannot run on ${input.provider}: ${why.join("; ")}`);
    }

    const instanceId = INSTANCE[input.provider];
    const model = dry.model ?? conn.models[instanceId]?.[0] ?? null;
    const memoryBrief = input.workspace === "root" ? "" : await this.workflow.memoryBrief(input.worker, input.project, loadout.role.manifest);
    const jobId = this.dispatcher.createJob({
      project: input.project,
      title: input.title,
      brief: input.brief,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.reviewsAttempt ? { reviewsAttempt: input.reviewsAttempt } : {}),
      ...(input.targetJob ? { targetJob: input.targetJob } : {}),
      ...(input.autoReview === false ? { autoReview: false } : {}),
    });
    if (input.card) await this.workflow.linkCard(input.card, jobId);
    const attemptId = this.dispatcher.createAttempt(jobId, input.worker, {
      role: loadout.role.manifest.name,
      kits: loadout.kits.map((k) => k.manifest.name),
      provider: input.provider,
      model,
      snapshot: loadout.snapshot,
    });

    const setup: LaunchSetup = {
      instanceId,
      ...(model ? { model } : {}),
      runtimeMode: dry.runtimeMode,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.workspace === "root"
        ? // The project's own checkout gets no Kit files; the role's rules travel in the brief.
          { workspace: "root" as const }
        : {
            prepare: async (worktree: string) => {
              if (conn.local) {
                // Compile against the real worktree so tracked project files are respected.
                const result = compileLoadout({
                  loadout,
                  provider: input.provider,
                  existing: await scanWorktree(worktree),
                  memoryBrief,
                });
                await applyOverlay(worktree, result, loadout.snapshot);
              } else {
                await deliverKitRemote({ rpc: t3.rpc!, worktree, loadout, provider: input.provider, memoryBrief });
              }
              this.db.prepare("UPDATE attempts SET worktree_path = ? WHERE id = ?").run(worktree, attemptId);
            },
          }),
    };
    void this.dispatcher.launch(attemptId, setup);
    return { jobId, attemptId };
  }

  async cancel(attemptId: string) {
    return this.dispatcher.cancel(attemptId);
  }

  /** Attempt detail for the UI: state history, the thread's recent activity, and open requests. */
  async attempt(attemptId: string) {
    const a = this.dispatcher.get(attemptId);
    let messages: Array<{ type: string; text: string | null; title: string | null; status: string; by: string | null; at: string }> = [];
    let requests: Array<{ id: string; kind: string; summary: string }> = [];
    if (a.thread_id && this.workers.get(a.worker)?.t3) {
      const read = await this.t3(a.worker)
        .call<{ items: Array<{ type: string; text: string | null; title: string | null; status: string; createdBy: string | null; updatedAt: string }> }>(
          "t3_thread_read",
          { threadId: a.thread_id, view: "activity", limit: 50, maxCharsPerItem: 4_000 },
        )
        .catch(() => ({ items: [] }));
      messages = read.items.map((i) => ({ type: i.type, text: i.text, title: i.title, status: i.status, by: i.createdBy, at: i.updatedAt }));
      if (a.state === "awaiting_input") requests = await this.openRequests(a, messages);
    }
    return { attempt: a, history: this.dispatcher.history(attemptId), messages, requests };
  }

  /** Approvals and questions the agent is blocked on. Read over RPC: MCP does not list approvals. */
  private async openRequests(a: Attempt, items: Array<{ type: string; text: string | null; title: string | null; status: string }>) {
    const rpc = this.t3(a.worker).rpc;
    if (!rpc) return [];
    const snap = await rpc
      .get<{ projection: { runtimeRequests: RuntimeRequest[]; turnItems: TurnItem[] } }>(
        `/api/orchestration/threads/${encodeURIComponent(a.thread_id!)}`,
      )
      .catch(() => undefined);
    // The request itself carries no description. The tool call it gates shares its native id and
    // holds the command, or the file it reads or writes; the timeline's waiting items are a fallback.
    const waiting = items.filter((i) => i.status === "waiting" || i.status === "running");
    const fallback = waiting.map((i) => [i.title, i.text].filter(Boolean).join(": ")).filter(Boolean).join("\n");
    const toolCalls = new Map(
      (snap?.projection.turnItems ?? [])
        .filter((t) => t.id.startsWith("turn-item:provider:") && t.nativeItemRef?.nativeId)
        .map((t) => [t.nativeItemRef!.nativeId, t]),
    );
    return (snap?.projection.runtimeRequests ?? [])
      .filter((r) => r.status === "pending")
      .map((r) => {
        const call = r.nativeRequestRef?.nativeId ? toolCalls.get(r.nativeRequestRef.nativeId) : undefined;
        return { id: r.id, kind: r.kind, summary: (call && describeToolCall(call)) || fallback };
      });
  }

  /** Answer an approval. Idempotent: a repeated answer to the same request is not re-applied. */
  async respond(attemptId: string, requestId: string, decision: string, via = "in Studio") {
    if (!["accept", "acceptForSession", "decline"].includes(decision)) throw new Error(`unknown decision ${decision}`);
    const a = this.dispatcher.get(attemptId);
    const rpc = this.t3(a.worker).rpc;
    if (!rpc || !a.thread_id) throw new Error("this worker was paired without RPC access; pair it again");
    await rpc.dispatch(
      { type: "runtime-request.respond", threadId: a.thread_id, requestId, decision },
      `respond:${requestId}`,
    );
    this.db
      .prepare("INSERT INTO attempt_log (attempt_id, at, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)")
      .run(a.id, Date.now(), a.state, a.state, `you answered a request ${via}: ${decision}`);
    return this.dispatcher.reconcile(attemptId);
  }

  /** One reconciliation pass over open Attempts; removes Kit overlays from finished ones. */
  async tick(): Promise<void> {
    await this.dispatcher.reconcileAll();
    const finished = this.db
      .prepare("SELECT * FROM attempts WHERE worktree_path IS NOT NULL AND state IN ('stopped', 'failed', 'result_available')")
      .all() as unknown as Attempt[];
    for (const a of finished) {
      const conn = this.workers.get(a.worker);
      if (!TERMINAL_STATES.has(a.state) || !conn) continue;
      let reason: string;
      if (conn.local) {
        const leaked = await removeOverlay(a.worktree_path!).catch((e: Error) => [`(overlay removal failed: ${e.message})`]);
        reason = leaked.length ? `Kit files leaked into git: ${leaked.join(", ")}` : "Kit overlay removed";
      } else {
        reason = "Kit files left in the worktree (T3 has no remote delete); hidden from git by their own .gitignore";
      }
      this.db.prepare("UPDATE attempts SET worktree_path = NULL WHERE id = ?").run(a.id);
      this.note(a, reason);
    }
    await this.readHandoffs();
    await this.startCrossChecks();
    await this.workflow.tick();
    await this.readActivity();
    await this.notify();
  }

  /** Post what changed (needs you, finished, failed, machine down) to the notification webhook. */
  private async notify() {
    if (!this.notifier.enabled) return;
    if (Date.now() - this.liveness.at > 30_000) {
      const workers = await Promise.all(
        [...this.workers.values()].map(async (w) => {
          if (!w.t3) await this.connect(w.name);
          const conn = this.workers.get(w.name)!;
          const online = conn.t3 ? await conn.t3.call("t3_project_list").then(() => true, () => false) : false;
          return { name: w.name, online };
        }),
      );
      this.liveness = { at: Date.now(), workers };
    }
    const { roles } = await this.catalog();
    const titles = new Map(roles.map((r) => [r.name, r.title]));
    // The latest attempt of each job is the one that matters.
    const rows = this.db
      .prepare(
        `SELECT a.*, j.title AS job_title, j.kind AS job_kind FROM attempts a JOIN jobs j ON j.id = a.job_id
         WHERE a.created_at = (SELECT MAX(created_at) FROM attempts b WHERE b.job_id = a.job_id)`,
      )
      .all() as unknown as Array<Attempt & { job_title: string; job_kind: string }>;
    const views: AttemptView[] = rows.map((a) => ({
      id: a.id,
      state: a.state,
      worker: a.worker,
      roleTitle: titles.get(a.role ?? "") ?? a.role ?? "An agent",
      jobTitle: a.job_title,
      jobKind: a.job_kind,
      verdict: a.verdict,
      error: a.error,
    }));
    await this.notifier.check(views, this.liveness.workers, async (v) => {
      const { requests } = await this.attempt(v.id);
      return requests.map((r) => r.summary).filter(Boolean).join("\n") || undefined;
    });
    await this.sendBriefIfDue();
  }

  /** Once a day, at the time set in notify.json, post the brief (brief.ts). */
  private async sendBriefIfDue(now = Date.now()) {
    const day = dayKey(now);
    if (!briefDue(this.notifier.briefSetting, now, this.briefs.sent(day))) return;
    const text = await this.brief(this.briefs.lastAt(now), now, this.liveness.workers);
    if (await this.notifier.post("studio.brief", text)) this.briefs.record(day, now);
  }

  /**
   * The brief's text: what happened between `since` and `now`, and what stands now. Without
   * `since`, it covers the time since the last sent brief (or the last day).
   */
  async brief(since?: number, now = Date.now(), workers?: Array<{ name: string; online: boolean }>): Promise<string> {
    const from = since ?? this.briefs.lastAt(now);
    const { roles } = await this.catalog();
    const titles = new Map(roles.map((r) => [r.name, r.title]));
    const roleTitle = (role: string | null) => titles.get(role ?? "") ?? role ?? "An agent";
    const log = (
      this.db
        .prepare(
          `SELECT l.attempt_id, l.at, l.from_state, l.to_state, l.reason, a.role, a.worker, a.verdict, j.title, j.kind
           FROM attempt_log l JOIN attempts a ON a.id = l.attempt_id JOIN jobs j ON j.id = a.job_id
           WHERE l.at > ? AND l.at <= ? ORDER BY l.at`,
        )
        .all(from, now) as Array<Record<string, string | number | null>>
    ).map(
      (r): LogRow => ({
        attemptId: String(r.attempt_id),
        at: Number(r.at),
        fromState: r.from_state as string | null,
        toState: String(r.to_state),
        reason: String(r.reason),
        roleTitle: roleTitle(r.role as string | null),
        worker: String(r.worker),
        verdict: r.verdict as string | null,
        jobTitle: String(r.title),
        jobKind: String(r.kind),
      }),
    );
    // Where each job stands: its latest attempt.
    const latest = this.db
      .prepare(
        `SELECT a.state, a.role, a.worker, j.title, j.kind, j.milestone, j.reviews_attempt FROM attempts a JOIN jobs j ON j.id = a.job_id
         WHERE a.created_at = (SELECT MAX(created_at) FROM attempts b WHERE b.job_id = a.job_id)`,
      )
      .all() as Array<{ state: string; role: string | null; worker: string; title: string; kind: string; milestone: string | null; reviews_attempt: string | null }>;
    const item = (a: (typeof latest)[number]) => ({ roleTitle: roleTitle(a.role), jobTitle: a.title, worker: a.worker });
    const cards = await this.workflow.board.list();
    const board: Record<string, number> = {};
    for (const c of cards) board[c.column] = (board[c.column] ?? 0) + 1;
    if (!workers) workers = (await this.state()).workers.map((w) => ({ name: w.name, online: w.online }));
    return composeBrief({
      now,
      since: from,
      log,
      waiting: latest.filter((a) => a.state === "awaiting_input").map(item),
      toReview: latest.filter((a) => a.state === "result_available" && a.kind === "work" && !a.reviews_attempt && !a.milestone).map(item),
      working: latest.filter((a) => a.state === "running" || a.state === "preparing").map(item),
      proposedCards: board.proposed ?? 0,
      board,
      workers,
    });
  }

  /** What each running agent is doing right now: its newest tool or reasoning item. */
  private async readActivity() {
    const running = this.db.prepare("SELECT * FROM attempts WHERE state = 'running' AND thread_id IS NOT NULL").all() as unknown as Attempt[];
    const live = new Set(running.map((a) => a.id));
    for (const id of Object.keys(this.activity)) if (!live.has(id)) delete this.activity[id];
    for (const a of running) {
      if (!this.workers.get(a.worker)?.t3) continue;
      const read = await this.t3(a.worker)
        .call<{ items: Array<{ type: string; title: string | null; text: string | null }> }>("t3_thread_read", {
          threadId: a.thread_id,
          view: "activity",
          limit: 3,
          maxCharsPerItem: 200,
        })
        .catch(() => undefined);
      const item = read?.items.filter((i) => i.type !== "user_message").at(-1);
      if (item) this.activity[a.id] = { kind: item.type, title: item.title ?? item.text?.split("\n")[0] ?? null };
    }
  }

  note(a: Attempt, reason: string) {
    this.db
      .prepare("INSERT INTO attempt_log (attempt_id, at, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)")
      .run(a.id, Date.now(), a.state, a.state, reason);
  }

  async readThread(a: Attempt) {
    return this.t3(a.worker).call<{
      thread: { branch: string | null; worktreePath: string | null };
      items: Array<{ type: string; text: string | null }>;
    }>("t3_thread_read", { threadId: a.thread_id, view: "messages", limit: 20, maxCharsPerItem: 20_000 });
  }

  /** Record what each finished agent reported: its final commit and, for reviewers, the verdict. */
  private async readHandoffs() {
    const due = this.db
      .prepare("SELECT * FROM attempts WHERE state = 'result_available' AND handoff_read = 0 AND thread_id IS NOT NULL")
      .all() as unknown as Attempt[];
    for (const a of due) {
      if (!this.workers.get(a.worker)?.t3) continue; // try again when the worker is back
      const read = await this.readThread(a).catch(() => undefined);
      if (!read) continue;
      const lastAgent = read.items.filter((i) => i.type.includes("assistant") && i.text).at(-1)?.text ?? "";
      const handoff = parseHandoff(lastAgent);
      this.db
        .prepare("UPDATE attempts SET result_commit = ?, verdict = ?, handoff_read = 1 WHERE id = ?")
        .run(handoff?.commit ?? null, handoff?.verdict ?? null, a.id);
      if (!handoff) this.note(a, "no handoff report found in the agent's final message");
      const job = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(a.job_id) as unknown as Job;
      await this.workflow.onResult({ ...a, result_commit: handoff?.commit ?? null, verdict: handoff?.verdict ?? null }, job, handoff, lastAgent);

      // A review must be of the commit the job produced; say so when it is not.
      const reviewed = this.db
        .prepare("SELECT o.result_commit FROM jobs j JOIN attempts o ON o.id = j.reviews_attempt WHERE j.id = ?")
        .get(a.job_id) as { result_commit: string | null } | undefined;
      if (reviewed?.result_commit && handoff?.commit && !sameCommit(reviewed.result_commit, handoff.commit)) {
        this.note(a, `reviewed ${handoff.commit}, but the job reported ${reviewed.result_commit}`);
      }
    }
  }

  /** Start a cross-check for every finished Job that wants one and does not have one yet. */
  private async startCrossChecks() {
    const due = this.db
      .prepare(
        `SELECT a.* FROM attempts a JOIN jobs j ON j.id = a.job_id
         WHERE a.state = 'result_available' AND a.handoff_read = 1 AND a.review_note IS NULL
           AND j.auto_review = 1 AND j.reviews_attempt IS NULL
           AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.reviews_attempt = a.id)`,
      )
      .all() as unknown as Attempt[];
    for (const a of due) {
      if (!this.workers.get(a.worker)?.t3) continue;
      try {
        await this.startCrossCheck(a);
      } catch (e) {
        this.db.prepare("UPDATE attempts SET review_note = ? WHERE id = ?").run(`cross-check not started: ${(e as Error).message}`, a.id);
        this.note(a, `cross-check not started: ${(e as Error).message}`);
      }
    }
  }

  private async startCrossCheck(a: Attempt) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(a.job_id) as { project: string; title: string; brief: string };
    const conn = this.workers.get(a.worker)!;
    const t3 = conn.t3!;
    const { thread } = await this.readThread(a);
    if (!thread.branch || !thread.worktreePath) throw new Error("the job's thread has no branch to review");
    if (!t3.rpc) throw new Error(`worker ${a.worker} was paired without RPC access`);
    const status = await t3.rpc.call<{ branchChanges?: { baseRef?: string }; aheadCount?: number; hasWorkingTreeChanges?: boolean }>(
      "vcs.refreshStatus",
      { cwd: thread.worktreePath },
    );
    if (!status.aheadCount) throw new Error("the job made no commits to review");
    const base = status.branchChanges?.baseRef ?? "HEAD~1";

    // Prefer the other harness for a real second opinion. Codex cannot take a Kit on remote
    // workers yet (AGENTS.override.md would be committable there).
    // Claude and Codex review each other; OpenCode's work goes to Claude, then Codex.
    const order: Provider[] = a.provider === "claude" ? ["codex", "opencode"] : ["claude", "codex", "opencode"];
    const canRun = (p: Provider) => conn.models[INSTANCE[p]] !== undefined && (conn.local || p !== "codex");
    const provider: Provider = order.find((p) => p !== a.provider && canRun(p)) ?? (a.provider as Provider);

    const brief = [
      `Cross-check another agent's work. Review the changes on branch \`${thread.branch}\` since it left \`${base}\`` +
        ` (\`git log ${base}..HEAD\`, \`git diff ${base}...HEAD\`).`,
      a.result_commit ? `The agent reported its final commit as ${a.result_commit}.` : "The agent did not report a commit.",
      status.hasWorkingTreeChanges
        ? "The agent left uncommitted changes in its own worktree; they are not part of this review. Report that as a finding."
        : "",
      "Run the project's tests and checks if it has any, and report the commands and results.",
      "",
      "The original job brief:",
      "---",
      job.brief,
      "---",
      "",
      "Acceptance criteria:",
      "- Each acceptance criterion of the original brief is assessed against the commit",
      "- Findings are ranked, with defects separated from suggestions",
      "- The handoff contains Verdict: APPROVE or Verdict: CHANGES REQUESTED",
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n");

    const { attemptId } = await this.startJob({
      worker: a.worker,
      project: job.project,
      title: `Cross-check: ${job.title}`,
      brief,
      role: "critic",
      provider,
      baseRef: thread.branch,
      reviewsAttempt: a.id,
    });
    this.note(a, `cross-check started on ${HARNESSES[provider].label} (${attemptId})`);
  }
}

interface RuntimeRequest {
  id: string;
  kind: string;
  status: string;
  nativeRequestRef?: { nativeId?: string };
}

interface TurnItem {
  id: string;
  type: string;
  title?: string | null;
  toolName?: string;
  input?: unknown;
  fileName?: string;
  nativeItemRef?: { nativeId?: string };
}

/** What an approval would let the agent do, from the tool call it gates. */
export function describeToolCall(t: TurnItem): string {
  const why = t.title ? `\n(${t.title})` : "";
  if (t.type === "command_execution" && typeof t.input === "string") return `$ ${t.input}${why}`;
  if (t.type === "file_change" && t.fileName) return `Write ${t.fileName}${why}\n(the new content is not shown before approval)`;
  if (t.toolName && t.input !== undefined) {
    const input = t.input as Record<string, unknown>;
    const target = input.file_path ?? input.path ?? input.url ?? input.pattern;
    const line = typeof target === "string" ? `${t.toolName} ${target}` : `${t.toolName} ${JSON.stringify(t.input)}`;
    return line === t.title ? line : `${line}${why}`;
  }
  return "";
}
