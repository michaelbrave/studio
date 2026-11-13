import assert from "node:assert/strict";
import { test } from "node:test";
import { describeToolCall } from "../src/hub.ts";

// Shapes recorded from T3 turn items during the Tetris test run.
const ref = { nativeId: "toolu_1" };

test("a command approval shows the command", () => {
  const s = describeToolCall({ id: "turn-item:provider:x", type: "command_execution", input: "git commit -qm hi", nativeItemRef: ref });
  assert.equal(s, "$ git commit -qm hi");
});

test("a file read approval shows the file", () => {
  const s = describeToolCall({
    id: "turn-item:provider:x",
    type: "dynamic_tool",
    toolName: "Read",
    title: "Read /tmp/out/3-paused.png",
    input: { file_path: "/tmp/out/3-paused.png" },
    nativeItemRef: ref,
  });
  assert.match(s, /^Read \/tmp\/out\/3-paused\.png/);
});

test("a file write approval shows the path and says the content is not shown", () => {
  const s = describeToolCall({ id: "turn-item:provider:x", type: "file_change", fileName: "/tmp/check.js", nativeItemRef: ref });
  assert.match(s, /^Write \/tmp\/check\.js/);
  assert.match(s, /not shown/);
});

test("an unknown item falls back to nothing, so the timeline summary is used", () => {
  assert.equal(describeToolCall({ id: "turn-item:provider:x", type: "reasoning" }), "");
});
