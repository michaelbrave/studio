import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { BriefLog, briefDue, composeBrief, dayKey, scheduledAt, type BriefInput, type LogRow } from "../src/brief.ts";

const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 7 + dayOffset, h, m).getTime();
const row = (over: Partial<LogRow>): LogRow => ({
  attemptId: "a1",
  at: at(2),
  fromState: "running",
  toState: "result_available",
  reason: "turn completed",
  roleTitle: "Software Engineer",
  jobTitle: "Add double jump",
  worker: "local",
  jobKind: "work",
  verdict: null,
  ...over,
});
const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  now: at(8),
  since: at(8, 0, -1),
  log: [],
  waiting: [],
  toReview: [],
  working: [],
  proposedCards: 0,
  board: {},
  workers: [{ name: "local", online: true }],
  ...over,
});

test("a quiet night says so, and still reports where things stand", () => {
  const text = composeBrief(input({ workers: [{ name: "local", online: true }, { name: "windows-pc", online: false }] }));
  assert.match(text, /Studio brief\*\* · since yesterday 08:00/);
  assert.match(text, /Nothing finished, failed or merged\./);
  assert.match(text, /Offline: windows-pc/);
});

test("what happened is counted once per attempt, from real transitions only", () => {
  const text = composeBrief(
    input({
      log: [
        row({}),
        row({ fromState: "result_available", toState: "result_available", reason: "Kit overlay removed" }),
        row({ attemptId: "r1", jobKind: "review", roleTitle: "Code Critic", verdict: "APPROVE" }),
        row({ attemptId: "f1", toState: "failed", jobTitle: "Port to Windows" }),
        row({ fromState: "result_available", toState: "result_available", reason: "you accepted the result" }),
        row({ fromState: "result_available", toState: "result_available", reason: "integrated as 1a2b3c4d5e" }),
        row({ attemptId: "p1", toState: "capacity_paused" }),
        row({ attemptId: "p1", fromState: "capacity_paused", toState: "running" }),
        row({ attemptId: "p1", fromState: "running", toState: "capacity_paused" }),
      ],
    }),
  );
  assert.match(text, /✅ Finished \(1\)\n  • Software Engineer “Add double jump” · local/);
  assert.match(text, /🔍 Reviews \(1\)\n  • Code Critic approved “Add double jump”/);
  assert.match(text, /❌ Failed \(1\)/);
  assert.match(text, /👍 You accepted \(1\)/);
  assert.match(text, /🔀 Integrated \(1\)\n  • “Add double jump” \(1a2b3c4d5e\)/);
  assert.match(text, /☕ Usage limits hit: 1/);
});

test("the now section lists waiting, review and working, and long lists are cut", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ roleTitle: "Engineer", jobTitle: `Card ${i}`, worker: "local" }));
  const text = composeBrief(input({ waiting: many.slice(0, 1), working: many, proposedCards: 3, board: { ready: 2, done: 5, proposed: 3 } }));
  assert.match(text, /🙋 Waiting for you \(1\)/);
  assert.match(text, /🛠️ Working \(9\)[\s\S]*\+3 more/);
  assert.match(text, /3 proposed cards to approve/);
  assert.match(text, /Board: 2 ready · 5 done/);
  assert.ok(composeBrief(input({ working: Array(400).fill(many[0]) })).length <= 1900);
});

test("the brief goes out at its time, catches up for a few hours, then skips the day", () => {
  assert.equal(scheduledAt(undefined, at(12)), at(8));
  assert.equal(scheduledAt("7:30", at(12)), at(7, 30));
  assert.equal(scheduledAt(false, at(12)), null);
  assert.equal(scheduledAt("25:00", at(12)), null);
  assert.equal(briefDue(undefined, at(7, 59), false), false);
  assert.equal(briefDue(undefined, at(8), false), true);
  assert.equal(briefDue(undefined, at(11, 30), false), true);
  assert.equal(briefDue(undefined, at(12, 30), false), false);
  assert.equal(briefDue(undefined, at(9), true), false);
  assert.equal(briefDue(false, at(9), false), false);
});

test("sent briefs are remembered across restarts", () => {
  const db = openDb(":memory:");
  const log = new BriefLog(db);
  assert.equal(log.lastAt(at(8)), at(8, 0, -1));
  log.record(dayKey(at(8)), at(8, 1));
  assert.equal(new BriefLog(db).sent(dayKey(at(9))), true);
  assert.equal(log.lastAt(at(9)), at(8, 1));
});
