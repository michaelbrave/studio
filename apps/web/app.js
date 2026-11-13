// Studio web UI: the office view (office.js), the task board, and the job list and detail panel.

import * as office2d from "./office.js";

// The 3D office (office3d.js) when WebGL works; the flat 2D one otherwise, or with ?flat.
const office = await (async () => {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl || new URLSearchParams(location.search).has("flat")) return office2d;
  try {
    return await import("./office3d.js");
  } catch (e) {
    console.error("3D office failed to load; using the 2D one", e);
    return office2d;
  }
})();
const { mountOffice, setOfficeVisible, updateOffice } = office;


const $ = (sel) => document.querySelector(sel);
let state = null;
let selected = null;

/** Build an element. Text is always set as text, never HTML: agent output is untrusted. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function toast(message, ok = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = ok ? "ok" : "";
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ok ? 2500 : 8000);
}

const STATE_LABEL = {
  queued: "queued",
  preparing: "preparing",
  running: "working",
  awaiting_input: "needs you",
  capacity_paused: "on a break",
  status_unknown: "unknown",
  stopped: "stopped",
  failed: "failed",
  result_available: "ready for review",
};
// Placeholder glyphs until the pixel-art office: each Kit's widget on the desk.
const WIDGETS = { clipboard: "📋", shield: "🛡️", magnifier: "🔍", notebook: "📓", scales: "⚖️", gamepad: "🎮", cards: "🗂️", toolbox: "🧰" };

/** Hat = role, shirt = harness colour with vendor and model, desk = equipped kits. */
function agentCard({ role, provider, model, kits }, mini = false) {
  const r = state.roles.find((x) => x.name === role);
  const harness = state.harnesses[provider] ?? { label: provider ?? "?", vendor: "", color: "#555" };
  return h(
    "div",
    { class: `agent${mini ? " mini" : ""}`, title: `${r?.title ?? role} · ${harness.label} · ${model ?? "default model"}` },
    h("div", { class: "hat" }, r?.title ?? role ?? "?"),
    h("div", { class: "head" }),
    h(
      "div",
      { class: "shirt", style: `background:${harness.color}` },
      h("span", { class: "vendor" }, harness.vendor),
      mini ? null : (model ?? "default model"),
    ),
    h(
      "div",
      { class: "desk" },
      (kits ?? []).map((name) => {
        const k = state.kits.find((x) => x.name === name);
        return h("span", { class: "widget", title: k ? `${k.title}: ${k.description}` : name }, WIDGETS[k?.widget] ?? WIDGETS.toolbox);
      }),
    ),
  );
}

const badge = (s) => h("span", { class: `badge s-${s}` }, STATE_LABEL[s] ?? s);
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function setOptions(select, options, keep = true) {
  const prev = select.value;
  select.replaceChildren(...options.map(([value, label]) => h("option", { value }, label)));
  if (keep && options.some(([v]) => v === prev)) select.value = prev;
}

function render() {
  const online = state.workers.filter((w) => w.online).length;
  $("#status").textContent = `${online}/${state.workers.length} workers online`;

  $("#workers").replaceChildren(
    ...state.workers.map((w) =>
      h(
        "li",
        {},
        h("span", {}, h("span", { class: "dot", style: `background:var(${w.online ? "--ok" : "--bad"})` }), w.name),
        h("span", { class: "muted" }, w.online ? w.providers.map((p) => p.id).join(", ") || "no agents signed in" : w.error ?? "offline"),
      ),
    ),
    ...(state.workers.length ? [] : [h("li", { class: "muted" }, "No workers yet. Pair one below.")]),
  );

  const projects = state.workers.flatMap((w) => w.projects.map((p) => ({ ...p, worker: w.name })));
  $("#projects").replaceChildren(
    ...projects.map((p) => h("li", {}, h("span", {}, p.title), h("span", { class: "muted" }, `${p.worker} · ${p.workspaceRoot}`))),
    ...(projects.length ? [] : [h("li", { class: "muted" }, "No projects yet.")]),
  );

  setOptions($("#project-form [name=worker]"), state.workers.filter((w) => w.online).map((w) => [w.name, w.name]));
  const projectOptions = projects.map((p) => [`${p.worker}/${p.id}`, `${p.title} (${p.worker})`]);
  setOptions($("#job-form [name=project]"), projectOptions);
  setOptions($("#plan-form [name=project]"), projectOptions);
  setOptions($("#card-form [name=project]"), projectOptions);
  setOptions($("#card-form [name=role]"), assignableRoles().map((r) => [r.name, `${r.title} (${r.department})`]));
  renderBoard(projects);
  setOptions($("#job-form [name=role]"), state.roles.map((r) => [r.name, r.title]));
  renderRoleChoice();

  const waiting = state.jobs.flatMap((j) => j.attempts.filter((a) => a.state === "awaiting_input").map((a) => ({ a, j })));
  $("#inbox").hidden = waiting.length === 0;
  $("#inbox-items").replaceChildren(
    ...waiting.map(({ a, j }) =>
      h("div", { class: "attempt", onclick: () => openDetail(a.id) }, badge(a.state), h("span", {}, j.title), agentCard(attemptAgent(a), true)),
    ),
  );

  // Cross-checks are shown under the attempt they review, not as jobs of their own.
  const reviewsOf = new Map();
  for (const j of state.jobs) if (j.reviews_attempt) reviewsOf.set(j.reviews_attempt, [...(reviewsOf.get(j.reviews_attempt) ?? []), j]);
  const topLevel = state.jobs.filter((j) => !j.reviews_attempt);
  const attemptRow = (a) =>
    h(
      "div",
      { class: `attempt${selected === a.id ? " selected" : ""}`, onclick: () => openDetail(a.id) },
      badge(a.state),
      agentCard(attemptAgent(a), true),
      a.verdict ? h("span", { class: `verdict ${a.verdict === "APPROVE" ? "approve" : "changes"}` }, a.verdict === "APPROVE" ? "Approved" : "Changes requested") : null,
      h("span", { class: "muted" }, `@ ${a.worker}`),
      h("span", { class: "muted" }, ago(a.created_at)),
    );
  $("#jobs").replaceChildren(
    ...topLevel.map((j) =>
      h(
        "div",
        { class: "job" },
        h("div", { class: "job-title" }, j.title, j.milestone ? h("span", { class: `badge s-${j.milestone === "rejected" ? "failed" : "result_available"}`, style: "margin-left:0.5rem" }, j.milestone) : null),
        h("div", { class: "muted" }, j.brief.length > 160 ? j.brief.slice(0, 160) + "…" : j.brief),
        j.attempts.map((a) => [
          attemptRow(a),
          ...(reviewsOf.get(a.id) ?? []).map((r) =>
            h("div", { class: "review" }, h("span", { class: "label" }, "Cross-check"), r.attempts.map(attemptRow)),
          ),
          a.review_note ? h("div", { class: "review-note" }, a.review_note) : null,
        ]),
      ),
    ),
    ...(topLevel.length ? [] : [h("p", { class: "muted" }, "No jobs yet.")]),
  );
}

const attemptAgent = (a) => ({ role: a.role, provider: a.provider, model: a.model, kits: a.kits ? JSON.parse(a.kits) : [] });

let lastRole = null;
function renderRoleChoice() {
  const role = state.roles.find((r) => r.name === $("#job-form [name=role]").value);
  if (!role) return;
  setOptions($("#job-form [name=provider]"), role.runtimes.map((r) => [r, r === role.preferred ? `${state.harnesses[r]?.label ?? r} (preferred)` : state.harnesses[r]?.label ?? r]));
  // Rebuild the kit checkboxes only when the role changes, so a poll does not undo your ticks.
  if (lastRole !== role.name) {
    lastRole = role.name;
    const box = (name, checked, optional) => {
      const k = state.kits.find((x) => x.name === name);
      return h(
        "label",
        { class: optional ? "optional" : "", title: k?.description ?? "" },
        h("input", { type: "checkbox", name: "kits", value: name, checked, onchange: renderPreview }),
        `${WIDGETS[k?.widget] ?? WIDGETS.toolbox} ${k?.title ?? name}`,
      );
    };
    $("#kit-picker").replaceChildren(
      h("legend", {}, "Kits"),
      ...role.kits.default.map((n) => box(n, true, false)),
      ...role.kits.optional.map((n) => box(n, false, true)),
    );
  }
  renderPreview();
}

function chosenKits() {
  return [...document.querySelectorAll("#kit-picker input:checked")].map((i) => i.value);
}

function renderPreview() {
  const role = state.roles.find((r) => r.name === $("#job-form [name=role]").value);
  if (!role) return;
  const provider = $("#job-form [name=provider]").value || role.preferred;
  const worker = state.workers.find((w) => w.name === $("#job-form [name=project]").value.split("/")[0]);
  const instance = provider === "claude" ? "claudeAgent" : provider; // codex and opencode use their own names
  const model = provider === role.preferred && role.model ? role.model : worker?.providers.find((p) => p.id === instance)?.models[0] ?? null;
  $("#agent-preview").replaceChildren(agentCard({ role: role.name, provider, model, kits: chosenKits() }));
  void renderLoadoutNotes(role.name, provider, chosenKits());
}

/** The compiler's caveats for this role, kits and runtime, e.g. what Codex's sandbox does not cover. */
let notesRequest = 0;
let notesKey = "";
async function renderLoadoutNotes(role, provider, kits) {
  const key = JSON.stringify([role, provider, kits]);
  if (key === notesKey) return; // unchanged since the last poll
  notesKey = key;
  const mine = ++notesRequest;
  let preview;
  try {
    preview = await api("POST", "/api/preview", { role, provider, kits });
  } catch (e) {
    notesKey = ""; // retry on the next poll; a hub restart must not leave Start disabled
    preview = { launchable: false, report: [{ feature: "loadout", status: "unsupported", reason: e.message }] };
  }
  if (mine !== notesRequest) return; // a newer choice has been made meanwhile
  const items = preview.report.filter((r) => r.status !== "supported");
  $("#loadout-notes").replaceChildren(
    ...items.map((r) => h("li", { class: r.status === "unsupported" ? "blocked" : "" }, `${r.status === "unsupported" ? "Blocked" : "Note"} (${r.feature}): ${r.reason}`)),
  );
  $("#job-form button").disabled = !preview.launchable;
}


// ------------------------------------------------------------------ board

const COLUMNS = [
  ["proposed", "Proposed"],
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["doing", "Doing"],
  ["review", "Review"],
  ["done", "Done"],
  ["blocked", "Blocked"],
];
const SUPPORT_ROLES = new Set(["critic", "integrator", "producer"]);
const assignableRoles = () => state.roles.filter((r) => !SUPPORT_ROLES.has(r.name));

async function act(fn) {
  try {
    await fn();
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

const openCards = new Set();

function renderBoard(projects) {
  // A redraw would close an open dropdown; wait until you are done with it.
  if ($("#board").contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
  const projectTitle = (key) => {
    const [worker, ...rest] = key.split("/");
    const p = projects.find((x) => x.worker === worker && x.id === rest.join("/"));
    return p ? `${p.title} @ ${worker}` : key;
  };
  const latestAttempt = (card) => {
    const job = state.jobs.find((j) => j.id === card.jobs.at(-1));
    return job?.attempts.at(-1);
  };
  const cardEl = (c) => {
    const role = state.roles.find((r) => r.name === c.role);
    const a = latestAttempt(c);
    const actions = [];
    if (c.column === "proposed") {
      actions.push(h("button", { class: "ok", onclick: () => act(() => api("POST", `/api/cards/${c.id}`, { column: "backlog" })) }, "Approve"));
      actions.push(h("button", { class: "secondary", onclick: () => act(() => api("POST", `/api/cards/${c.id}/discard`)) }, "Discard"));
    }
    if (["backlog", "ready", "blocked"].includes(c.column) && c.role) {
      actions.push(
        h("button", { onclick: () => act(async () => { const { attemptId } = await api("POST", `/api/cards/${c.id}/start`, {}); await openDetail(attemptId); }) }, c.jobs.length ? "Start again" : "Start"),
      );
    }
    if (a) actions.push(h("button", { class: "secondary", onclick: () => openDetail(a.id) }, "Open job"));
    if (!c.role || c.column === "proposed") {
      const sel = h(
        "select",
        { onchange: (e) => act(() => api("POST", `/api/cards/${c.id}`, { role: e.target.value })) },
        h("option", { value: "" }, "assign role…"),
        assignableRoles().map((r) => h("option", { value: r.name, selected: r.name === c.role }, r.title)),
      );
      actions.push(sel);
    }
    actions.push(
      h(
        "select",
        { title: "Move card", onchange: (e) => act(() => api("POST", `/api/cards/${c.id}`, { column: e.target.value })) },
        COLUMNS.map(([v, label]) => h("option", { value: v, selected: v === c.column }, label)),
      ),
    );
    return h(
      "div",
      { class: `kcard ${c.priority}` },
      h("div", { class: "ttl" }, c.title),
      role ? h("span", { class: "hatchip", title: role.department }, role.title) : h("span", { class: "meta" }, "unassigned"),
      h("div", { class: "meta" }, `${projectTitle(c.project)}${c.createdBy !== "you" ? " · proposed by the Producer" : ""}`),
      a ? h("div", { class: "meta" }, badge(a.state), a.verdict ? ` ${a.verdict === "APPROVE" ? "✓ approved" : "✗ changes requested"}` : "") : null,
      c.body
        ? h(
            "details",
            { open: openCards.has(c.id), ontoggle: (e) => (e.target.open ? openCards.add(c.id) : openCards.delete(c.id)) },
            h("summary", {}, "details"),
            h("pre", {}, c.body),
          )
        : null,
      h("div", { class: "actions" }, actions),
    );
  };
  $("#board").replaceChildren(
    ...COLUMNS.map(([col, label]) => {
      const cards = state.cards.filter((c) => c.column === col);
      return h("div", { class: "column" }, h("h3", {}, label, h("span", {}, String(cards.length))), cards.map(cardEl));
    }),
  );
}

// ------------------------------------------------------------------ review milestones and ratings

function renderMilestone(a, job) {
  const el = $("#milestone");
  if (!job || job.kind !== "work") return el.replaceChildren();
  const items = [];
  if (job.milestone) items.push(h("span", { class: `badge s-${job.milestone === "rejected" ? "failed" : "result_available"}` }, job.milestone));
  if (job.integrated_commit) items.push(h("span", { class: "muted" }, `merge ${job.integrated_commit.slice(0, 10)}`));
  if (a.state === "result_available" && !job.milestone) {
    items.push(h("button", { class: "ok", onclick: () => act(() => api("POST", `/api/jobs/${job.id}/accept`)) }, "Accept"));
    items.push(
      h("button", { class: "danger", onclick: () => act(() => api("POST", `/api/jobs/${job.id}/reject`, { note: prompt("Why? (optional)") ?? "" })) }, "Reject"),
    );
  }
  if (job.milestone === "accepted") {
    items.push(
      h(
        "button",
        {
          title: "Merge into the project's main branch, run the tests, and back out if anything fails",
          onclick: () => act(async () => { const { attemptId } = await api("POST", `/api/jobs/${job.id}/integrate`, {}); await openDetail(attemptId); }),
        },
        "Integrate",
      ),
    );
  }
  el.replaceChildren(h("div", { class: "milestone" }, items));
}

function renderRating(a, job) {
  const el = $("#rating");
  if (el.contains(document.activeElement)) return; // do not wipe a note you are typing
  const role = state.roles.find((r) => r.name === a.role);
  if (!job || job.kind !== "work" || !role || !["result_available", "failed", "stopped"].includes(a.state)) return el.replaceChildren();
  const given = Object.fromEntries((state.ratings[a.id] ?? []).map((r) => [r.category, r]));
  const rows = role.categories.map((cat) => {
    const current = given[cat]?.stars ?? 0;
    const note = h("input", { placeholder: "note (optional)", value: given[cat]?.note ?? "" });
    const stars = h(
      "div",
      { class: "stars" },
      [1, 2, 3, 4, 5].map((n) =>
        h("button", { class: n <= current ? "on" : "", title: `${n} star${n > 1 ? "s" : ""}`, onclick: () => act(() => api("POST", `/api/attempts/${a.id}/rate`, { ratings: [{ category: cat, stars: n, note: note.value || undefined }] })) }, "★"),
      ),
    );
    return h("div", { class: "rating-row" }, h("span", {}, cat), stars, note);
  });
  el.replaceChildren(h("h3", {}, "Rate this work"), ...rows, h("p", { class: "muted" }, "Notes go into the role's feedback, which future agents in this role read."));
}

async function refresh() {
  try {
    state = await api("GET", "/api/state");
    render();
    updateOffice(state.scene);
    if (selected) await renderDetail();
  } catch (e) {
    $("#status").textContent = `hub unreachable: ${e.message}`;
  }
}

async function openDetail(id) {
  selected = id;
  $("#detail").hidden = false;
  await renderDetail();
  render();
}

async function renderDetail() {
  const { attempt: a, history, messages, requests } = await api("GET", `/api/attempts/${selected}`);
  const job = state.jobs.find((j) => j.id === a.job_id);
  $("#detail-title").replaceChildren(job?.title ?? a.id, " ", badge(a.state));
  $("#detail-agent").replaceChildren(agentCard(attemptAgent(a)));
  $("#detail-meta").textContent =
    `${state.harnesses[a.provider]?.label ?? a.provider} @ ${a.worker}` + (a.thread_id ? ` · thread ${a.thread_id}` : "") + (a.cancel_requested ? " · cancel pending" : "");
  $("#cancel").hidden = ["stopped", "failed", "result_available"].includes(a.state) || a.cancel_requested === 1;
  renderMilestone(a, job);
  renderRating(a, job);
  $("#requests").replaceChildren(
    ...requests.map((r) =>
      h(
        "div",
        { class: "request" },
        h("strong", {}, r.kind === "command" ? "The agent wants to run a command" : `The agent is asking for: ${r.kind}`),
        h("pre", {}, r.summary || "(no details available)"),
        h(
          "div",
          { class: "row" },
          h("button", { class: "ok", onclick: () => respond(r.id, "accept") }, "Approve"),
          h("button", { class: "secondary", onclick: () => respond(r.id, "acceptForSession"), title: "Approve this kind of action for the rest of the run" }, "Approve for session"),
          h("button", { class: "danger", onclick: () => respond(r.id, "decline") }, "Deny"),
        ),
      ),
    ),
  );
  $("#history").replaceChildren(...history.map((e) => h("li", {}, h("strong", {}, STATE_LABEL[e.to_state] ?? e.to_state), " — ", e.reason)));
  const items = messages.filter((m) => m.text);
  $("#activity").replaceChildren(
    ...items.map((m) => {
      const who = m.by === "user" || m.by === "agent" ? "user" : m.type.includes("assistant") ? "assistant" : "";
      return h("div", { class: `item ${who}` }, h("span", { class: "kind" }, m.title ? `${m.type} · ${m.title}` : m.type), m.text);
    }),
    ...(items.length ? [] : [h("p", { class: "muted" }, "Nothing yet.")]),
  );
}

async function respond(requestId, decision) {
  try {
    await api("POST", `/api/attempts/${selected}/respond`, { requestId, decision });
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function onSubmit(form, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await fn(formData(form));
      form.reset();
      await refresh();
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

onSubmit($("#pair-form"), async (d) => {
  await api("POST", "/api/workers", d);
  toast(`Paired ${d.name}`, true);
});
onSubmit($("#project-form"), (d) => api("POST", "/api/projects", d));
onSubmit($("#job-form"), async (d) => {
  const [worker, project] = d.project.split("/");
  const { attemptId } = await api("POST", "/api/jobs", {
    ...d,
    worker,
    project,
    kits: chosenKits(),
    autoReview: $("#job-form [name=autoReview]").checked,
  });
  await refresh();
  await openDetail(attemptId);
});
$("#job-form [name=role]").addEventListener("change", renderRoleChoice);
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${tab.dataset.view}`;
    setOfficeVisible(tab.dataset.view === "office");
  });
}
if (office === office2d) {
  $("#office-canvas").hidden = false;
  mountOffice($("#office-canvas"), { tooltip: $("#office-tooltip"), onSelect: (attemptId) => openDetail(attemptId) });
} else {
  $("#office-canvas").remove();
  mountOffice($("#view-office"), { onSelect: (attemptId) => openDetail(attemptId) });
}
setOfficeVisible(true);
onSubmit($("#plan-form"), async (d) => {
  const [worker, ...rest] = d.project.split("/");
  const { attemptId } = await api("POST", "/api/plan", { worker, project: rest.join("/"), goal: d.goal });
  toast("The Producer is planning; proposed cards will appear in the Proposed column.", true);
  await openDetail(attemptId);
});
onSubmit($("#card-form"), (d) => api("POST", "/api/cards", d));
$("#job-form [name=provider]").addEventListener("change", renderPreview);
$("#job-form [name=project]").addEventListener("change", renderPreview);
$("#close-detail").addEventListener("click", () => {
  selected = null;
  $("#detail").hidden = true;
  render();
});
$("#cancel").addEventListener("click", async () => {
  try {
    await api("POST", `/api/attempts/${selected}/cancel`);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
});

await refresh();
setInterval(refresh, 2000);
