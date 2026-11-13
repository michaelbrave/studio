import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadLoadout } from "@studio/kits";
import type { T3Rpc } from "@studio/t3-bridge";
import { deliverKitRemote } from "../src/remoteKit.ts";

const ROOT = join(import.meta.dirname, "../../..");
const loadout = (role: string) => loadLoadout({ rolesDir: join(ROOT, "roles"), kitsDir: join(ROOT, "kits"), role });

/** Stands in for T3's project file RPCs over an in-memory worktree. */
function fakeRpc(files: Record<string, string>) {
  const writes: string[] = [];
  const rpc = {
    async call(method: string, input: { relativePath?: string; contents?: string; directoryPath?: string }) {
      if (method === "projects.readFile") {
        const contents = files[input.relativePath!];
        if (contents === undefined) throw new Error("realpath-target");
        return { contents };
      }
      if (method === "projects.writeFile") {
        files[input.relativePath!] = input.contents!;
        writes.push(input.relativePath!);
        return {};
      }
      if (method === "projects.listEntries") {
        const roots = new Set(Object.keys(files).map((p) => p.split("/")[0]!));
        return { entries: [...roots].map((path) => ({ path })) };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as T3Rpc;
  return { rpc, files, writes };
}

test("claude: new .claude folder is hidden by its own .gitignore, written first", async () => {
  const { rpc, files, writes } = fakeRpc({ "README.md": "hi" });
  await deliverKitRemote({ rpc, worktree: "/wt", loadout: await loadout("engineer"), provider: "claude" });
  assert.equal(writes[0], ".claude/.gitignore");
  assert.match(files[".claude/.gitignore"]!, /^\*$/m);
  assert.ok(files[".claude/rules/studio-role.md"]?.includes("Software Engineer"));
  assert.equal(files["README.md"], "hi");
});

test("refuses when the project already has the folder, since it cannot be hidden", async () => {
  const { rpc, writes } = fakeRpc({ ".claude/commands/x.md": "project file" });
  await assert.rejects(
    deliverKitRemote({ rpc, worktree: "/wt", loadout: await loadout("engineer"), provider: "claude" }),
    /cannot keep .* out of git/,
  );
  assert.deepEqual(writes, [], "nothing written before refusing");
});

test("codex: a root-level AGENTS.override.md is refused on remote workers", async () => {
  const { rpc, writes } = fakeRpc({ "README.md": "hi" });
  await assert.rejects(
    deliverKitRemote({ rpc, worktree: "/wt", loadout: await loadout("critic"), provider: "codex" }),
    /AGENTS\.override\.md/,
  );
  assert.deepEqual(writes, []);
});
