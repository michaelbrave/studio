import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCard, serializeCard, type Card } from "../src/board.ts";
import { openDb, type Job } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { Vault } from "../src/vault.ts";

const ROOT = join(import.meta.dirname, "../../..");

/** A hub with a temporary vault and no workers: enough to drive the workflow from recorded results. */
async function setup() {
  const vault = new Vault(join(mkdtempSync(join(tmpdir(), "studio-vault-")), "vault"));
  await vault.init();
  const hub = new Hub(openDb(), { roles: join(ROOT, "roles"), kits: join(ROOT, "kits") }, vault);
  hub.dispatcher["workers"]["local"] = {} as never; // createAttempt only checks the worker is known
  const finished = (kind: Job["kind"], role: string, extra: Partial<Job> = {}) => {
    const jobId = hub.dispatcher.createJob({ project: "p1", title: `${kind} job`, brief: "do it", kind, ...extra });
    const attemptId = hub.dispatcher.createAttempt(jobId, "local", { role, kits: [], provider: "claude", model: "m1", snapshot: "s" });
    hub.db.prepare("UPDATE attempts SET state = 'result_available', thread_id = 't' WHERE id = ?").run(attemptId);
    return { jobId, attemptId, job: () => hub.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as unknown as Job };
  };
  return { hub, vault, finished };
}

test("a card survives a round trip through its markdown file", () => {
  const card: Card = {
    id: "card-1",
    title: "Design the jump",
    column: "ready",
    project: "local/p1",
    role: "game-designer",
    priority: "high",
    jobs: ["job_1"],
    createdBy: "you",
    created: "2026-10-28T00:00:00.000Z",
    body: "Write it.\n\nAcceptance criteria:\n- exists",
  };
  assert.deepEqual(parseCard(serializeCard(card)), card);
});

test("a producer's plan becomes proposed cards; unknown roles are left unassigned", async () => {
  const { hub, finished } = await setup();
  const { attemptId, job } = finished("planning", "producer");
  const plan = [
    "```cards",
    "- title: Design the jump",
    "  role: game-designer",
    "  description: Write it.",
    "- title: Paint the sky",
    "  role: sky-painter",
    "```",
    "## Handoff",
    "Status: done",
  ].join("\n");
  await hub.workflow.onResult(hub.dispatcher.get(attemptId), job(), { status: "done" }, plan);
  const cards = await hub.workflow.board.list();
  assert.deepEqual(cards.map((c) => [c.title, c.column, c.role]), [
    ["Design the jump", "proposed", "game-designer"],
    ["Paint the sky", "proposed", ""],
  ]);
  assert.equal(cards[0]!.project, "local/p1");
});

test("a merged integration marks its job integrated; any other outcome does not", async () => {
  const { hub, finished } = await setup();
  const work = finished("work", "engineer");
  hub.workflow.accept(work.jobId);
  const merge = finished("integration", "integrator", { targetJob: work.jobId } as never);
  hub.db.prepare("UPDATE jobs SET target_job = ? WHERE id = ?").run(work.jobId, merge.jobId);
  await hub.workflow.onResult(hub.dispatcher.get(merge.attemptId), merge.job(), { outcome: "TESTS FAILED" }, "");
  assert.equal(work.job().milestone, "accepted");
  await hub.workflow.onResult(hub.dispatcher.get(merge.attemptId), merge.job(), { outcome: "MERGED", commit: "abc1234def" }, "");
  assert.equal(work.job().milestone, "integrated");
  assert.equal(work.job().integrated_commit, "abc1234def");
});

test("accepting needs a result, and integrating needs acceptance", async () => {
  const { hub, finished } = await setup();
  const jobId = hub.dispatcher.createJob({ project: "p1", title: "t", brief: "b" });
  hub.dispatcher.createAttempt(jobId, "local");
  assert.throws(() => hub.workflow.accept(jobId), /no result/);
  const done = finished("work", "engineer");
  await assert.rejects(hub.workflow.integrate(done.jobId), /accept the result/);
});

test("job notes and rating feedback reach the next agent's memory brief", async () => {
  const { hub, vault, finished } = await setup();
  const { attemptId, job } = finished("work", "engineer");
  await hub.workflow.onResult(hub.dispatcher.get(attemptId), job(), { status: "done", commit: "abc1234", notes: "used a lookup table" }, "final");
  await hub.workflow.rate(attemptId, [{ category: "coding", stars: 4, note: "clean, but name things better" }]);
  const role = (await import("@studio/kits")).loadRole(join(ROOT, "roles/engineer"));
  const brief = await hub.workflow.memoryBrief("local", "p1", (await role).manifest);
  assert.match(brief, /work job/);
  assert.match(brief, /used a lookup table/);
  assert.match(brief, /name things better/);
  assert.match((await vault.read(`raw/jobs/${attemptId.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`))!, /## Final message\n\nfinal/);
  // The vault is a git repo and the hub commits what changed.
  await vault.commit();
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: vault.dir, encoding: "utf8" }), "");
});

test("the board follows its card's latest job", async () => {
  const { hub, finished } = await setup();
  const card = await hub.workflow.createCard({ project: "local/p1", title: "Add clamp", role: "engineer" });
  const { jobId, attemptId } = finished("work", "engineer");
  await hub.workflow.linkCard(card.id, jobId);
  await hub.workflow.tick();
  assert.equal((await hub.workflow.board.get(card.id)).column, "review");
  hub.workflow.reject(jobId, "wrong approach");
  await hub.workflow.tick();
  assert.equal((await hub.workflow.board.get(card.id)).column, "ready");
  hub.db.prepare("UPDATE attempts SET state = 'failed' WHERE id = ?").run(attemptId);
  hub.db.prepare("UPDATE jobs SET milestone = NULL WHERE id = ?").run(jobId);
  await hub.workflow.tick();
  assert.equal((await hub.workflow.board.get(card.id)).column, "blocked");
});

test("leaderboard averages are pulled towards the category mean until there are enough ratings", async () => {
  const { hub, finished } = await setup();
  const one = finished("work", "engineer");
  await hub.workflow.rate(one.attemptId, [{ category: "coding", stars: 5 }]);
  const two = finished("work", "engineer");
  hub.db.prepare("UPDATE attempts SET provider = 'codex', model = 'm2' WHERE id = ?").run(two.attemptId);
  await hub.workflow.rate(two.attemptId, [{ category: "coding", stars: 1 }]);
  const [coding] = hub.workflow.leaderboard();
  assert.equal(coding!.category, "coding");
  assert.equal(coding!.byModel[0]!.setup, "Claude Code · m1");
  // mean 3, prior weight 3: (5 + 9) / 4 = 3.5, not a raw 5.
  assert.equal(coding!.byModel[0]!.average, 3.5);
  await assert.rejects(hub.workflow.rate(one.attemptId, [{ category: "coding", stars: 6 }]), /1 to 5/);
});
