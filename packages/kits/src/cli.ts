// npm run kit:compile -- <role> [--kits a,b] --provider claude|codex [--apply <worktree> | --remove <worktree>]
// Without --apply, prints the plan: files, runtime mode, and the capability report.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { applyOverlay, compileLoadout, loadLoadout, PROVIDERS, removeOverlay, scanWorktree, type Provider } from "./index.ts";

const ROOT = join(import.meta.dirname, "../../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", default: "claude" },
    kits: { type: "string" },
    apply: { type: "string" },
    remove: { type: "string" },
    staff: { type: "string" },
  },
});

if (values.remove) {
  const leaked = await removeOverlay(values.remove);
  if (leaked.length > 0) {
    console.error(`overlay removed, but Kit files are in the git index: ${leaked.join(", ")}`);
    process.exit(1);
  }
  console.log("overlay removed; no Kit files in the git index");
  process.exit(0);
}

const [role] = positionals;
const provider = values.provider as Provider;
if (!role || !PROVIDERS.includes(provider)) {
  console.error("usage: kit:compile <role> [--kits a,b] --provider claude|codex [--apply <worktree> | --remove <worktree>]");
  process.exit(2);
}

const loadout = await loadLoadout({
  rolesDir: join(ROOT, "roles"),
  kitsDir: join(ROOT, "kits"),
  role,
  ...(values.kits !== undefined ? { kits: values.kits.split(",").filter(Boolean) } : {}),
});
const existing = values.apply ? await scanWorktree(values.apply) : () => undefined;
const result = compileLoadout({ loadout, provider, existing, ...(values.staff ? { staff: { name: values.staff } } : {}) });

const r = loadout.role.manifest;
console.log(`${r.title} (${r.name}@${r.version}) with ${loadout.kits.map((k) => k.manifest.title).join(", ") || "no kits"} → ${provider} [${loadout.snapshot}]`);
console.log(`runtime mode: ${result.runtimeMode}${result.model ? `, model: ${result.model}` : ""}`);
for (const x of result.report) console.log(`  ${x.status.padEnd(11)} ${x.feature}${x.reason ? ` — ${x.reason}` : ""}`);
for (const f of result.files) console.log(`  write ${f.path}${f.original !== undefined ? " (overlay)" : ""}`);

if (values.apply) {
  await applyOverlay(values.apply, result, loadout.snapshot);
  console.log(`applied to ${values.apply}`);
} else if (!result.launchable) {
  process.exit(1);
}
