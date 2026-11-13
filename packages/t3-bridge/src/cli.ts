// npm run probe -- pair <worker> <mcp-url> <pairing-code>   sign in to a worker's T3 (one-time)
// npm run probe -- snapshot <worker>             record the worker's tool surface for compatibility checks
// npm run probe -- call <worker> <tool> [json]   call one T3 MCP tool and print the result

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { T3Worker } from "./worker.ts";

const [command, name, ...rest] = process.argv.slice(2);
if (!command || !name) {
  console.error("usage: probe pair <worker> <mcp-url> <pairing-code> | snapshot <worker> | call <worker> <tool> [json-args]");
  process.exit(2);
}

const worker =
  command === "pair" ? await T3Worker.pair(name, rest[0] ?? usage(), rest[1] ?? usage()) : await T3Worker.connect(name);
try {
  if (command === "pair") {
    console.log(`signed in to ${name}; ${(await worker.listTools()).length} tools available`);
  } else if (command === "snapshot") {
    const tools = await worker.listTools();
    const snapshot = {
      worker: name,
      takenAt: new Date().toISOString(),
      // Without the machine's ID and name, so snapshots can be shared.
      environment: anonymize(await worker.call("t3_environment_read").catch((e: Error) => ({ error: e.message }))),
      tools: tools
        .map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint ?? false, inputSchema: t.inputSchema }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    const dir = join(import.meta.dirname, "../../../docs/stage0");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${name}-surface.json`);
    await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n");
    for (const t of snapshot.tools) console.log(`  ${t.readOnly ? "read " : "write"} ${t.name}`);
    console.log(`wrote ${file}`);
  } else if (command === "call") {
    const [tool, json] = rest;
    if (!tool) usage();
    console.log(JSON.stringify(await worker.call(tool, json ? JSON.parse(json) : {}), null, 2));
  } else {
    usage();
  }
} finally {
  await worker.close();
}

function anonymize(env: unknown): unknown {
  const text = JSON.stringify(env, (k, v) => (k === "environmentId" || k === "label" || k === "machine" ? undefined : v));
  return text === undefined ? env : JSON.parse(text);
}

function usage(): never {
  console.error("usage: probe pair <worker> <mcp-url> <pairing-code> | snapshot <worker> | call <worker> <tool> [json-args]");
  process.exit(2);
}
