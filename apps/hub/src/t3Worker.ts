// WorkerPort backed by a stock T3 server's MCP tools.

import { T3Worker } from "@studio/t3-bridge";
import type { ExecutionState } from "./db.ts";
import type { WorkerPort } from "./dispatch.ts";

/** T3 thread status ("idle" or a V2 run status) → Studio execution state. */
export function toExecutionState(status: string): ExecutionState {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
      return "preparing";
    case "running":
      return "running";
    case "waiting":
      return "awaiting_input";
    case "completed":
      return "result_available"; // the run ended; acceptance is decided by review, not here
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    default:
      // "idle" should not happen for a thread launched with a message; don't guess.
      return "status_unknown";
  }
}

interface ThreadSummary {
  threadId: string;
  title: string;
  status: string;
  updatedAt: string;
  worktreePath?: string | null;
  pendingRequestCount?: number;
}

/** T3 creates the worktree asynchronously after launch; wait until the thread is bound to it. */
async function waitForWorktree(worker: T3Worker, threadId: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { thread } = await worker.call<{ thread: ThreadSummary }>("t3_thread_read", { threadId, limit: 1 });
    if (thread.worktreePath) return thread.worktreePath;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`thread ${threadId} had no worktree after ${timeoutMs / 1000}s`);
}

export interface TimelineItem {
  position: number;
  type: string;
  text: string | null;
  title: string | null;
  status: string;
  createdBy: string | null;
  updatedAt: string;
}

interface ReadPage<T> {
  thread: T & { itemCount: number };
  items: TimelineItem[];
  nextPosition: number | null;
  hasMore: boolean;
}

/**
 * The newest `last` items of a thread's timeline. T3 pages from the start (afterPosition), so a
 * plain read with a limit returns the OLDEST items: a long chat would stop showing anything new.
 * This starts near the end, and reaches further back only when the view skipped items there.
 */
export async function readTail<T = Record<string, unknown>>(
  worker: T3Worker,
  threadId: string,
  opts: { view: "activity" | "messages"; last: number; maxCharsPerItem: number },
): Promise<{ thread: T & { itemCount: number }; items: TimelineItem[] }> {
  const head = await worker.call<ReadPage<T>>("t3_thread_read", { threadId, view: opts.view, limit: 1, maxCharsPerItem: 1 });
  const total = Number(head.thread?.itemCount);
  // Without a count (an older T3), read the whole timeline once.
  let back = Number.isFinite(total) ? opts.last : Infinity;
  for (;;) {
    // afterPosition is exclusive; undefined reads from the very start.
    const after = total - back - 1;
    const items: TimelineItem[] = [];
    let thread = head.thread;
    let pos: number | undefined = after >= 0 ? after : undefined;
    for (;;) {
      const page: ReadPage<T> = await worker.call<ReadPage<T>>("t3_thread_read", {
        threadId,
        view: opts.view,
        limit: 100,
        maxCharsPerItem: opts.maxCharsPerItem,
        ...(pos === undefined ? {} : { afterPosition: pos }),
      });
      thread = page.thread;
      items.push(...page.items);
      if (!page.hasMore || page.nextPosition === null || page.nextPosition === pos) break;
      pos = page.nextPosition;
    }
    if (items.length >= opts.last || !(after >= 0)) return { thread, items: items.slice(-opts.last) };
    back *= 4;
  }
}

/** Every project on a worker. t3_project_list returns 20 per page unless asked. */
export async function listProjects<P = { id: string; title: string; workspaceRoot: string }>(worker: T3Worker): Promise<P[]> {
  const out: P[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: { projects: P[]; nextCursor: number | null } = await worker.call("t3_project_list", { cursor, limit: 100 });
    out.push(...page.projects);
    cursor = page.nextCursor ?? null;
    if (out.length > 2000) break;
  }
  return out;
}

export interface T3WorkerPortOptions {
  /** Each Attempt gets its own worktree, branched from this ref. */
  baseRef?: string;
}

export function t3WorkerPort(worker: T3Worker, opts: T3WorkerPortOptions = {}): WorkerPort {
  return {
    async launch(req) {
      const launch = await worker.call<{ threadId: string }>("t3_thread_launch", {
        projectId: req.project,
        title: req.title,
        workspaceStrategy:
          req.workspace === "root"
            ? { type: "root" }
            : { type: "worktree", baseRef: req.baseRef ?? opts.baseRef ?? "HEAD", startFromOrigin: false },
        ...(req.instanceId && req.model ? { modelSelection: { instanceId: req.instanceId, model: req.model } } : {}),
        ...(req.runtimeMode ? { runtimeMode: req.runtimeMode } : {}),
        // With a prepare step the thread starts idle; the message follows once the Kit is in place.
        ...(req.prepare ? {} : { message: req.message }),
      });
      if (req.prepare) {
        await req.prepare(await waitForWorktree(worker, launch.threadId));
        await worker.call("t3_thread_send", {
          threadId: launch.threadId,
          message: req.message,
          clientRequestId: `${req.requestKey}-first-message`,
        });
      }
      return { threadId: launch.threadId };
    },

    async findByMarker(project, marker) {
      // T3 itself advises inspecting t3_thread_list after a lost launch response.
      const result = await worker.call<{ threads: ThreadSummary[] }>("t3_thread_list", {
        projectId: project,
        titleContains: marker,
        limit: 10,
      });
      return result.threads.filter((t) => t.title.includes(marker)).map((t) => ({ threadId: t.threadId }));
    },

    async observe(threadId) {
      const { thread } = await worker.call<{ thread: ThreadSummary }>("t3_thread_read", { threadId, limit: 1 });
      // T3 keeps a run "running" while it waits on an approval; the pending count says otherwise.
      const state = thread.pendingRequestCount ? "awaiting_input" : toExecutionState(thread.status);
      // updatedAt only moves forward for a thread, so it orders observations.
      return { state, seq: Date.parse(thread.updatedAt) };
    },

    async interrupt(threadId) {
      await worker.call("t3_thread_interrupt", { threadId, reason: "cancelled from Studio" });
    },
  };
}
