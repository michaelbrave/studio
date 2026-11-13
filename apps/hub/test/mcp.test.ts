import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Hub } from "../src/hub.ts";
import { handleMcp } from "../src/mcp.ts";

const responses: unknown[] = [];
const fakeHub = {
  state: async () => ({
    workers: [{ name: "local", online: true, error: null }],
    roles: [{ name: "engineer", title: "Software Engineer" }],
    jobs: [{ title: "Add double jump", attempts: [{ id: "att1", state: "awaiting_input", role: "engineer", worker: "local" }] }],
    cards: [],
    scene: { agents: [{ roleTitle: "Software Engineer", jobTitle: "Add double jump", floor: "local", status: "needs you", doing: null, attemptId: "att1" }] },
  }),
  attempt: async () => ({ attempt: { state: "awaiting_input", worker: "local" }, history: [], messages: [], requests: [{ id: "req1", kind: "command", summary: "$ npm install three" }] }),
  respond: async (...args: unknown[]) => void responses.push(args),
} as unknown as Hub;

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b ? JSON.parse(b) : undefined));
  });
}

test("Hermes can read what is waiting and answer it; others can't get in", async () => {
  const server = createServer(async (req, res) => handleMcp(fakeHub, "tok", req, res, await body(req))).listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
  try {
    const noToken = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noToken.status, 401);
    const fromBrowser = await fetch(url, { method: "POST", headers: { authorization: "Bearer tok", origin: "https://evil.example" }, body: "{}" });
    assert.equal(fromBrowser.status, 401);

    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer tok" } } }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["studio_brief", "studio_job", "studio_respond", "studio_status", "studio_waiting"]);
    assert.equal(tools.find((t) => t.name === "studio_respond")!.annotations?.readOnlyHint, false);
    const waiting = (await client.callTool({ name: "studio_waiting", arguments: {} })) as { content: Array<{ text: string }> };
    assert.match(waiting.content[0]!.text, /attempt att1, request req1.*\n  \$ npm install three/);
    await client.callTool({ name: "studio_respond", arguments: { attemptId: "att1", requestId: "req1", decision: "accept" } });
    assert.deepEqual(responses, [["att1", "req1", "accept", "from Discord (Hermes)"]]);
    await client.close();
  } finally {
    server.close();
  }
});
