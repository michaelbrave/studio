import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScene, bubbleFor, LINGER_MS, REVIEW_WAIT_MS, type SceneInput } from "../src/index.ts";

const NOW = 10_000_000;

function input(jobs: SceneInput["jobs"], over: Partial<SceneInput> = {}): SceneInput {
  return {
    now: NOW,
    workers: [{ name: "local", online: true, error: null, local: true }],
    roles: [
      { name: "engineer", title: "Software Engineer", department: "Programming" },
      { name: "critic", title: "Code Critic", department: "Review" },
      { name: "producer", title: "Producer", department: "Production" },
    ],
    kits: [{ name: "guardrails", title: "Guardrails", widget: "shield" }],
    harnesses: { claude: { label: "Claude Code", vendor: "Anthropic", color: "#D97757" } },
    cards: [],
    activity: {},
    ...over,
    jobs,
  };
}

let n = 0;
function job(state: string, extra: Partial<SceneInput["jobs"][number]> = {}, attempt: Record<string, unknown> = {}) {
  n++;
  return {
    id: `job${n}`,
    title: `Job ${n}`,
    kind: "work",
    milestone: null,
    reviews_attempt: null,
    ...extra,
    attempts: [
      {
        id: `att${n}`,
        worker: "local",
        state,
        role: "engineer",
        kits: '["guardrails"]',
        provider: "claude",
        model: "claude-opus-5-5",
        verdict: null,
        created_at: NOW - 1000 + n,
        last_observed_at: NOW - 500,
        ...attempt,
      },
    ],
  };
}

test("an agent wears its role, harness colour and model, and has its kits on the desk", () => {
  const scene = buildScene(input([job("running")]));
  const [a] = scene.agents;
  assert.equal(a!.roleTitle, "Software Engineer");
  assert.equal(a!.harness.color, "#D97757");
  assert.equal(a!.harness.vendor, "Anthropic");
  assert.equal(a!.model, "claude-opus-5-5");
  assert.deepEqual(a!.kits.map((k) => k.widget), ["shield"]);
  assert.equal(a!.desk, 0);
});

test("states map to distinct poses and bubbles; unknown is never shown as working", () => {
  const scene = buildScene(
    input([job("running"), job("awaiting_input"), job("status_unknown"), job("capacity_paused"), job("result_available")]),
  );
  assert.deepEqual(
    scene.agents.map((a) => [a.pose, a.bubble]),
    [
      ["working", "dots"],
      ["waiting", "exclamation"],
      ["unknown", "question"],
      ["break", "sleep"],
      ["done", "star"],
    ],
  );
});

test("agents on an unreachable machine show as offline, not working", () => {
  const scene = buildScene(input([job("running")], { workers: [{ name: "local", online: false, error: "fetch failed", local: true }] }));
  assert.equal(scene.agents[0]!.pose, "offline");
  assert.equal(scene.agents[0]!.bubble, "plug");
  assert.equal(scene.floors[0]!.online, false);
});

test("activity picks the working bubble but never changes the pose", () => {
  assert.equal(bubbleFor("working", { kind: "command_execution", title: "$ npm test" }), "bars");
  assert.equal(bubbleFor("working", { kind: "file_change", title: null }), "dots");
  assert.equal(bubbleFor("waiting", { kind: "command_execution", title: "$ npm test" }), "exclamation");
});

test("agents keep their desks when others leave", () => {
  const a = job("running");
  const b = job("running");
  const first = buildScene(input([a, b]));
  assert.deepEqual(Object.values(first.seats), [0, 1]);
  const second = buildScene(input([b]), first.seats);
  assert.equal(second.agents[0]!.desk, 1, "b stays at desk 1 instead of moving to 0");
});

test("a reviewer stands at the desk of the work it reviews; a producer at the wall board", () => {
  const work = job("result_available");
  const review = job("running", { kind: "review", reviews_attempt: work.attempts[0]!.id }, { role: "critic" });
  const plan = job("running", { kind: "planning" }, { role: "producer" });
  const scene = buildScene(input([work, review, plan]));
  const critic = scene.agents.find((x) => x.role === "critic")!;
  assert.deepEqual(critic.visiting, { attemptId: work.attempts[0]!.id });
  assert.equal(critic.desk, null);
  assert.deepEqual(scene.agents.find((x) => x.role === "producer")!.visiting, { place: "board" });
});

test("work you have decided on goes home at once; results and failures wait for you", () => {
  const recent = { last_observed_at: NOW - LINGER_MS - 1 };
  const failed = job("failed", {}, recent);
  const waitingForYou = job("result_available", {}, recent);
  const accepted = job("result_available", { milestone: "accepted" }, { last_observed_at: NOW - 1000 });
  const stopped = job("stopped", {}, { last_observed_at: NOW - 1000 });
  const scene = buildScene(input([failed, waitingForYou, accepted, stopped]));
  assert.deepEqual(scene.agents.map((a) => a.jobId).sort(), [failed.id, waitingForYou.id].sort());
});

test("opening a result, or enough time, lets its agent move on; it stays on the to-review list", () => {
  const seen = job("result_available", {}, { seen_at: NOW - 10 });
  const old = job("result_available", {}, { last_observed_at: NOW - REVIEW_WAIT_MS - 1 });
  const oldFail = job("failed", {}, { last_observed_at: NOW - REVIEW_WAIT_MS - 1 });
  const scene = buildScene(input([seen, old, oldFail]));
  assert.deepEqual(scene.agents, []);
  assert.deepEqual(scene.toReview.map((r) => r.jobId).sort(), [seen.id, old.id].sort());
});

test("a hired agent is free again as soon as you accept its work", () => {
  const accepted = job("result_available", { milestone: "accepted" }, { staff: "ada" });
  const scene = buildScene(input([accepted], { staff: [ADA] }));
  assert.equal(scene.agents.length, 1);
  assert.equal(scene.agents[0]!.pose, "idle");
  assert.deepEqual(scene.toReview, []);
});

test("a cross-check says what it found, not that it waits for your review, and leaves after a while", () => {
  const review = job("result_available", { kind: "review" }, { role: "critic", verdict: "APPROVE" });
  const scene = buildScene(input([review]));
  assert.equal(scene.agents[0]!.status, "cross-check done: approved");
  assert.deepEqual(scene.toReview, []);
  const later = job("result_available", { kind: "review" }, { role: "critic", last_observed_at: NOW - LINGER_MS - 1 });
  assert.deepEqual(buildScene(input([later])).agents, []);
});

test("cards are pinned to the wall by column", () => {
  const scene = buildScene(
    input([], {
      cards: [
        { id: "c1", title: "A", column: "doing", role: "engineer", project: "local/p" },
        { id: "c2", title: "B", column: "backlog", role: "", project: "local/p" },
      ],
    }),
  );
  assert.deepEqual(Object.keys(scene.wall).sort(), ["backlog", "doing"]);
});

test("a working agent shows its latest activity line; other states show none", () => {
  const run = job("running");
  const wait = job("awaiting_input");
  const scene = buildScene(
    input([run, wait], {
      activity: {
        [run.attempts[0]!.id]: { kind: "command_execution", title: `npm   test ${"x".repeat(80)}` },
        [wait.attempts[0]!.id]: { kind: "command_execution", title: "rm -rf build" },
      },
    }),
  );
  const [a, b] = scene.agents;
  assert.ok(a!.doing!.startsWith("npm test x"));
  assert.equal(a!.doing!.length, 60);
  assert.equal(b!.doing, null);
  assert.equal(buildScene(input([job("running")])).agents[0]!.doing, null);
});

const ADA = { name: "ada", displayName: "Ada", role: "engineer", worker: "local", runtime: "claude", model: "claude-opus-5-5", kits: ["guardrails"] };

test("a hired agent with no job sits at a desk, free, under its own name", () => {
  const scene = buildScene(input([], { staff: [ADA] }));
  const [a] = scene.agents;
  assert.equal(a!.attemptId, "staff:ada");
  assert.equal(a!.name, "Ada");
  assert.equal(a!.pose, "idle");
  assert.equal(a!.bubble, null);
  assert.equal(a!.desk, 0);
  assert.equal(a!.roleTitle, "Software Engineer");
});

test("a hired agent keeps its desk and looks when it takes a job", () => {
  const idle = buildScene(input([], { staff: [ADA] }));
  const other = job("running");
  const working = buildScene(input([other, job("running", {}, { staff: "ada" })], { staff: [ADA] }), { ...idle.seats });
  const ada = working.agents.find((a) => a.staff === "ada")!;
  const idleAda = idle.agents[0]!;
  assert.notEqual(ada.attemptId, "staff:ada");
  assert.equal(ada.pose, "working");
  assert.equal(ada.desk, idleAda.desk);
  assert.equal(ada.look, idleAda.look);
  assert.equal(working.agents.filter((a) => a.staff === "ada").length, 1); // not also idle
});

test("an idle agent on a machine that is down shows as offline", () => {
  const scene = buildScene(input([], { staff: [ADA], workers: [{ name: "local", online: false, error: "down", local: true }] }));
  assert.equal(scene.agents[0]!.pose, "offline");
});
