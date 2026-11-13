import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyOverlay,
  compileLoadout,
  KitValidationError,
  loadLoadout,
  parseKitManifest,
  parseRoleManifest,
  removeOverlay,
  scanWorktree,
} from "../src/index.ts";

const ROOT = join(import.meta.dirname, "../../..");
const none = () => undefined;
const loadout = (role: string, kits?: string[]) =>
  loadLoadout({ rolesDir: join(ROOT, "roles"), kitsDir: join(ROOT, "kits"), role, ...(kits ? { kits } : {}) });

test("role manifest validation lists every issue", () => {
  assert.throws(
    () => parseRoleManifest({ name: "Bad Name", runtime: { preferred: "gpt" }, permissions: { preset: "yolo" } }),
    (e: unknown) =>
      e instanceof KitValidationError &&
      e.issues.includes("name must be kebab-case") &&
      e.issues.includes("version is required") &&
      e.issues.some((i) => i.startsWith("runtime.preferred")) &&
      e.issues.some((i) => i.startsWith("permissions.preset")),
  );
});

test("kit manifest validation rejects bad skill names", () => {
  assert.throws(() => parseKitManifest({ name: "x", version: "1", skills: ["Bad Skill"] }), /kebab-case/);
});

test("every built-in role loads with its default kits, with a stable snapshot", async () => {
  for (const role of ["engineer", "critic", "game-designer", "gameplay-programmer", "qa-lead", "creative-director"]) {
    const a = await loadout(role);
    const b = await loadout(role);
    assert.equal(a.snapshot, b.snapshot);
    assert.ok(a.skills.has("handoff-report"), `${role} should carry the handoff kit`);
  }
});

test("a role can equip its optional kits, but not kits it does not list", async () => {
  const designer = await loadout("game-designer", ["handoff", "design-docs", "balance"]);
  assert.ok(designer.skills.has("balance-check"));
  await assert.rejects(loadout("critic", ["handoff", "guardrails"]), /cannot equip: guardrails/);
});

test("equipped kits change the snapshot, and their permissions merge with the role's", async () => {
  const plain = await loadout("engineer", ["handoff"]);
  const guarded = await loadout("engineer", ["handoff", "guardrails"]);
  assert.notEqual(plain.snapshot, guarded.snapshot);
  assert.deepEqual(plain.permissions.deny, ["Bash(git push*)"]);
  assert.ok(guarded.permissions.deny.includes("Bash(git push*)"));
  assert.ok(guarded.permissions.deny.includes("Bash(git reset --hard*)"));
});

test("claude: instructions compose with the project's CLAUDE.md instead of replacing it", async () => {
  const lo = await loadout("engineer");
  const result = compileLoadout({
    loadout: lo,
    provider: "claude",
    existing: (p) => (p === "CLAUDE.md" ? { tracked: true, content: "project rules" } : undefined),
  });
  assert.ok(result.launchable);
  assert.ok(!result.files.some((f) => f.path === "CLAUDE.md"));
  const rules = result.files.find((f) => f.path === ".claude/rules/studio-role.md");
  assert.match(rules!.content, /Software Engineer/);
  const settings = JSON.parse(result.files.find((f) => f.path === ".claude/settings.local.json")!.content);
  assert.ok(settings.permissions.deny.includes("Bash(git push*)"));
  assert.match(rules!.content, /## Your equipped Kits[\s\S]*### Guardrails/);
  assert.equal(result.runtimeMode, "auto-accept-edits");
});

test("codex: its sandbox stands in for deny rules, and the gap is reported", async () => {
  const lo = await loadout("engineer");
  const result = compileLoadout({ loadout: lo, provider: "codex", existing: none });
  assert.equal(result.launchable, true);
  const perms = result.report.find((r) => r.feature === "permissions")!;
  assert.equal(perms.status, "degraded");
  assert.match(perms.reason!, /deleting or editing files inside the job folder/);
  assert.match(perms.reason!, /reading secrets/);
  assert.match(perms.reason!, /untracked files cannot/);
  assert.equal(result.model, undefined, "the role's Claude model must not be sent to Codex");
});

test("codex: deny rules with no sandbox (full access) block launch", async () => {
  const lo = await loadout("engineer");
  const unsandboxed = { ...lo, permissions: { ...lo.permissions, preset: "full-access" as const } };
  const result = compileLoadout({ loadout: unsandboxed, provider: "codex", existing: none });
  assert.equal(result.launchable, false);
  assert.match(result.report.find((r) => r.feature === "permissions")!.reason!, /unsandboxed/);
});

test("codex: AGENTS.override.md carries the project's AGENTS.md plus the Kit", async () => {
  const lo = await loadout("critic");
  const result = compileLoadout({
    loadout: lo,
    provider: "codex",
    existing: (p) => (p === "AGENTS.md" ? { tracked: true, content: "# Project\nuse pnpm" } : undefined),
  });
  assert.ok(result.launchable);
  const override = result.files.find((f) => f.path === "AGENTS.override.md")!.content;
  assert.ok(override.startsWith("# Project\nuse pnpm"));
  assert.match(override, /Code Critic/);
  // The critic reviews in its own disposable worktree, so it runs sandboxed workspace-write.
  assert.equal(result.runtimeMode, "auto-accept-edits");
});

test("a tracked target file is never planned for writing", async () => {
  const lo = await loadout("engineer");
  const result = compileLoadout({
    loadout: lo,
    provider: "claude",
    existing: (p) => (p === ".claude/settings.local.json" ? { tracked: true, content: "{}" } : undefined),
  });
  assert.ok(!result.files.some((f) => f.path === ".claude/settings.local.json"));
  assert.equal(result.report.find((r) => r.feature === "permissions")?.status, "unsupported");
  assert.equal(result.launchable, false);
});

test("memory brief is bounded and truncation is reported", async () => {
  const lo = await loadout("engineer");
  const result = compileLoadout({ loadout: lo, provider: "claude", existing: none, memoryBrief: "x".repeat(500), memoryBudgetChars: 100 });
  assert.equal(result.report.find((r) => r.feature === "memory")?.status, "degraded");
  assert.match(result.files[0]!.content, /truncated at 100 characters/);
});

test("overlay applies, stays out of git status, and restores untracked originals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-overlay-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  sh("init", "-q");
  writeFileSync(join(dir, "README.md"), "hi\n");
  sh("add", ".");
  sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));

  const lo = await loadout("engineer");
  const result = compileLoadout({ loadout: lo, provider: "claude", existing: await scanWorktree(dir) });
  await applyOverlay(dir, result, lo.snapshot);

  assert.ok(existsSync(join(dir, ".claude/rules/studio-role.md")));
  const merged = JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8"));
  assert.equal(merged.permissions.allow[0], "Read", "the worktree's own allow rules are kept, first");
  assert.ok(merged.permissions.allow.includes("Bash(git commit *)"));
  assert.ok(merged.permissions.deny.includes("Bash(git push*)"));
  assert.equal(sh("status", "--porcelain"), "", "kit files must not show up as changes");
  await assert.rejects(applyOverlay(dir, result), /already applied/);

  assert.deepEqual(await removeOverlay(dir), []);
  assert.ok(!existsSync(join(dir, ".claude/rules/studio-role.md")));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")), { permissions: { allow: ["Read"] } });
});

test("removeOverlay reports Kit files an agent force-added to the index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-overlay-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  sh("init", "-q");
  const lo = await loadout("engineer");
  await applyOverlay(dir, compileLoadout({ loadout: lo, provider: "claude", existing: await scanWorktree(dir) }));
  sh("add", "-f", ".claude/rules/studio-role.md");
  assert.deepEqual(await removeOverlay(dir), [".claude/rules/studio-role.md"]);
});

test("opencode: everything goes under .opencode/, with the role wired in as an instruction", async () => {
  const lo = await loadout("engineer");
  const result = compileLoadout({ loadout: lo, provider: "opencode", existing: none });
  assert.equal(result.launchable, true);
  assert.ok(result.files.every((f) => f.path.startsWith(".opencode/")), "nothing outside .opencode/");
  const config = JSON.parse(result.files.find((f) => f.path === ".opencode/opencode.json")!.content);
  assert.deepEqual(config.instructions, [".opencode/studio-role.md"]);
  assert.match(result.files.find((f) => f.path === ".opencode/studio-role.md")!.content, /# Your role: Software Engineer/);
  const perms = result.report.find((r) => r.feature === "permissions")!;
  assert.equal(perms.status, "degraded");
  assert.match(perms.reason!, /approval prompts/);
  assert.equal(result.model, undefined, "the role's Claude model must not be sent to OpenCode");
});

test("opencode: deny rules in full access block launch; a tracked .opencode config does too", async () => {
  const lo = await loadout("engineer");
  const open = { ...lo, permissions: { ...lo.permissions, preset: "full-access" as const } };
  assert.equal(compileLoadout({ loadout: open, provider: "opencode", existing: none }).launchable, false);
  const tracked = compileLoadout({
    loadout: lo,
    provider: "opencode",
    existing: (p) => (p === ".opencode/opencode.json" ? { content: "{}", tracked: true } : undefined),
  });
  assert.equal(tracked.launchable, false);
  assert.ok(!tracked.files.some((f) => f.path === ".opencode/opencode.json"));
});

test("opencode: MCP servers use OpenCode's shape and {env:VAR} references", async () => {
  const lo = await loadout("engineer");
  const withMcp = {
    ...lo,
    mcpServers: {
      docs: { type: "http" as const, url: "https://x/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
      local: { type: "stdio" as const, command: "npx", args: ["-y", "thing"] },
    },
  };
  const config = JSON.parse(compileLoadout({ loadout: withMcp, provider: "opencode", existing: none }).files.find((f) => f.path === ".opencode/opencode.json")!.content);
  assert.deepEqual(config.mcp.docs, { type: "remote", url: "https://x/mcp", enabled: true, headers: { Authorization: "Bearer {env:DOCS_TOKEN}" } });
  assert.deepEqual(config.mcp.local, { type: "local", command: ["npx", "-y", "thing"], enabled: true });
});
