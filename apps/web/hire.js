// Hire an agent: a step-by-step dialog that makes a staff member (apps/hub/src/staff.ts).
//
//   1. Start      from a Role template, from scratch, by importing an agent file, or connect a
//                 computer whose T3 is already set up (address + pairing code)
//   2. Who        name, job, and the computer whose floor it sits on
//   3. Brain      harness and model, from what that computer's T3 reports
//   4. Soul       its role's, none, an existing one, or a new one
//   5. Tools      Kits, plus MCP servers and skills already set up on this computer
//   6. Review     how it will look in the office, then hire

const NAMES = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Hedy", "Ken", "Barbara", "Dennis", "Frances", "Edsger", "Radia", "Bjarne", "Katherine", "Guido", "Joan"];
const STEPS = [
  ["start", "Start"],
  ["who", "Who"],
  ["brain", "Brain"],
  ["soul", "Soul"],
  ["tools", "Tools"],
  ["review", "Review"],
];
// Claude Code agent files name a model family; pick the newest model of that family T3 offers.
const MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"];
const INSTANCE = { claude: "claudeAgent", codex: "codex", opencode: "opencode" };
const STARTER_SOUL = `You are calm, careful and direct. You read before you write, prefer the smallest change that works,
and say plainly what you did not check. You keep your reports short.`;

let ctx = null; // { h, api, toast, getState, onHired }
let dialog = null;
let w = null; // wizard state
let options = null; // GET /api/hire/options

export function setupHire(c) {
  ctx = c;
  dialog = document.createElement("dialog");
  dialog.className = "hire";
  dialog.addEventListener("cancel", () => (w = null));
  document.body.append(dialog);
}

/** Open the wizard. `preset.worker` puts the new agent on that floor. */
export async function openHire(preset = {}) {
  const state = ctx.getState();
  const used = new Set(state.staff.map((s) => s.displayName));
  const worker = preset.worker ?? state.workers.find((x) => x.local)?.name ?? state.workers.find((x) => x.online)?.name ?? state.workers[0]?.name ?? "";
  w = {
    step: "start",
    from: null,
    role: null,
    imported: null,
    importText: "",
    displayName: NAMES.find((n) => !used.has(n)) ?? "",
    title: "",
    description: "",
    duties: "",
    worker,
    runtime: null,
    model: "",
    soulKind: "none",
    soulPick: "",
    soulText: "",
    kits: new Set(),
    mcp: new Set(),
    skills: new Set(),
    connect: { name: "", url: "", code: "" },
    busy: false,
  };
  options = null;
  render();
  dialog.showModal();
  try {
    options = await ctx.api("GET", "/api/hire/options");
  } catch (e) {
    options = { souls: [], mcp: [], skills: [], agents: [], error: e.message };
  }
  if (w) render();
}

function close() {
  w = null;
  dialog.close();
}

const state = () => ctx.getState();
const roleOf = (name) => state().roles.find((r) => r.name === name);
const workerOf = () => state().workers.find((x) => x.name === w.worker);

/** Harnesses the chosen computer's T3 has signed in, with their models. */
function harnesses() {
  const wk = workerOf();
  return Object.entries(state().harnesses).map(([id, hz]) => {
    const p = wk?.providers.find((x) => x.id === INSTANCE[id]);
    return { id, ...hz, available: !!p || !wk?.providers.length, models: p?.models ?? [] };
  });
}

function pickModel(runtime, hint) {
  const models = harnesses().find((x) => x.id === runtime)?.models ?? [];
  if (hint && models.includes(hint)) return hint;
  const alias = MODEL_ALIASES.find((a) => (hint ?? "").toLowerCase().includes(a));
  if (alias) return models.find((m) => m.includes(alias)) ?? "";
  return "";
}

/** Fill the later steps from the chosen starting point. */
function applyStart() {
  const firstHarness = harnesses().find((x) => x.available)?.id ?? "claude";
  if (w.from === "template") {
    const r = roleOf(w.role);
    w.title = r.title;
    w.description = r.description;
    w.runtime = harnesses().find((x) => x.id === r.preferred && x.available) ? r.preferred : firstHarness;
    w.model = pickModel(w.runtime, r.model);
    w.soulKind = "role";
    w.kits = new Set(r.kits.default);
  } else {
    const imported = w.from === "import" ? importSource() : null;
    w.title = imported?.title ?? "";
    w.description = imported?.description ?? "";
    w.runtime = firstHarness;
    w.model = imported?.model ? pickModel("claude", imported.model) : "";
    if (imported?.model && w.model) w.runtime = "claude";
    w.soulKind = "write";
    w.soulText = imported?.body || STARTER_SOUL;
    // Handoff is how Studio reads what the agent did; Guardrails keeps routine commands from asking.
    w.kits = new Set(["handoff", "guardrails"].filter((k) => state().kits.some((x) => x.name === k)));
  }
}

/** The agent being imported: a found file, or pasted/uploaded text. */
function importSource() {
  if (w.imported !== null && options?.agents[w.imported]) {
    const a = options.agents[w.imported];
    return { title: titleCase(a.name), description: a.description, model: a.model, body: a.body };
  }
  const text = w.importText.trim();
  if (!text) return null;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { title: meta.name ? titleCase(meta.name) : "", description: meta.description ?? "", model: meta.model ?? null, body: (m ? m[2] : text).trim() };
}

const titleCase = (s) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ------------------------------------------------------------------ rendering

function render() {
  if (!w) return;
  const { h } = ctx;
  const idx = STEPS.findIndex(([k]) => k === w.step);
  const body = {
    start: stepStart,
    who: stepWho,
    brain: stepBrain,
    soul: stepSoul,
    tools: stepTools,
    review: stepReview,
    connect: stepConnect,
  }[w.step]();
  const crumbs = w.step === "connect"
    ? h("div", { class: "hire-steps" }, h("span", { class: "on" }, "Connect a computer"))
    : h(
        "div",
        { class: "hire-steps" },
        STEPS.map(([k, label], i) => h("span", { class: i === idx ? "on" : i < idx ? "done" : "" }, `${i + 1}. ${label}`)),
      );
  const problem = blocker();
  const back = w.step !== "start" ? h("button", { type: "button", class: "secondary", onclick: () => go(-1) }, "Back") : null;
  const next =
    w.step === "review"
      ? h("button", { type: "button", class: "ok", disabled: w.busy, onclick: hire }, w.busy ? "Hiring…" : `Hire ${w.displayName || "agent"}`)
      : w.step === "connect"
        ? h("button", { type: "button", disabled: !!problem || w.busy, onclick: connect }, w.busy ? "Connecting…" : "Connect")
        : h("button", { type: "button", disabled: !!problem, onclick: () => go(1) }, "Next");
  dialog.replaceChildren(
    h(
      "div",
      { class: "hire-box" },
      h("div", { class: "hire-head" }, h("h2", {}, "Hire an agent"), h("button", { type: "button", class: "ghost", title: "Close", onclick: close }, "✕")),
      crumbs,
      h("div", { class: "hire-body" }, body),
      h("div", { class: "hire-foot" }, h("span", { class: "muted" }, problem ?? ""), h("span", { class: "row" }, back, next)),
    ),
  );
}

/** Why Next is disabled, in words; null when the step is complete. */
function blocker() {
  switch (w.step) {
    case "start":
      if (!w.from) return "Choose how to start";
      if (w.from === "template" && !w.role) return "Pick a role";
      if (w.from === "import" && !importSource()) return "Pick or paste an agent to import";
      if (w.from !== "connect" && !state().workers.length) return "Connect a computer first: agents run on a computer's T3";
      return null;
    case "who":
      if (!w.displayName.trim()) return "Give it a name";
      if (w.from !== "template" && !w.title.trim()) return "Give the job a title";
      if (!w.worker) return "Pick a computer";
      return null;
    case "brain":
      return w.runtime ? null : "Pick a harness";
    case "soul":
      if (w.soulKind === "pick" && !w.soulPick) return "Pick a soul";
      return null;
    case "connect": {
      const c = w.connect;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(c.name)) return "Name: lowercase letters, digits and dashes";
      if (!c.url.trim() || !c.code.trim()) return "Enter the address and pairing code";
      return null;
    }
    default:
      return null;
  }
}

function go(delta) {
  if (w.step === "connect") {
    w.step = "start";
    w.from = null;
    return render();
  }
  const idx = STEPS.findIndex(([k]) => k === w.step);
  if (w.step === "start" && delta > 0) applyStart();
  w.step = STEPS[Math.min(STEPS.length - 1, Math.max(0, idx + delta))][0];
  render();
}

/** A text input bound to a wizard field; re-renders only the footer so typing keeps focus. */
function field(key, props = {}, multiline = false) {
  const { h } = ctx;
  const get = () => key.split(".").reduce((o, k) => o[k], w);
  const set = (v) => {
    const keys = key.split(".");
    const last = keys.pop();
    keys.reduce((o, k) => o[k], w)[last] = v;
  };
  return h(multiline ? "textarea" : "input", {
    ...props,
    value: multiline ? undefined : get(),
    oninput: (e) => {
      set(e.target.value);
      refreshFoot();
    },
  }, multiline ? get() : null);
}

function refreshFoot() {
  const problem = blocker();
  const foot = dialog.querySelector(".hire-foot");
  if (!foot) return;
  foot.querySelector(".muted").textContent = problem ?? "";
  const next = foot.querySelector("button:last-child");
  if (next && w.step !== "review") next.disabled = !!problem;
}

function choice(selected, onclick, ...children) {
  return ctx.h("button", { type: "button", class: `choice${selected ? " on" : ""}`, onclick }, ...children);
}

function stepStart() {
  const { h } = ctx;
  const pick = (from) => () => {
    w.from = from;
    if (from === "connect") w.step = "connect";
    render();
  };
  const kinds = h(
    "div",
    { class: "choices four" },
    choice(w.from === "template", pick("template"), h("strong", {}, "From a template"), h("span", {}, "Start from a ready-made role, like Software Engineer or QA Lead, and adjust it.")),
    choice(w.from === "scratch", pick("scratch"), h("strong", {}, "From scratch"), h("span", {}, "Describe a new job, then choose its brain, soul and tools.")),
    choice(w.from === "import", pick("import"), h("strong", {}, "Import"), h("span", {}, "Bring in an agent you already wrote, such as a Claude Code agent file (.md).")),
    choice(false, pick("connect"), h("strong", {}, "Connect a computer"), h("span", {}, "Its T3 is already running: enter its address and pairing code. Its agents work there.")),
  );
  let more = null;
  if (w.from === "template") {
    const groups = new Map();
    for (const r of state().roles.filter((r) => !["critic", "integrator", "producer"].includes(r.name))) {
      if (!groups.has(r.department)) groups.set(r.department, []);
      groups.get(r.department).push(r);
    }
    more = h(
      "div",
      { class: "stack" },
      h("h3", {}, "Which role?"),
      h(
        "div",
        { class: "choices" },
        [...groups.values()].flat().map((r) =>
          choice(w.role === r.name, () => ((w.role = r.name), render()), h("strong", {}, r.title), h("em", {}, r.department), h("span", {}, r.description)),
        ),
      ),
    );
  }
  if (w.from === "import") {
    const found = options?.agents ?? [];
    more = h(
      "div",
      { class: "stack" },
      h("h3", {}, "Agents found on this computer"),
      options === null
        ? h("p", { class: "muted" }, "Looking…")
        : found.length
          ? h(
              "div",
              { class: "choices" },
              found.map((a, i) =>
                choice(w.imported === i, () => ((w.imported = w.imported === i ? null : i), render()), h("strong", {}, a.name), h("em", {}, a.source), h("span", {}, a.description || "(no description)")),
              ),
            )
          : h("p", { class: "muted" }, "No Claude Code agents found (~/.claude/agents/*.md or a project's .claude/agents/)."),
      h("h3", {}, "Or paste one"),
      field("importText", { rows: 6, placeholder: "---\nname: release-notes\ndescription: Writes release notes from merged changes\nmodel: sonnet\n---\nYou are…" }, true),
      h(
        "label",
        { class: "muted" },
        "…or open a file: ",
        h("input", {
          type: "file",
          accept: ".md,.markdown,.txt",
          onchange: async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            w.importText = await f.text();
            w.imported = null;
            render();
          },
        }),
      ),
    );
  }
  return h("div", { class: "stack" }, h("p", { class: "lead" }, "How do you want to start?"), kinds, more);
}

function stepConnect() {
  const { h } = ctx;
  return h(
    "div",
    { class: "stack" },
    h(
      "p",
      { class: "lead" },
      "Connect a computer that already runs T3. Its floor appears in the office, and you can hire agents to work there.",
    ),
    h(
      "p",
      { class: "muted" },
      "On that computer: install Studio and run ",
      h("code", {}, "studio join <link>"),
      " (no code needed), or run ",
      h("code", {}, "t3 serve --host 0.0.0.0 --port 3773"),
      " and copy the pairing code it prints.",
    ),
    h("label", {}, "Name", field("connect.name", { placeholder: "desktop" })),
    h("label", {}, "Address", field("connect.url", { placeholder: "192.168.1.50:3773" })),
    h("label", {}, "Pairing code", field("connect.code", { placeholder: "from t3 serve, or t3 auth pairing create" })),
  );
}

function stepWho() {
  const { h } = ctx;
  const role = w.from === "template" ? roleOf(w.role) : null;
  const workers = state().workers;
  return h(
    "div",
    { class: "stack" },
    h("label", {}, "Name", field("displayName", { placeholder: "Ada" })),
    role
      ? h("div", { class: "card" }, h("strong", {}, role.title), h("div", { class: "muted" }, role.description))
      : [
          h("label", {}, "Job title", field("title", { placeholder: "Release Notes Writer" })),
          h("label", {}, "What it does", field("description", { rows: 2, placeholder: "Writes clear release notes from the merged changes since the last tag." }, true)),
          h("label", {}, "Duties and hard rules (optional)", field("duties", { rows: 3, placeholder: "- Never push\n- Keep each note to one line" }, true)),
        ],
    h(
      "label",
      {},
      "Works on",
      h(
        "select",
        { onchange: (e) => ((w.worker = e.target.value), render()) },
        workers.map((x) => h("option", { value: x.name, selected: x.name === w.worker }, `${x.name}${x.local ? " (this computer)" : ""}${x.online ? "" : " — offline"}`)),
      ),
    ),
    h("p", { class: "muted" }, "It sits on this computer's floor when it has no job. A job runs on the computer that has its project."),
  );
}

function stepBrain() {
  const { h } = ctx;
  const list = harnesses();
  const current = list.find((x) => x.id === w.runtime);
  const wk = workerOf();
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "lead" }, "Which harness runs it?"),
    h(
      "p",
      { class: "muted" },
      wk?.providers.length
        ? `What T3 on ${wk.name} has signed in${wk.online ? "" : " (last known; it is offline now)"}.`
        : `T3 on ${w.worker || "this computer"} has not reported its harnesses yet, so every harness is shown.`,
    ),
    h(
      "div",
      { class: "choices three" },
      list.map((x) =>
        choice(
          w.runtime === x.id,
          () => x.available && ((w.runtime = x.id), (w.model = pickModel(x.id, w.model)), render()),
          h("strong", {}, h("span", { class: "dot", style: `background:${x.color}` }), x.label),
          h("em", {}, x.vendor),
          h("span", {}, x.available ? (x.models.length ? `${x.models.length} model${x.models.length === 1 ? "" : "s"}` : "default model") : "not signed in on this computer"),
        ),
      ),
    ),
    current
      ? h(
          "label",
          {},
          "Model",
          h(
            "select",
            { onchange: (e) => ((w.model = e.target.value), render()) },
            h("option", { value: "" }, `${current.label}'s default`),
            current.models.map((m) => h("option", { value: m, selected: m === w.model }, m)),
          ),
        )
      : null,
  );
}

function stepSoul() {
  const { h } = ctx;
  const role = w.from === "template" ? roleOf(w.role) : null;
  const roleSoul = role ? options?.souls.find((s) => s.id === `role:${role.name}`) : null;
  const souls = options?.souls ?? [];
  const kind = (k, title, desc) => choice(w.soulKind === k, () => ((w.soulKind = k), render()), h("strong", {}, title), h("span", {}, desc));
  const picked = souls.find((s) => s.id === w.soulPick);
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "lead" }, "Its soul: personality and how it works."),
    h(
      "div",
      { class: "choices four" },
      role ? kind("role", `${role.title}'s`, roleSoul ? "The role's own personality." : "This role has no soul file; same as none.") : null,
      kind("pick", "Use an existing one", `${souls.length} soul${souls.length === 1 ? "" : "s"} in your studio.`),
      kind("write", "Write a new one", "In your own words. Saved as a soul.md you can edit."),
      kind("none", "None", "Just the job and its rules."),
    ),
    w.soulKind === "role" && roleSoul ? h("pre", { class: "soul" }, roleSoul.text) : null,
    w.soulKind === "pick"
      ? h(
          "div",
          { class: "stack" },
          h(
            "select",
            { onchange: (e) => ((w.soulPick = e.target.value), render()) },
            h("option", { value: "" }, options === null ? "Loading…" : "Pick a soul…"),
            souls.map((s) => h("option", { value: s.id, selected: s.id === w.soulPick }, s.label)),
          ),
          picked ? h("pre", { class: "soul" }, picked.text) : null,
          picked ? h("button", { type: "button", class: "secondary", onclick: () => ((w.soulText = picked.text), (w.soulKind = "write"), render()) }, "Copy it and edit") : null,
        )
      : null,
    w.soulKind === "write" ? field("soulText", { rows: 9 }, true) : null,
  );
}

function stepTools() {
  const { h } = ctx;
  const toggle = (set, name) => () => {
    set.has(name) ? set.delete(name) : set.add(name);
    render();
  };
  const kits = state().kits;
  const WIDGETS = { clipboard: "📋", shield: "🛡️", magnifier: "🔍", notebook: "📓", scales: "⚖️", gamepad: "🎮", cards: "🗂️", toolbox: "🧰" };
  const NOTE = { handoff: "Recommended: Studio reads its end-of-job report.", guardrails: "Recommended: routine commands run without asking." };
  const check = (on, onchange, title, sub, note) =>
    h(
      "label",
      { class: `tool${on ? " on" : ""}` },
      h("input", { type: "checkbox", checked: on, onchange }),
      h("span", {}, h("strong", {}, title), sub ? h("span", { class: "muted" }, sub) : null, note ? h("em", {}, note) : null),
    );
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "lead" }, "What does it carry?"),
    h("h3", {}, "Kits"),
    h(
      "div",
      { class: "tools" },
      kits.map((k) =>
        check(
          w.kits.has(k.name),
          toggle(w.kits, k.name),
          `${WIDGETS[k.widget] ?? WIDGETS.toolbox} ${k.title}`,
          [k.description, k.skills.length ? `Skills: ${k.skills.join(", ")}` : "", k.mcp?.length ? `MCP: ${k.mcp.join(", ")}` : ""].filter(Boolean).join(" · "),
          NOTE[k.name],
        ),
      ),
    ),
    h("h3", {}, "MCP servers on this computer"),
    options === null
      ? h("p", { class: "muted" }, "Looking…")
      : options.mcp.length
        ? h("div", { class: "tools" }, options.mcp.map((m) => check(w.mcp.has(m.name), toggle(w.mcp, m.name), m.name, `${m.summary} · ${m.source}`)))
        : h("p", { class: "muted" }, "None found in Claude Code (~/.claude.json) or Claude Desktop."),
    h("h3", {}, "Skills on this computer"),
    options === null
      ? h("p", { class: "muted" }, "Looking…")
      : options.skills.length
        ? h("div", { class: "tools" }, options.skills.map((s) => check(w.skills.has(s.name), toggle(w.skills, s.name), s.name, `${s.description || "(no description)"} · ${s.source}`)))
        : h("p", { class: "muted" }, "None found in ~/.claude/skills, ~/.codex/skills or ~/.agents/skills."),
    w.mcp.size || w.skills.size
      ? h("p", { class: "muted" }, `These are copied into a Kit of its own (${w.displayName || "agent"}'s tools), so they work on Codex and OpenCode too.`)
      : null,
  );
}

function stepReview() {
  const { h } = ctx;
  const hz = state().harnesses[w.runtime];
  const soul = { role: "its role's", none: "none", pick: options?.souls.find((s) => s.id === w.soulPick)?.label ?? "?", write: "its own (new)" }[w.soulKind];
  const kitTitles = [...w.kits].map((k) => state().kits.find((x) => x.name === k)?.title ?? k);
  const extra = [...w.mcp].map((m) => `MCP ${m}`).concat([...w.skills].map((s) => `skill ${s}`));
  const role = w.from === "template" ? roleOf(w.role) : null;
  return h(
    "div",
    { class: "hire-review" },
    ctx.agentCard({ role: role?.name ?? null, title: role?.title ?? w.title, provider: w.runtime, model: w.model || null, kits: [...w.kits] }),
    h(
      "dl",
      {},
      h("dt", {}, "Name"), h("dd", {}, w.displayName),
      h("dt", {}, "Job"), h("dd", {}, role ? role.title : `${w.title} (a new role)`),
      h("dt", {}, "Works on"), h("dd", {}, w.worker),
      h("dt", {}, "Brain"), h("dd", {}, `${hz?.label ?? w.runtime} · ${w.model || "default model"}`),
      h("dt", {}, "Soul"), h("dd", {}, soul),
      h("dt", {}, "Tools"), h("dd", {}, [...kitTitles, ...extra].join(", ") || "none"),
    ),
  );
}

// ------------------------------------------------------------------ actions

async function hire() {
  w.busy = true;
  render();
  const soul =
    w.soulKind === "role" ? { kind: "role" }
    : w.soulKind === "none" ? { kind: "none" }
    : { kind: "text", text: w.soulKind === "pick" ? options.souls.find((s) => s.id === w.soulPick)?.text ?? "" : w.soulText };
  try {
    const member = await ctx.api("POST", "/api/staff", {
      displayName: w.displayName.trim(),
      worker: w.worker,
      from: w.from,
      ...(w.from === "template" ? { role: w.role } : { title: w.title, description: w.description, duties: w.duties }),
      runtime: w.runtime,
      model: w.model || null,
      soul,
      kits: [...w.kits],
      mcp: [...w.mcp],
      skills: [...w.skills],
    });
    close();
    ctx.toast(`${member.displayName} joined the studio`, true);
    await ctx.onHired(member);
  } catch (e) {
    w.busy = false;
    render();
    ctx.toast(e.message);
  }
}

async function connect() {
  w.busy = true;
  render();
  const c = w.connect;
  try {
    await ctx.api("POST", "/api/workers", { name: c.name, url: c.url.trim(), code: c.code.trim() });
    ctx.toast(`Connected ${c.name}. Now hire someone to work there.`, true);
    await ctx.onHired(null);
    const worker = c.name;
    await openHire({ worker });
  } catch (e) {
    w.busy = false;
    render();
    ctx.toast(e.message);
  }
}
