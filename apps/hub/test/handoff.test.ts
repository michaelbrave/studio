import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCards, parseHandoff, sameCommit } from "../src/handoff.ts";

test("parses the handoff block an agent ends with", () => {
  const text = "I did it.\n\n```\n## Handoff\nStatus: done\nCommit: 34883D02ED6809cb7af61316b8dd990672f89830\nVerdict: CHANGES REQUESTED\nAcceptance:\n- [x] ok\n```";
  assert.deepEqual(parseHandoff(text), {
    status: "done",
    commit: "34883d02ed6809cb7af61316b8dd990672f89830",
    verdict: "CHANGES REQUESTED",
  });
});

test("tolerates markdown emphasis, prose around values, and missing fields", () => {
  const text = "## Handoff\n**Status:** partial (tests flaky)\n**Commit:** `f3abdac` on t3/x\n";
  assert.deepEqual(parseHandoff(text), { status: "partial", commit: "f3abdac" });
  assert.deepEqual(parseHandoff("## Handoff\nCommit: none\n"), {});
  assert.equal(parseHandoff("no report here"), undefined);
  // Fields written without the heading still count (agents without the Handoff Kit do this).
  assert.deepEqual(parseHandoff("Merged.\n\nCommit: e591381e40a8\n\nOutcome: MERGED\n"), { commit: "e591381e40a8", outcome: "MERGED" });
});

test("the last handoff block wins", () => {
  const text = "## Handoff\nVerdict: APPROVE\n\nlater...\n## Handoff\nVerdict: CHANGES REQUESTED\n";
  assert.equal(parseHandoff(text)?.verdict, "CHANGES REQUESTED");
});

test("abbreviated and full shas of the same commit match; short or different ones do not", () => {
  assert.ok(sameCommit("34883d0", "34883d02ed6809cb7af61316b8dd990672f89830"));
  assert.ok(!sameCommit("34883d0", "f3abdace0f57"));
  assert.ok(!sameCommit("348", "34883d02ed"));
});

test("integrator outcome and reviewer notes are parsed", () => {
  const text = "## Handoff\nStatus: blocked\nOutcome: TESTS FAILED (2 failures)\nNotes for the reviewer: clamp.test.js fails on main\n";
  assert.deepEqual(parseHandoff(text), { status: "blocked", outcome: "TESTS FAILED", notes: "clamp.test.js fails on main" });
});

test("the producer's cards block becomes proposed cards; bad entries are skipped", () => {
  const text = [
    "Plan below.",
    "```cards",
    "- title: Design the jump",
    "  role: game-designer",
    "  priority: high",
    "  description: |",
    "    Write the jump section.",
    "",
    "    Acceptance criteria:",
    "    - design/jump.md exists",
    "- title: Implement the jump",
    "  role: gameplay-programmer",
    "  depends_on: [Design the jump]",
    "- just a string",
    "```",
    "## Handoff",
    "Status: done",
  ].join("\n");
  const cards = parseCards(text);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.priority, "high");
  assert.match(cards[0]!.description, /Acceptance criteria/);
  assert.deepEqual(cards[1]!.dependsOn, ["Design the jump"]);
  assert.equal(cards[1]!.priority, "normal");
  assert.deepEqual(parseCards("no plan"), []);
});
