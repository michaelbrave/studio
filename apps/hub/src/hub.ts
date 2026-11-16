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
import { Staff, discoverAgents, discoverTools, type HireInput } from "./staff.ts";
import { sameFolder } from "./desk.ts";
import { listProjects, readTail, t3WorkerPort } from "./t3Worker.ts";
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
  /** T3's id for this machine; with the worker's address it makes links into T3's own UI. */
  environmentId?: string;
}

/** A plan's usage window as T3 reads it from the provider (session, weekly...). */
export interface UsageWindow {
  label: string;
  kind: string;
  usedPercent: number;
  resetsAt: string | null;
}

/** Attempt states in which the agent is still on the job. */
export const ACTIVE_STATES = ["queued", "preparing", "running", "awaiting_input", "capacity_paused", "status_unknown"] as const;

export class Hub {
  readonly db: DatabaseSync;
  readonly dispatcher: Dispatcher;
  readonly workflow: Workflow;
  /** Built-in Roles and Kits first, then the ones made in Studio (STUDIO_HOME). */
  readonly rolesDirs: string[];
  readonly kitsDirs: string[];
  /** The Studio chat's folder (desk.ts); its T3 project is hidden from project lists. */
  deskDir: string | null = null;
  /** Hired agents; null when the hub has no home folder to keep them in (tests). */
  readonly staff: Staff | null;
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
  /** Plan usage per harness: the last reading from each machine's T3, never awaited by the page. */
  private usageCache: { at: number; data: UsageReport } | null = null;
  private usageReading: Promise<UsageReport> | null = null;
  /** Per machine: when Studio last asked its T3 to re-check usage, and any check in flight. */
  private readonly usageChecks = new Map<string, { at: number; running: Promise<void> | null }>();
  /** Finished Attempts already seen, so each newly finished one triggers one usage check. */
  private finishedSeen: Set<string> | null = null;

  constructor(db: DatabaseSync, dirs: { roles: string; kits: string; home?: string }, vault: Vault, notify: NotifyConfig | null = null) {
    this.db = db;
    this.staff = dirs.home ? new Staff(dirs.home, { roles: dirs.roles, kits: dirs.kits }) : null;
    this.rolesDirs = this.staff ? [dirs.roles, this.staff.rolesDir] : [dirs.roles];
    this.kitsDirs = this.staff ? [dirs.kits, this.staff.kitsDir] : [dirs.kits];
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
      conn.environmentId = await conn.t3
        .call<{ environmentId?: string }>("t3_environment_read")
        .then((e) => e.environmentId, () => undefined);
    } catch (e) {
      conn.error = (e as Error).message;
    }
    return conn;
  }

  /** Where a thread opens in T3's own web UI (the same page T3 shows), or null if unknown. */
  threadUrl(worker: string, threadId: string | null): string | null {
    const conn = this.workers.get(worker);
    if (!conn?.environmentId || !threadId) return null;
    return `${new URL(conn.url).origin}/${encodeURIComponent(conn.environmentId)}/${encodeURIComponent(threadId)}`;
  }

  /** Hired staff with a job on right now. */
  busyStaff(): Set<string> {
    const marks = ACTIVE_STATES.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT DISTINCT staff FROM attempts WHERE staff IS NOT NULL AND state IN (${marks})`).all(...ACTIVE_STATES) as Array<{ staff: string }>;
    return new Set(rows.map((r) => r.staff));
  }

  /** A hired staff member in this role with no job on, if there is one: they get the work before anyone new. */
  async freeStaff(role: string, prefer: (m: { runtime: Provider; worker: string }) => boolean = () => true) {
    const busy = this.busyStaff();
    const free = ((await this.staff?.list()) ?? []).filter((m) => m.role === role && !busy.has(m.name));
    return free.find(prefer) ?? free[0] ?? null;
  }

  t3(name: string): T3Worker {
    const conn = this.workers.get(name);
    if (!conn?.t3) throw new Error(`worker ${name} is offline${conn?.error ? `: ${conn.error}` : ""}`);
    return conn.t3;
  }

  /** Each named folder once, from the first of `dirs` that has it; `custom` is true outside the repo. */
  private async folders(dirs: string[]): Promise<Array<{ path: string; custom: boolean }>> {
    const seen = new Set<string>();
    const out: Array<{ path: string; custom: boolean }> = [];
    for (const [i, dir] of dirs.entries()) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const n of entries.filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
        if (seen.has(n)) continue;
        seen.add(n);
        out.push({ path: join(dir, n), custom: i > 0 });
      }
    }
    return out;
  }

  /** Roles and Kits as the UI shows them: hats, and the widgets that go on desks. */
  async catalog() {
    // A Role or Kit you made that no longer loads is left out rather than breaking the whole page.
    const load = async <T extends object>(dirs: string[], fn: (p: string) => Promise<T>) =>
      (
        await Promise.all(
          (await this.folders(dirs)).map(async (f) => {
            try {
              return { ...(await fn(f.path)), custom: f.custom };
            } catch (e) {
              if (!f.custom) throw e;
              console.error(`skipping ${f.path}: ${(e as Error).message}`);
              return null;
            }
          }),
        )
      ).filter((x) => x !== null);
    const roles = await load(this.rolesDirs, loadRole);
    const kits = await load(this.kitsDirs, loadKit);
    return {
      roles: roles.map(({ manifest: r, custom }) => ({
        custom,
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
      kits: kits.map(({ manifest: k, mcpServers, custom }) => ({
        custom,
        mcp: Object.keys(mcpServers),
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
        let projects: Array<{ id: string; title: string; workspaceRoot: string; desk?: boolean }> = [];
        let error = conn.error ?? null;
        if (conn.t3) {
          // The project list doubles as the liveness check: a worker is online if it answers.
          try {
            projects = await listProjects<(typeof projects)[number]>(conn.t3);
            const desk = this.deskDir;
            if (conn.local && desk) projects = projects.map((p) => (sameFolder(p.workspaceRoot, desk) ? { ...p, desk: true } : p));
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
    const staff = (await this.staff?.list()) ?? [];
    const jobsWithAttempts = jobs.map((j) => ({
      ...j,
      attempts: attempts.filter((a) => a.job_id === j.id).map((a) => ({ ...a, t3_url: this.threadUrl(a.worker, a.thread_id) })),
    }));
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
        staff,
      },
      this.seats,
    );
    this.seats = scene.seats;
    return {
      workers,
      ...catalog,
      staff,
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
  async preview(input: { role?: string; kits?: string[]; provider?: Provider; staff?: string }) {
    const member = input.staff ? await this.getStaff(input.staff) : null;
    const loadout = await loadLoadout({
      rolesDir: this.rolesDirs,
      kitsDir: this.kitsDirs,
      role: member?.role ?? input.role ?? "",
      ...(member ? { kits: member.kits, anyKits: true } : input.kits ? { kits: input.kits } : {}),
    });
    const result = compileLoadout({ loadout, provider: input.provider ?? member?.runtime ?? "claude", existing: () => undefined });
    return { launchable: result.launchable, runtimeMode: result.runtimeMode, report: result.report };
  }

  /** Create a Job and its first Attempt, and launch it in the background. */
  async startJob(input: {
    worker: string;
    project: string;
    title: string;
    brief: string;
    role?: string;
    /** Kits to equip; omitted means the role's defaults. */
    kits?: string[];
    provider?: Provider;
    /** A hired staff member to do the job: its Role, Kits, harness, model and soul. */
    staff?: string;
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
    /** The board card this Job works on. Work Jobs without one get a card of their own. */
    card?: string;
    /** Who asked for it, for the card ("you", "the Studio Manager"). */
    by?: string;
  }) {
    const member = input.staff ? await this.getStaff(input.staff) : null;
    const role = member?.role ?? input.role;
    if (!role) throw new Error("pick an agent or a role for the job");
    const provider: Provider = input.provider ?? member?.runtime ?? "claude";
    const loadout = await loadLoadout({
      rolesDir: this.rolesDirs,
      kitsDir: this.kitsDirs,
      role,
      ...(member ? { kits: member.kits, anyKits: true } : input.kits ? { kits: input.kits } : {}),
    });
    const staff = member ? { name: member.displayName, soulOverride: await this.staff!.soulOverride(member) } : undefined;
    const conn = this.workers.get(input.worker);
    if (!conn?.t3) throw new Error(`worker ${input.worker} is offline`);
    const t3 = conn.t3;
    if (!conn.local && !t3.rpc) throw new Error(`worker ${input.worker} was paired without RPC access; pair it again`);
    const projects = await listProjects<{ id: string }>(t3);
    if (!projects.some((p) => p.id === input.project)) throw new Error(`project ${input.project} not found on ${input.worker}`);

    // Check the loadout can be enforced on this runtime before anything is created.
    const dry = compileLoadout({ loadout, provider, existing: () => undefined });
    if (!dry.launchable) {
      const why = dry.report.filter((r) => r.status === "unsupported").map((r) => r.reason);
      throw new Error(`${loadout.role.manifest.title} cannot run on ${provider}: ${why.join("; ")}`);
    }

    const instanceId = INSTANCE[provider];
    // A staff member's model only applies on its own harness; elsewhere the Role's or T3's default.
    const staffModel = member && member.runtime === provider ? member.model : null;
    const model = staffModel ?? dry.model ?? conn.models[instanceId]?.[0] ?? null;
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
    // Every piece of work is on the board, whoever started it, so the board shows what is going on.
    let card = input.card;
    if (!card && (input.kind ?? "work") === "work" && !input.reviewsAttempt) {
      card = (
        await this.workflow.board.create({
          title: input.title,
          project: `${input.worker}/${input.project}`,
          role,
          priority: "normal",
          column: "doing",
          createdBy: input.by ?? "you",
          body: input.brief,
        })
      ).id;
    }
    if (card) await this.workflow.linkCard(card, jobId);
    const attemptId = this.dispatcher.createAttempt(jobId, input.worker, {
      role: loadout.role.manifest.name,
      kits: loadout.kits.map((k) => k.manifest.name),
      provider,
      model,
      snapshot: loadout.snapshot,
      staff: member?.name ?? null,
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
              await this.deliverKit(conn, { loadout, provider, memoryBrief, staff, worktree });
              this.db.prepare("UPDATE attempts SET worktree_path = ? WHERE id = ?").run(worktree, attemptId);
            },
          }),
    };
    void this.dispatcher.launch(attemptId, setup);
    return { jobId, attemptId };
  }

  /** Write the Role and Kits into a worktree, in the harness's own format. */
  private async deliverKit(
    conn: WorkerConn,
    k: {
      loadout: Awaited<ReturnType<typeof loadLoadout>>;
      provider: Provider;
      memoryBrief: string;
      staff: { name: string; soulOverride?: string | undefined } | undefined;
      worktree: string;
    },
  ) {
    if (conn.local) {
      // Compile against the real worktree so tracked project files are respected.
      const result = compileLoadout({
        loadout: k.loadout,
        provider: k.provider,
        existing: await scanWorktree(k.worktree),
        memoryBrief: k.memoryBrief,
        ...(k.staff ? { staff: k.staff } : {}),
      });
      await applyOverlay(k.worktree, result, k.loadout.snapshot);
    } else {
      await deliverKitRemote({
        rpc: conn.t3!.rpc!,
        worktree: k.worktree,
        loadout: k.loadout,
        provider: k.provider,
        memoryBrief: k.memoryBrief,
        ...(k.staff ? { staff: k.staff } : {}),
      });
    }
  }

  /**
   * Put a failed or stopped agent back to work in the same thread and worktree, e.g. after a
   * subscription limit. Its Kit goes back in (it was removed when the job ended), and it is told
   * to carry on where it stopped. The Attempt is watched again from here.
   */
  async restart(attemptId: string, note?: string) {
    const a = this.dispatcher.get(attemptId);
    if (!["failed", "stopped", "status_unknown"].includes(a.state)) throw new Error(`this agent is ${a.state.replace("_", " ")}, not stopped or failed`);
    if (!a.thread_id) throw new Error("this attempt never started a thread; start the job again instead");
    const conn = this.workers.get(a.worker);
    if (!conn?.t3) throw new Error(`computer ${a.worker} is offline`);
    if (!conn.local && !conn.t3.rpc) throw new Error(`computer ${a.worker} was paired without RPC access; pair it again`);
    const job = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(a.job_id) as unknown as Job;
    if (job.kind !== "integration" && a.role && !a.worktree_path) {
      const { thread } = await conn.t3.call<{ thread: { worktreePath: string | null } }>("t3_thread_read", { threadId: a.thread_id, limit: 1 });
      if (thread.worktreePath) {
        const member = a.staff ? await this.staff?.get(a.staff).catch(() => null) : null;
        const loadout = await loadLoadout({
          rolesDir: this.rolesDirs,
          kitsDir: this.kitsDirs,
          role: a.role,
          kits: a.kits ? (JSON.parse(a.kits) as string[]) : [],
          anyKits: true,
        });
        const staff = member ? { name: member.displayName, soulOverride: await this.staff!.soulOverride(member) } : undefined;
        const memoryBrief = await this.workflow.memoryBrief(a.worker, job.project, loadout.role.manifest);
        await this.deliverKit(conn, { loadout, provider: a.provider as Provider, memoryBrief, staff, worktree: thread.worktreePath });
        this.db.prepare("UPDATE attempts SET worktree_path = ? WHERE id = ?").run(thread.worktreePath, a.id);
      }
    }
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM attempt_log WHERE attempt_id = ? AND reason LIKE 'restarted%'").get(a.id) as { n: number }).n;
    await conn.t3.call("t3_thread_send", {
      threadId: a.thread_id,
      message: [
        "You stopped before finishing this job (it may have been a usage limit or an error).",
        "Carry on from where you left off: check what is already done in this worktree, finish the brief, and end with the handoff as instructed.",
        note ? `A note from the user: ${note}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      clientRequestId: `${a.id}-restart-${n + 1}`,
    });
    const after = await conn.t3.call<{ thread: { updatedAt: string } }>("t3_thread_read", { threadId: a.thread_id, limit: 1 });
    this.dispatcher.reopen(a.id, `restarted by you${note ? `: ${note}` : ""}`, Date.parse(after.thread.updatedAt));
    return this.dispatcher.get(a.id);
  }

  /**
   * How much of each harness's plan is used, as T3 last read it from the providers (session,
   * weekly). Answers from the last reading at once; an older one is re-read in the background.
   * T3 itself only re-checks during turns or when asked, so `checkUsage` asks it (see tick()).
   */
  async usage(): Promise<UsageReport> {
    if (!this.usageCache) return this.readUsage();
    if (Date.now() - this.usageCache.at > 30_000) void this.readUsage().catch(() => {});
    return this.usageCache.data;
  }

  /**
   * Ask T3 to re-check plan usage now (the refresh button), then answer with the new reading.
   * Machines checked in the last minute are skipped; a machine that does not answer keeps its
   * last reading.
   */
  async refreshUsage(): Promise<UsageReport> {
    await Promise.all([...this.workers.keys()].map((name) => this.checkUsage(name, 60_000)));
    return this.readUsage();
  }

  /**
   * Ask one machine's T3 to re-read its providers' usage (T3 `server.refreshProviders`), at most
   * once per `minGapMs`. Waits up to a minute; a slower check finishes in the background.
   */
  private async checkUsage(worker: string, minGapMs: number): Promise<void> {
    const state = this.usageChecks.get(worker) ?? { at: 0, running: null };
    this.usageChecks.set(worker, state);
    if (state.running) return withTimeout(state.running, 60_000).catch(() => {});
    if (Date.now() - state.at < minGapMs) return;
    const rpc = this.workers.get(worker)?.t3?.rpc;
    if (!rpc) return;
    state.at = Date.now();
    state.running = rpc
      .call("server.refreshProviders", {})
      .then(
        () => {},
        (e: Error) => console.error(`usage check on ${worker} failed: ${e.message}`),
      )
      .finally(() => {
        state.running = null;
        void this.readUsage().catch(() => {});
      });
    return withTimeout(state.running, 60_000).catch(() => {});
  }

  /**
   * Keep plan usage roughly current without polling the providers: re-check a machine when its
   * reading is over 10 minutes old, once after a window's reset time passes, and when an agent
   * on it finishes a job.
   */
  private checkUsageIfDue() {
    const TEN_MIN = 10 * 60_000;
    const now = Date.now();
    const due = new Map<string, number>(); // machine → minimum gap since its last check
    for (const u of this.usageCache?.data ?? []) {
      const checked = u.checkedAt ? Date.parse(u.checkedAt) : 0;
      if (now - checked > TEN_MIN) due.set(u.worker, TEN_MIN);
      const last = this.usageChecks.get(u.worker)?.at ?? 0;
      // A reset has passed since the last check: confirm it once.
      if (u.windows.some((w) => w.resetsAt && Date.parse(w.resetsAt) < now && Date.parse(w.resetsAt) > Math.max(last, checked))) due.set(u.worker, 0);
    }
    if (!this.usageCache) void this.readUsage().catch(() => {});
    const finished = this.db
      .prepare(`SELECT id, worker FROM attempts WHERE state IN (${[...TERMINAL_STATES].map(() => "?").join(", ")})`)
      .all(...TERMINAL_STATES) as Array<{ id: string; worker: string }>;
    if (this.finishedSeen) {
      for (const a of finished) if (!this.finishedSeen.has(a.id)) due.set(a.worker, Math.min(due.get(a.worker) ?? 60_000, 60_000));
    }
    this.finishedSeen = new Set(finished.map((a) => a.id));
    for (const [worker, gap] of due) void this.checkUsage(worker, gap);
  }

  /** Read every machine's latest usage from T3 (cheap: T3 answers from its own snapshot). */
  private readUsage(): Promise<UsageReport> {
    this.usageReading ??= this.readUsageNow().finally(() => (this.usageReading = null));
    return this.usageReading;
  }

  private async readUsageNow(): Promise<UsageReport> {
    type Limits = { checkedAt: string; credentialFingerprint?: string; windows: Array<UsageWindow & { resetsAt?: string }>; unavailable?: { reason: string } };
    type Config = { providers?: Array<{ instanceId?: string; providerInstanceId?: string; usageLimits?: Limits }> };
    const conns = [...this.workers.values()].filter((c) => c.t3?.rpc);
    const configs = await Promise.all(conns.map((c) => withTimeout(c.t3!.rpc!.call<Config>("server.getConfig", {}), 15_000).catch(() => null)));
    // A machine that did not answer keeps its last reading rather than vanishing from the meter.
    const previous = this.usageCache?.data ?? [];
    const byPlan = new Map<string, UsageReport[number]>();
    conns.forEach((conn, i) => {
      const config = configs[i];
      if (!config) {
        for (const u of previous.filter((p) => p.worker === conn.name)) byPlan.set(`${u.harness}|${u.plan}`, u);
        return;
      }
      for (const p of config.providers ?? []) {
        const id = p.instanceId ?? p.providerInstanceId;
        const harness = (Object.keys(INSTANCE) as Provider[]).find((k) => INSTANCE[k] === id);
        const limits = p.usageLimits;
        if (!harness || !limits || limits.unavailable || !limits.windows.length) continue;
        // The same account signed in on two machines is one plan: show the newer reading.
        const plan = limits.credentialFingerprint ?? conn.name;
        const key = `${harness}|${plan}`;
        const other = byPlan.get(key);
        if (other && Date.parse(other.checkedAt ?? "") >= Date.parse(limits.checkedAt)) continue;
        byPlan.set(key, {
          harness,
          label: HARNESSES[harness].label,
          color: HARNESSES[harness].color,
          worker: conn.name,
          plan,
          windows: limits.windows.map((w) => ({ label: w.label, kind: w.kind, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null })),
          checkedAt: limits.checkedAt,
        });
      }
    });
    const data = [...byPlan.values()].sort((a, b) => a.label.localeCompare(b.label));
    this.usageCache = { at: Date.now(), data };
    return data;
  }

  private async getStaff(name: string) {
    if (!this.staff) throw new Error("this hub has no staff");
    return this.staff.get(name);
  }

  /** What the hire wizard offers: souls, tools found on this computer, and agents to import. */
  async hireOptions() {
    const [souls, tools, agents] = await Promise.all([this.staff?.souls() ?? [], discoverTools(), discoverAgents()]);
    return {
      souls,
      // Never send MCP env or headers to the browser: they may hold tokens.
      mcp: tools.mcp.map(({ name, source, summary }) => ({ name, source, summary })),
      skills: tools.skills.map(({ name, description, source }) => ({ name, description, source })),
      agents,
    };
  }

  async hire(input: HireInput) {
    if (!this.staff) throw new Error("this hub has no staff folder");
    const { roles, kits } = await this.catalog();
    return this.staff.hire(input, { roles: roles.map((r) => r.name), kits: kits.map((k) => k.name), workers: [...this.workers.keys()] });
  }

  async fire(name: string) {
    await this.getStaff(name);
    const busy = this.db
      .prepare(`SELECT 1 FROM attempts WHERE staff = ? AND state NOT IN ('stopped', 'failed', 'result_available')`)
      .get(name);
    if (busy) throw new Error("this agent is still on a job; cancel it first");
    await this.staff!.fire(name);
  }

  async cancel(attemptId: string) {
    return this.dispatcher.cancel(attemptId);
  }

  /** Attempt detail for the UI: state history, the thread's recent activity, and open requests. */
  async attempt(attemptId: string, opts: { seen?: boolean } = {}) {
    let a = this.dispatcher.get(attemptId);
    // You opened a finished agent's work: it can go back to its desk (packages/sim, "settled").
    if (opts.seen && TERMINAL_STATES.has(a.state) && a.seen_at === null) {
      this.db.prepare("UPDATE attempts SET seen_at = ? WHERE id = ?").run(Date.now(), a.id);
      a = this.dispatcher.get(attemptId);
    }
    let messages: Array<{ type: string; text: string | null; title: string | null; status: string; by: string | null; at: string }> = [];
    let requests: Array<{ id: string; kind: string; summary: string }> = [];
    if (a.thread_id && this.workers.get(a.worker)?.t3) {
      const read = await readTail(this.t3(a.worker), a.thread_id, { view: "activity", last: 60, maxCharsPerItem: 4_000 }).catch(() => ({ items: [] }));
      messages = read.items.map((i) => ({ type: i.type, text: i.text, title: i.title, status: i.status, by: i.createdBy, at: i.updatedAt }));
      if (a.state === "awaiting_input") requests = await this.openRequests(a.worker, a.thread_id, messages);
    }
    return { attempt: a, history: this.dispatcher.history(attemptId), messages, requests, t3Url: this.threadUrl(a.worker, a.thread_id) };
  }

  /** Approvals and questions the agent is blocked on. Read over RPC: MCP does not list approvals. */
  async openRequests(worker: string, threadId: string, items: Array<{ type: string; text: string | null; title: string | null; status: string }>) {
    const rpc = this.t3(worker).rpc;
    if (!rpc) return [];
    const snap = await rpc
      .get<{ projection: { runtimeRequests: RuntimeRequest[]; turnItems: TurnItem[] } }>(
        `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
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
    this.checkUsageIfDue();
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
      const read = await readTail(this.t3(a.worker), a.thread_id!, { view: "activity", last: 3, maxCharsPerItem: 200 }).catch(() => undefined);
      const item = read?.items.filter((i) => i.type !== "user_message").at(-1);
      if (item) this.activity[a.id] = { kind: item.type, title: item.title ?? item.text?.split("\n")[0] ?? null };
    }
  }

  note(a: Attempt, reason: string) {
    this.db
      .prepare("INSERT INTO attempt_log (attempt_id, at, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)")
      .run(a.id, Date.now(), a.state, a.state, reason);
  }

  /** The thread's branch and worktree, and its newest messages (the agent's final one is last). */
  async readThread(a: Attempt) {
    return readTail<{ branch: string | null; worktreePath: string | null }>(this.t3(a.worker), a.thread_id!, {
      view: "messages",
      last: 20,
      maxCharsPerItem: 20_000,
    });
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
    // A hired Code Critic who is free does the review, on another harness when one is hired; only
    // when no critic is free does Studio bring in someone for this one job.
    const critic = await this.freeStaff("critic", (m) => m.runtime !== a.provider && canRun(m.runtime));
    const provider: Provider =
      critic && canRun(critic.runtime) ? critic.runtime : (order.find((p) => p !== a.provider && canRun(p)) ?? (a.provider as Provider));

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
      ...(critic && critic.runtime === provider ? { staff: critic.name } : {}),
      baseRef: thread.branch,
      reviewsAttempt: a.id,
    });
    this.note(a, `cross-check started on ${HARNESSES[provider].label} (${attemptId})`);
  }
}

export type UsageReport = Array<{
  harness: Provider;
  label: string;
  color: string;
  /** The machine it was read on. */
  worker: string;
  /** Which account: T3's opaque credential fingerprint, or the machine when it gives none. */
  plan: string;
  windows: UsageWindow[];
  /** When the provider was last asked (T3 probe or a mid-turn update). */
  checkedAt: string | null;
}>;

/** Reject when `promise` takes longer than `ms`; the work itself carries on. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
