// Dispatch and reconciliation. The invariants Stage 0 must prove (PLAN.md §11):
//  - a lost launch response never produces a second thread for the same Attempt;
//  - a hub restart or worker disconnect never triggers a replacement Attempt by itself;
//  - anything the hub cannot confirm is shown as status_unknown, not guessed.
//
// T3's t3_thread_launch has no retry key, so each launch carries the Attempt's marker in its
// thread title and an ambiguous launch is resolved by looking for that marker on the worker.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TERMINAL_STATES, type Attempt, type ExecutionState, type JobKind } from "./db.ts";

/** How to run an Attempt: which agent, and what to put in its worktree before it starts. */
export interface LaunchSetup {
  /** T3 provider instance, e.g. "claudeAgent" or "codex". */
  instanceId?: string;
  model?: string;
  runtimeMode?: "approval-required" | "auto-accept-edits" | "full-access";
  /** What the Attempt's fresh worktree starts from; the worker's default when omitted. */
  baseRef?: string;
  /** "root" runs in the project's own checkout instead of a fresh worktree (integration only). */
  workspace?: "worktree" | "root";
  /** Runs after the worktree exists and before the agent gets its first message (Kit delivery). */
  prepare?: (worktreePath: string) => Promise<void>;
}

export interface LaunchRequest extends LaunchSetup {
  title: string;
  message: string;
  project: string;
  /** Stable per Attempt; lets idempotent T3 calls inside a launch be retried safely. */
  requestKey: string;
}

/** What the hub needs from a worker. The T3 implementation lives in t3Worker.ts. */
export interface WorkerPort {
  launch(req: LaunchRequest): Promise<{ threadId: string }>;
  /** Threads whose title contains the marker. Throws if the worker cannot be reached. */
  findByMarker(project: string, marker: string): Promise<Array<{ threadId: string }>>;
  observe(threadId: string): Promise<{ state: ExecutionState; seq: number }>;
  interrupt(threadId: string): Promise<void>;
}

export interface DispatchOptions {
  workers: Record<string, WorkerPort>;
  now?: () => number;
  /**
   * How long a launch may still land on the worker after the hub gave up waiting. A marker
   * missing before this has passed is not proof the launch failed.
   */
  launchGraceMs?: number;
  maxLaunchAttempts?: number;
}

export class Dispatcher {
  private readonly db: DatabaseSync;
  private readonly workers: Record<string, WorkerPort>;
  private readonly now: () => number;
  private readonly launchGraceMs: number;
  private readonly maxLaunchAttempts: number;
  /** Launch calls still running in this process. Only a launch nobody is waiting on is ambiguous. */
  private readonly inFlight = new Set<string>();

  constructor(db: DatabaseSync, opts: DispatchOptions) {
    this.db = db;
    this.workers = opts.workers;
    this.now = opts.now ?? Date.now;
    this.launchGraceMs = opts.launchGraceMs ?? 120_000;
    this.maxLaunchAttempts = opts.maxLaunchAttempts ?? 3;
  }

  /** `reviewsAttempt` makes this a cross-check of that Attempt; cross-checks are not themselves reviewed. */
  createJob(job: {
    project: string;
    title: string;
    brief: string;
    kind?: JobKind;
    reviewsAttempt?: string;
    targetJob?: string;
    autoReview?: boolean;
  }): string {
    const id = `job_${randomUUID()}`;
    const kind = job.kind ?? (job.reviewsAttempt ? "review" : "work");
    this.db
      .prepare(
        `INSERT INTO jobs (id, project, title, brief, kind, reviews_attempt, target_job, auto_review, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        job.project,
        job.title,
        job.brief,
        kind,
        job.reviewsAttempt ?? null,
        job.targetJob ?? null,
        kind === "work" && job.autoReview !== false ? 1 : 0,
        this.now(),
      );
    return id;
  }

  /** `loadout` records who runs the Attempt: role, equipped kits, runtime and model. */
  createAttempt(
    jobId: string,
    worker: string,
    loadout?: { role: string; kits: string[]; provider: string; model: string | null; snapshot: string },
  ): string {
    if (!this.workers[worker]) throw new Error(`unknown worker ${worker}`);
    const id = `att_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO attempts (id, job_id, worker, state, marker, role, kits, provider, model, snapshot, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        jobId,
        worker,
        `[studio:${id.slice(4, 16)}]`,
        loadout?.role ?? null,
        loadout ? JSON.stringify(loadout.kits) : null,
        loadout?.provider ?? null,
        loadout?.model ?? null,
        loadout?.snapshot ?? null,
        this.now(),
      );
    this.log(id, null, "queued", "created");
    return id;
  }

  get(id: string): Attempt {
    const row = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Attempt | undefined;
    if (!row) throw new Error(`no attempt ${id}`);
    return row;
  }

  history(id: string) {
    return this.db.prepare("SELECT from_state, to_state, reason FROM attempt_log WHERE attempt_id = ? ORDER BY rowid").all(id);
  }

  /** Launch a queued Attempt. The intent is persisted before the call, so a crash mid-call is recoverable. */
  async launch(id: string, setup: LaunchSetup = {}): Promise<Attempt> {
    const a = this.get(id);
    if (a.state !== "queued") throw new Error(`attempt ${id} is ${a.state}, not queued`);
    if (a.launch_attempts >= this.maxLaunchAttempts) {
      this.transition(a, "failed", `gave up after ${a.launch_attempts} launch attempts`);
      return this.get(id);
    }
    const job = this.job(a.job_id);
    this.db
      .prepare("UPDATE attempts SET launch_sent_at = ?, launch_attempts = launch_attempts + 1 WHERE id = ?")
      .run(this.now(), id);
    this.transition(a, "preparing", "launch sent");

    this.inFlight.add(id);
    try {
      const { threadId } = await this.worker(a).launch({
        ...setup,
        title: `${a.marker} ${job.title}`,
        message: job.brief,
        project: job.project,
        requestKey: `${a.id}-${a.launch_attempts + 1}`,
      });
      this.bindThread(id, threadId, "launch confirmed");
    } catch (e) {
      // The worker may or may not have started the thread. Only reconciliation can tell.
      this.transition(this.get(id), "status_unknown", `launch response lost: ${(e as Error).message}`);
    } finally {
      this.inFlight.delete(id);
    }
    return this.get(id);
  }

  /** Bring one Attempt in line with the worker. Safe to call repeatedly, e.g. on hub restart. */
  async reconcile(id: string): Promise<Attempt> {
    const a = this.get(id);
    if (TERMINAL_STATES.has(a.state) || a.state === "queued" || this.inFlight.has(id)) return a;

    if (a.thread_id === null) {
      // A launch may or may not exist. Look for its marker before anything else.
      let found: Array<{ threadId: string }>;
      try {
        found = await this.worker(a).findByMarker(this.job(a.job_id).project, a.marker);
      } catch (e) {
        this.transition(a, "status_unknown", `worker unreachable: ${(e as Error).message}`);
        return this.get(id);
      }
      if (found.length > 1) {
        this.transition(a, "status_unknown", `marker matches ${found.length} threads; needs a person`);
        return this.get(id);
      }
      if (found.length === 1) {
        this.bindThread(id, found[0]!.threadId, "found launched thread by marker");
        return this.reconcile(id);
      }
      if (a.launch_sent_at !== null && this.now() - a.launch_sent_at < this.launchGraceMs) {
        this.transition(a, "status_unknown", "launch not visible yet; within grace period");
        return this.get(id);
      }
      if (a.cancel_requested) this.transition(a, "stopped", "cancelled; launch confirmed absent");
      else this.transition(a, "queued", "launch confirmed absent after grace period");
      return this.get(id);
    }

    try {
      const obs = await this.worker(a).observe(a.thread_id);
      this.applyObservation(id, obs);
      const now = this.get(id);
      if (now.cancel_requested && now.state === "status_unknown") {
        // The worker answered and reports nothing running (an idle thread): the cancel is confirmed.
        this.transition(now, "stopped", "cancelled; worker reports nothing running");
      } else if (now.cancel_requested && !TERMINAL_STATES.has(now.state)) {
        await this.worker(a).interrupt(a.thread_id);
      }
    } catch (e) {
      // A disconnect is not a failure and never by itself justifies a replacement Attempt.
      this.transition(a, "status_unknown", `worker unreachable: ${(e as Error).message}`);
    }
    return this.get(id);
  }

  async reconcileAll(): Promise<void> {
    const open = this.db
      .prepare(`SELECT id FROM attempts WHERE state NOT IN ('queued', 'stopped', 'failed', 'result_available')`)
      .all() as Array<{ id: string }>;
    for (const { id } of open) await this.reconcile(id);
  }

  /**
   * Record an observed state. Observations at or below the last applied sequence number are
   * duplicates or out of order and are ignored.
   */
  applyObservation(id: string, obs: { state: ExecutionState; seq: number }): boolean {
    const a = this.get(id);
    if (obs.seq <= a.last_seq) return false;
    this.db.prepare("UPDATE attempts SET last_seq = ?, last_observed_at = ? WHERE id = ?").run(obs.seq, this.now(), id);
    if (obs.state !== a.state) this.transition(this.get(id), obs.state, `observed at seq ${obs.seq}`);
    return true;
  }

  /** Request cancellation. The Attempt stays in its state until the worker confirms it stopped. */
  async cancel(id: string): Promise<Attempt> {
    const a = this.get(id);
    if (TERMINAL_STATES.has(a.state)) return a;
    this.db.prepare("UPDATE attempts SET cancel_requested = 1 WHERE id = ?").run(id);
    this.log(id, a.state, a.state, "cancel requested");
    if (a.state === "queued") {
      this.transition(this.get(id), "stopped", "cancelled before launch");
    } else if (a.thread_id) {
      await this.worker(a).interrupt(a.thread_id).catch(() => {}); // confirmed later by reconcile
    }
    return this.get(id);
  }

  private bindThread(id: string, threadId: string, reason: string) {
    const a = this.get(id);
    this.db.prepare("UPDATE attempts SET thread_id = ?, last_observed_at = ? WHERE id = ?").run(threadId, this.now(), id);
    this.transition(a, "running", reason);
  }

  private transition(a: Attempt, to: ExecutionState, reason: string) {
    this.db.prepare("UPDATE attempts SET state = ?, error = ? WHERE id = ?").run(to, to === "failed" ? reason : null, a.id);
    this.log(a.id, a.state, to, reason);
  }

  private log(id: string, from: ExecutionState | null, to: ExecutionState, reason: string) {
    this.db
      .prepare("INSERT INTO attempt_log (attempt_id, at, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)")
      .run(id, this.now(), from, to, reason);
  }

  private job(id: string) {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as { project: string; title: string; brief: string };
  }

  private worker(a: Attempt): WorkerPort {
    const w = this.workers[a.worker];
    if (!w) throw new Error(`unknown worker ${a.worker}`);
    return w;
  }
}
