import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb, type ExecutionState } from "../src/db.ts";
import { Dispatcher, type LaunchRequest, type WorkerPort } from "../src/dispatch.ts";

/** A worker that really creates threads, but can drop responses or go offline. */
class FakeWorker implements WorkerPort {
  threads = new Map<string, { title: string; state: ExecutionState; seq: number }>();
  dropNextLaunchResponse = false;
  offline = false;
  interrupts: string[] = [];

  async launch(req: LaunchRequest) {
    if (this.offline) throw new Error("ECONNREFUSED");
    const threadId = `thr_${this.threads.size + 1}`;
    this.threads.set(threadId, { title: req.title, state: "running", seq: 1 });
    if (this.dropNextLaunchResponse) {
      this.dropNextLaunchResponse = false;
      throw new Error("timeout");
    }
    return { threadId };
  }
  async findByMarker(_project: string, marker: string) {
    if (this.offline) throw new Error("ECONNREFUSED");
    return [...this.threads].filter(([, t]) => t.title.includes(marker)).map(([threadId]) => ({ threadId }));
  }
  async observe(threadId: string) {
    if (this.offline) throw new Error("ECONNREFUSED");
    const t = this.threads.get(threadId)!;
    return { state: t.state, seq: t.seq };
  }
  async interrupt(threadId: string) {
    this.interrupts.push(threadId);
  }
  finish(threadId: string, state: ExecutionState) {
    const t = this.threads.get(threadId)!;
    t.state = state;
    t.seq++;
  }
}

function setup(dbPath = ":memory:") {
  let clock = 1_000_000;
  const worker = new FakeWorker();
  const db = openDb(dbPath);
  const opts = { workers: { desktop: worker }, now: () => clock, launchGraceMs: 60_000 };
  const d = new Dispatcher(db, opts);
  const job = d.createJob({ project: "proj", title: "Add login", brief: "Add a login form" });
  return { d, db, worker, job, opts, advance: (ms: number) => (clock += ms) };
}

test("happy path: launch binds the thread and observation completes it", async () => {
  const { d, worker, job } = setup();
  const id = d.createAttempt(job, "desktop");
  assert.equal((await d.launch(id)).state, "running");
  worker.finish("thr_1", "result_available");
  assert.equal((await d.reconcile(id)).state, "result_available");
});

test("lost launch response: reconciliation finds the thread instead of launching again", async () => {
  const { d, worker, job } = setup();
  const id = d.createAttempt(job, "desktop");
  worker.dropNextLaunchResponse = true;

  assert.equal((await d.launch(id)).state, "status_unknown");
  const a = await d.reconcile(id);
  assert.equal(a.state, "running");
  assert.equal(a.thread_id, "thr_1");
  assert.equal(worker.threads.size, 1, "no duplicate thread");
});

test("launch that never arrived is only retried after the grace period", async () => {
  const { d, worker, job, advance } = setup();
  const id = d.createAttempt(job, "desktop");
  worker.offline = true;
  assert.equal((await d.launch(id)).state, "status_unknown");
  worker.offline = false;

  assert.equal((await d.reconcile(id)).state, "status_unknown", "too early to call it absent");
  advance(61_000);
  assert.equal((await d.reconcile(id)).state, "queued");
  assert.equal((await d.launch(id)).state, "running");
  assert.equal(worker.threads.size, 1);
});

test("hub restart mid-launch: a new Dispatcher on the same database recovers the Attempt", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "studio-hub-")), "hub.db");
  const first = setup(path);
  const id = first.d.createAttempt(first.job, "desktop");
  first.worker.dropNextLaunchResponse = true; // the hub "dies" before seeing the response
  await first.d.launch(id);
  first.db.close();

  const restarted = new Dispatcher(openDb(path), first.opts);
  await restarted.reconcileAll();
  assert.equal(restarted.get(id).state, "running");
  assert.equal(first.worker.threads.size, 1);
});

test("worker disconnect makes the Attempt unknown, never replaced", async () => {
  const { d, worker, job } = setup();
  const id = d.createAttempt(job, "desktop");
  await d.launch(id);
  worker.offline = true;
  const a = await d.reconcile(id);
  assert.equal(a.state, "status_unknown");
  assert.equal(a.thread_id, "thr_1", "still bound to the same thread");
  worker.offline = false;
  assert.equal((await d.reconcile(id)).state, "running");
  assert.equal(worker.threads.size, 1);
});

test("duplicate and out-of-order observations are ignored", async () => {
  const { d, job } = setup();
  const id = d.createAttempt(job, "desktop");
  await d.launch(id);
  assert.ok(d.applyObservation(id, { state: "awaiting_input", seq: 5 }));
  assert.ok(!d.applyObservation(id, { state: "awaiting_input", seq: 5 }));
  assert.ok(!d.applyObservation(id, { state: "running", seq: 3 }));
  assert.equal(d.get(id).state, "awaiting_input");
});

test("cancel stays pending until the worker confirms the stop", async () => {
  const { d, worker, job } = setup();
  const id = d.createAttempt(job, "desktop");
  await d.launch(id);
  assert.equal((await d.cancel(id)).state, "running");
  assert.deepEqual(worker.interrupts, ["thr_1"]);
  worker.finish("thr_1", "stopped");
  assert.equal((await d.reconcile(id)).state, "stopped");
});

test("cancel during an ambiguous launch is applied once the thread is found", async () => {
  const { d, worker, job } = setup();
  const id = d.createAttempt(job, "desktop");
  worker.dropNextLaunchResponse = true;
  await d.launch(id);
  await d.cancel(id);
  await d.reconcile(id);
  assert.deepEqual(worker.interrupts, ["thr_1"]);
});

test("launch retries are bounded and every transition is logged", async () => {
  const { d, worker, job, advance } = setup();
  const id = d.createAttempt(job, "desktop");
  worker.offline = true;
  for (let i = 0; i < 3; i++) {
    await d.launch(id);
    worker.offline = false;
    advance(61_000);
    await d.reconcile(id);
    worker.offline = true;
  }
  assert.equal((await d.launch(id)).state, "failed");
  const reasons = d.history(id).map((h) => (h as { reason: string }).reason);
  assert.ok(reasons.includes("gave up after 3 launch attempts"));
});

test("reconcile leaves a launch that is still in progress alone", async () => {
  const { d, worker, job } = setup();
  const id = d.createAttempt(job, "desktop");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // A slow launch (e.g. Kit delivery) must not be mistaken for a lost one.
  worker.launch = async (req) => {
    await req.prepare?.("/wt");
    return FakeWorker.prototype.launch.call(worker, req);
  };
  const launch = d.launch(id, { prepare: () => gate });
  await new Promise((r) => setImmediate(r)); // launch is now parked inside prepare
  assert.equal((await d.reconcile(id)).state, "preparing");
  release();
  await launch;
  assert.equal(d.get(id).state, "running");
  assert.ok(!d.history(id).some((h) => (h as { to_state: string }).to_state === "status_unknown"));
});

test("a restarted attempt is watched again, and the run that already failed cannot fail it twice", async () => {
  const { d, worker, job } = setup();
  const id = d.createAttempt(job, "desktop");
  await d.launch(id);
  worker.finish("thr_1", "failed");
  assert.equal((await d.reconcile(id)).state, "failed");
  // The restart message was sent; T3 still reports the old failure at the position we recorded.
  const seq = worker.threads.get("thr_1")!.seq;
  d.reopen(id, "restarted by you", seq);
  assert.equal(d.get(id).state, "running");
  assert.equal((await d.reconcile(id)).state, "running");
  // The new run finishes.
  worker.finish("thr_1", "result_available");
  assert.equal((await d.reconcile(id)).state, "result_available");
});
