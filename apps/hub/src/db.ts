// Hub state: SQLite, authoritative for Jobs and Attempts (PLAN.md §8, "Execution, recovery, and
// integration contract"). T3 owns thread execution; the hub only records what it asked for and
// what it observed.

import { DatabaseSync } from "node:sqlite";

export const EXECUTION_STATES = [
  "queued",
  "preparing",
  "running",
  "awaiting_input",
  "capacity_paused",
  "status_unknown",
  "stopped",
  "failed",
  "result_available",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** What a Job is for. Work is reviewed and integrated; the others support it. */
export type JobKind = "work" | "review" | "integration" | "planning";

/** Milestones of a work Job after its result is available (PLAN.md §8). */
export type Milestone = "accepted" | "rejected" | "integrated";

export interface Job {
  id: string;
  project: string;
  title: string;
  brief: string;
  reviews_attempt: string | null;
  auto_review: number;
  kind: JobKind;
  /** For integration jobs: the work Job being integrated. */
  target_job: string | null;
  milestone: Milestone | null;
  integrated_commit: string | null;
  created_at: number;
}

export const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set(["stopped", "failed", "result_available"]);

export interface Attempt {
  id: string;
  job_id: string;
  worker: string;
  state: ExecutionState;
  /** Unique text stamped into the T3 thread title so a lost launch can be found again. */
  marker: string;
  thread_id: string | null;
  /** Set immediately before the launch call; non-null means a launch may exist on the worker. */
  launch_sent_at: number | null;
  last_observed_at: number | null;
  last_seq: number;
  cancel_requested: number;
  launch_attempts: number;
  error: string | null;
  role: string | null;
  /** JSON array of equipped Kit names. */
  kits: string | null;
  provider: string | null;
  model: string | null;
  /** Content hash of the role and kits that ran (Loadout.snapshot). */
  snapshot: string | null;
  /** Where the Kit overlay was applied, so it can be removed when the Attempt ends. */
  worktree_path: string | null;
  /** From the agent's handoff once the Attempt finished: the commit it reported, and a reviewer's verdict. */
  result_commit: string | null;
  verdict: string | null;
  handoff_read: number;
  /** Why no cross-check was started for this Attempt, if one was not. */
  review_note: string | null;
  /** The hired staff member doing this Attempt, if one is (staff.ts). */
  staff: string | null;
  /** When you first opened the finished Attempt in Studio; until then it shows as waiting for you. */
  seen_at: number | null;
  created_at: number;
}

export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      reviews_attempt TEXT,
      auto_review INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'work',
      target_job TEXT,
      milestone TEXT,
      integrated_commit TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      worker TEXT NOT NULL,
      state TEXT NOT NULL,
      marker TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      launch_sent_at INTEGER,
      last_observed_at INTEGER,
      last_seq INTEGER NOT NULL DEFAULT -1,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      launch_attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      role TEXT,
      kits TEXT,
      provider TEXT,
      model TEXT,
      snapshot TEXT,
      worktree_path TEXT,
      result_commit TEXT,
      verdict TEXT,
      handoff_read INTEGER NOT NULL DEFAULT 0,
      review_note TEXT,
      staff TEXT,
      seen_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ratings (
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      category TEXT NOT NULL,
      stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
      note TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY (attempt_id, category)
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      worker TEXT NOT NULL,
      project TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      desk INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempt_log (
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      at INTEGER NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL
    );
  `);
  migrate(db);
  return db;
}

/** Bring databases created by earlier versions up to the current schema. */
function migrate(db: DatabaseSync) {
  const columns = new Set((db.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>).map((c) => c.name));
  // Before Roles existed, an Attempt ran one "kit" that was what is now a Role.
  if (columns.has("kit")) db.exec("ALTER TABLE attempts RENAME COLUMN kit TO role");
  if (columns.has("kit_snapshot")) db.exec("ALTER TABLE attempts RENAME COLUMN kit_snapshot TO snapshot");
  if (!columns.has("kits")) db.exec("ALTER TABLE attempts ADD COLUMN kits TEXT");
  if (!columns.has("model")) db.exec("ALTER TABLE attempts ADD COLUMN model TEXT");
  for (const [col, def] of [
    ["result_commit", "TEXT"],
    ["verdict", "TEXT"],
    ["handoff_read", "INTEGER NOT NULL DEFAULT 0"],
    ["review_note", "TEXT"],
    ["staff", "TEXT"],
    ["seen_at", "INTEGER"],
  ] as const) {
    if (!columns.has(col)) db.exec(`ALTER TABLE attempts ADD COLUMN ${col} ${def}`);
  }
  const jobColumns = new Set((db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!jobColumns.has("reviews_attempt")) db.exec("ALTER TABLE jobs ADD COLUMN reviews_attempt TEXT");
  // Jobs from before cross-checks existed are not reviewed retroactively.
  if (!jobColumns.has("auto_review")) db.exec("ALTER TABLE jobs ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0");
  if (!jobColumns.has("kind")) {
    db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'");
    db.exec("UPDATE jobs SET kind = 'review' WHERE reviews_attempt IS NOT NULL");
  }
  for (const col of ["target_job", "milestone", "integrated_commit"]) {
    if (!jobColumns.has(col)) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
  }
}
