import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileLoadout, loadLoadout } from "@studio/kits";
import { discoverAgents, discoverTools, frontMatter, slug, Staff } from "../src/staff.ts";

const ROOT = join(import.meta.dirname, "../../..");
const BUILTIN = { roles: join(ROOT, "roles"), kits: join(ROOT, "kits") };
const KNOWN = { roles: ["engineer", "critic"], kits: ["handoff", "guardrails", "code-review"], workers: ["local"] };

/** A Studio home and a user home with one MCP server, one skill and one Claude Code agent. */
function setup() {
  const studio = mkdtempSync(join(tmpdir(), "studio-home-"));
  const user = mkdtempSync(join(tmpdir(), "studio-user-"));
  writeFileSync(
    join(user, ".claude.json"),
    JSON.stringify({
      mcpServers: { docs: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "secret" } } },
      projects: { [join(user, "proj")]: { mcpServers: { web: { type: "http", url: "https://example.test/mcp" } } } },
    }),
  );
  mkdirSync(join(user, ".claude/skills/uuid-dir/release-notes"), { recursive: true });
  writeFileSync(join(user, ".claude/skills/uuid-dir/release-notes/SKILL.md"), "---\nname: release-notes\ndescription: Write release notes\n---\nSteps…\n");
  mkdirSync(join(user, ".claude/agents"), { recursive: true });
  writeFileSync(join(user, ".claude/agents/tester.md"), "---\nname: tester\ndescription: Writes tests\nmodel: sonnet\n---\nYou love edge cases.\n");
  return { studio, user, staff: new Staff(studio, BUILTIN, user) };
}

test("names become kebab-case ids", () => {
  assert.equal(slug("Ada Lovelace"), "ada-lovelace");
  assert.equal(slug("  Zoë!  "), "zoe");
  assert.equal(slug("!!!"), "agent");
});

test("front matter is split from the body, and a file without it is all body", () => {
  assert.deepEqual(frontMatter("---\nname: x\n---\nhello"), { meta: { name: "x" }, body: "hello" });
  assert.deepEqual(frontMatter("just text"), { meta: {}, body: "just text" });
});

test("tools, skills and agents already set up on this computer are found", async () => {
  const { user } = setup();
  const { mcp, skills } = await discoverTools(user);
  assert.deepEqual(mcp.map((m) => [m.name, m.summary]), [["docs", "npx -y docs-mcp"], ["web", "https://example.test/mcp"]]);
  assert.equal(skills[0]!.name, "release-notes");
  const agents = await discoverAgents(user);
  assert.equal(agents[0]!.name, "tester");
  assert.equal(agents[0]!.model, "sonnet");
  assert.equal(agents[0]!.body, "You love edge cases.");
});

test("hiring from a template keeps the role and gives the agent its own soul", async () => {
  const { staff, studio } = setup();
  const m = await staff.hire(
    { displayName: "Ada", worker: "local", from: "template", role: "engineer", runtime: "codex", model: "gpt-x", soul: { kind: "text", text: "Brutally honest." }, kits: ["handoff", "code-review"] },
    KNOWN,
  );
  assert.equal(m.name, "ada");
  assert.equal(m.role, "engineer");
  assert.equal(m.soul, "own");
  assert.equal(await staff.soulOverride(m), "Brutally honest.\n");
  assert.deepEqual(await staff.get("ada"), m);
  // A second Ada gets her own id.
  const again = await staff.hire({ displayName: "Ada", worker: "local", from: "template", role: "engineer", runtime: "claude", soul: { kind: "none" } }, KNOWN);
  assert.equal(again.name, "ada-2");
  assert.equal(await staff.soulOverride(again), "");
  assert.deepEqual((await staff.list()).map((s) => s.name), ["ada", "ada-2"]);
  assert.match(readFileSync(join(studio, "staff/ada/staff.yaml"), "utf8"), /role: engineer/);
});

test("hiring from scratch makes a role and a tools kit that the compiler can equip", async () => {
  const { staff } = setup();
  const m = await staff.hire(
    {
      displayName: "Rita",
      worker: "local",
      from: "scratch",
      title: "Release Notes Writer",
      description: "Writes release notes.",
      duties: "- Never push",
      runtime: "claude",
      soul: { kind: "text", text: "Concise." },
      kits: ["handoff"],
      mcp: ["docs"],
      skills: ["release-notes"],
    },
    KNOWN,
  );
  assert.equal(m.role, "release-notes-writer");
  assert.equal(m.soul, "role"); // the soul went into the new role
  assert.deepEqual(m.kits, ["handoff", "rita-tools"]);

  const loadout = await loadLoadout({ rolesDir: [BUILTIN.roles, staff.rolesDir], kitsDir: [BUILTIN.kits, staff.kitsDir], role: m.role, kits: m.kits, anyKits: true });
  assert.equal(loadout.role.soul, "Concise.\n");
  assert.equal(loadout.role.rules, "- Never push\n");
  assert.deepEqual(Object.keys(loadout.mcpServers), ["docs"]);
  assert.ok(loadout.skills.has("release-notes"));
  const out = compileLoadout({ loadout, provider: "claude", existing: () => undefined, staff: { name: m.displayName } });
  assert.ok(out.launchable);
  assert.match(out.files.find((f) => f.path === ".claude/rules/studio-role.md")!.content, /# Your role: Release Notes Writer \(Rita\)/);
});

test("a bad hire writes nothing", async () => {
  const { staff } = setup();
  await assert.rejects(staff.hire({ displayName: "", worker: "local", from: "template", role: "engineer", runtime: "claude", soul: { kind: "role" } }, KNOWN), /name/);
  await assert.rejects(staff.hire({ displayName: "X", worker: "nowhere", from: "template", role: "engineer", runtime: "claude", soul: { kind: "role" } }, KNOWN), /computer/);
  await assert.rejects(staff.hire({ displayName: "X", worker: "local", from: "scratch", runtime: "claude", soul: { kind: "role" } }, KNOWN), /title/);
  await assert.rejects(staff.hire({ displayName: "X", worker: "local", from: "template", role: "engineer", runtime: "claude", soul: { kind: "role" }, mcp: ["nope"] }, KNOWN), /not found/);
  assert.deepEqual(await staff.list(), []);
});

test("letting someone go removes them", async () => {
  const { staff } = setup();
  await staff.hire({ displayName: "Ken", worker: "local", from: "template", role: "engineer", runtime: "claude", soul: { kind: "role" } }, KNOWN);
  await staff.fire("ken");
  assert.deepEqual(await staff.list(), []);
  await assert.rejects(staff.fire("ken"), /no staff member/);
});
