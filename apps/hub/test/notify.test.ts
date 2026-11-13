import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { diffEvents, Notifier, signedRequest, type AttemptView } from "../src/notify.ts";

const view = (id: string, state: string, over: Partial<AttemptView> = {}): AttemptView => ({
  id,
  state,
  worker: "local",
  roleTitle: "Software Engineer",
  jobTitle: "Add double jump",
  jobKind: "work",
  verdict: null,
  error: null,
  ...over,
});

test("only announced states make events, each once", () => {
  const first = diffEvents(new Map(), [view("a", "running"), view("b", "awaiting_input"), view("c", "result_available")], () => "$ npm install");
  assert.deepEqual(first.events.map((e) => e.event_type), ["attempt.awaiting_input", "attempt.result_available"]);
  assert.match(first.events[0]!.message, /needs you.*\n> \$ npm install\nReply here/);
  const again = diffEvents(first.next, [view("b", "awaiting_input"), view("c", "result_available")]);
  assert.equal(again.events.length, 0);
});

test("going back to work makes the same state news again", () => {
  let prev = diffEvents(new Map(), [view("a", "awaiting_input")]).next;
  prev = diffEvents(prev, [view("a", "running")]).next;
  assert.equal(diffEvents(prev, [view("a", "awaiting_input")]).events.length, 1);
});

test("review results say what the reviewer decided", () => {
  const { events } = diffEvents(new Map(), [view("r", "result_available", { jobKind: "review", roleTitle: "Code Critic", verdict: "APPROVE" })]);
  assert.match(events[0]!.message, /Code Critic\*\* approved it/);
});

test("requests are signed the way Hermes checks generic V2 webhooks", () => {
  const event = { id: "x", event_type: "attempt.failed", attempt_id: "a", worker: "local", message: "hi" };
  const { init } = signedRequest({ url: "http://h/webhooks/studio", secret: "s3cret" }, event, 1_700_000_000_000);
  const expected = createHmac("sha256", "s3cret").update(`1700000000.${init.body}`).digest("hex");
  assert.equal(init.headers["X-Webhook-Timestamp"], "1700000000");
  assert.equal(init.headers["X-Webhook-Signature-V2"], expected);
});

test("the first run records the present silently, then sends changes", async () => {
  const got: string[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      got.push(JSON.parse(b).event_type);
      res.end("{}");
    });
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  try {
    const n = new Notifier(openDb(), { url: `http://127.0.0.1:${port}/webhooks/studio`, secret: "s" });
    const workers = [{ name: "local", online: true }];
    await n.check([view("old", "result_available")], workers, async () => undefined);
    assert.deepEqual(got, []);
    await n.check([view("old", "result_available"), view("new", "awaiting_input")], [{ name: "local", online: false }], async () => "rm -rf build");
    assert.deepEqual(got.sort(), ["attempt.awaiting_input", "worker.offline"]);
  } finally {
    server.close();
  }
});
