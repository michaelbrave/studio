// The chat dock, bottom left: talk to an agent without opening T3 (apps/hub/src/desk.ts).
// "Studio desk" chats run the Studio Manager, which can hire staff, set up projects and computers,
// and hand out jobs. A chat in a project is a plain T3 chat in that project's folder.

const SUGGESTIONS = [
  "Hire my first agent",
  "Set up a new project for me",
  "What's going on in the studio?",
  "Plan out a feature with the Producer",
];
const INSTANCE = { claude: "claudeAgent", codex: "codex", opencode: "opencode" };
const BUSY = new Set(["preparing", "queued", "starting", "running", "waiting"]);

let ctx = null; // { h, api, toast, getState, onChange }
let root = null;
let open = JSON.parse(localStorage.getItem("studio.chat.open") ?? "false");
let chatId = localStorage.getItem("studio.chat.id") || null;
let chats = [];
let view = null; // last GET /api/chats/:id
let draft = "";
let setup = { where: "desk", provider: "claude", model: "" };
let sending = false;
let timer = null;
let lastSig = "";

export function setupChat(c) {
  ctx = c;
  root = document.createElement("div");
  root.id = "chat";
  document.body.append(root);
  render();
  if (open) void load();
}

function save() {
  localStorage.setItem("studio.chat.open", JSON.stringify(open));
  if (chatId) localStorage.setItem("studio.chat.id", chatId);
  else localStorage.removeItem("studio.chat.id");
}

function toggle(v = !open) {
  open = v;
  save();
  document.body.classList.toggle("chat-open", open);
  render();
  if (open) void load();
  else clearTimeout(timer);
}

async function load() {
  try {
    chats = await ctx.api("GET", "/api/chats");
    if (chatId && !chats.some((c) => c.id === chatId)) chatId = null;
    if (chatId) await poll();
    else render();
  } catch (e) {
    ctx.toast(e.message);
  }
}

async function poll() {
  clearTimeout(timer);
  if (!open || !chatId) return;
  try {
    view = await ctx.api("GET", `/api/chats/${chatId}`);
  } catch (e) {
    view = { error: e.message };
  }
  // Redraw only when something changed, so reading and selecting text is not interrupted.
  const sig = JSON.stringify(view);
  if (sig !== lastSig) {
    lastSig = sig;
    render();
    if (view.chat?.desk) ctx.onChange(); // the manager may have hired someone or started a job
  }
  timer = setTimeout(poll, BUSY.has(view?.status) ? 1500 : 6000);
}

function where() {
  const state = ctx.getState();
  const projects = state.workers.flatMap((w) => w.projects.filter((p) => !p.desk).map((p) => [`${w.name}/${p.id}`, `${p.title} (${w.name})`]));
  return [["desk", "Studio desk: can set Studio up"], ...projects];
}

/** Harnesses (and models) on the computer the new chat would run on. */
function harnesses() {
  const state = ctx.getState();
  const worker = setup.where === "desk" ? state.workers.find((w) => w.local) : state.workers.find((w) => w.name === setup.where.split("/")[0]);
  return Object.entries(state.harnesses).map(([id, hz]) => {
    const p = worker?.providers.find((x) => x.id === INSTANCE[id]);
    return { id, label: hz.label, color: hz.color, ok: !!p || !worker?.providers.length, models: p?.models ?? [] };
  });
}

function render() {
  const { h } = ctx;
  document.body.classList.toggle("chat-open", open);
  if (!open) {
    const waiting = view?.status === "waiting";
    root.className = "chat closed";
    root.replaceChildren(h("button", { type: "button", class: `chat-pill${waiting ? " warn" : ""}`, onclick: () => toggle(true) }, "💬 ", waiting ? "Chat needs you" : "Chat"));
    return;
  }
  root.className = "chat";
  const busy = BUSY.has(view?.status);
  const head = h(
    "div",
    { class: "chat-head" },
    h(
      "select",
      {
        class: "chat-pick",
        title: "Your chats",
        onchange: (e) => {
          chatId = e.target.value || null;
          view = null;
          lastSig = "";
          save();
          chatId ? poll() : render();
        },
      },
      h("option", { value: "" }, "＋ New chat"),
      chats.map((c) => h("option", { value: c.id, selected: c.id === chatId }, c.title.replace(/^(Studio|Chat): /, ""))),
    ),
    chatId && view?.t3Url
      ? h("a", { class: "t3-link", href: view.t3Url, target: "_blank", rel: "noopener", title: "This chat in T3, with every step the agent took" }, "T3 ↗")
      : null,
    h("button", { type: "button", class: "ghost", title: "Minimise", onclick: () => toggle(false) }, "–"),
  );
  const typing = document.activeElement?.matches?.("#chat textarea") ? document.activeElement.selectionStart : null;
  const prevLog = root.querySelector(".chat-log");
  const atBottom = !prevLog || prevLog.scrollHeight - prevLog.scrollTop - prevLog.clientHeight < 40;
  root.replaceChildren(head, chatId ? conversation() : newChat(), composer(busy));
  const log = root.querySelector(".chat-log");
  // Follow new messages unless you scrolled up to read.
  if (log) log.scrollTop = atBottom ? log.scrollHeight : prevLog.scrollTop;
  if (typing !== null) {
    const box = root.querySelector("textarea");
    box.focus();
    box.setSelectionRange(typing, typing);
  }
}

function newChat() {
  const { h } = ctx;
  const list = harnesses();
  if (!list.find((x) => x.id === setup.provider)?.ok) setup.provider = list.find((x) => x.ok)?.id ?? "claude";
  const current = list.find((x) => x.id === setup.provider);
  return h(
    "div",
    { class: "chat-log chat-new" },
    h("p", { class: "chat-hello" }, "Hi! I can hire and set up agents, make projects, and hand out jobs. Or pick a project to chat about its code, like in T3."),
    h(
      "label",
      {},
      "Where",
      h("select", { onchange: (e) => ((setup.where = e.target.value), render()) }, where().map(([v, l]) => h("option", { value: v, selected: v === setup.where }, l))),
    ),
    h(
      "div",
      { class: "chat-row" },
      h(
        "label",
        {},
        "Harness",
        h(
          "select",
          { onchange: (e) => ((setup.provider = e.target.value), (setup.model = ""), render()) },
          list.map((x) => h("option", { value: x.id, selected: x.id === setup.provider, disabled: !x.ok }, x.ok ? x.label : `${x.label} (not signed in)`)),
        ),
      ),
      h(
        "label",
        {},
        "Model",
        h(
          "select",
          { onchange: (e) => (setup.model = e.target.value) },
          h("option", { value: "" }, "default"),
          (current?.models ?? []).map((m) => h("option", { value: m, selected: m === setup.model }, m)),
        ),
      ),
    ),
    setup.where === "desk"
      ? h("div", { class: "chat-chips" }, SUGGESTIONS.map((s) => h("button", { type: "button", class: "chip", onclick: () => send(s) }, s)))
      : null,
  );
}

function conversation() {
  const { h } = ctx;
  if (!view) return h("div", { class: "chat-log" }, h("p", { class: "muted" }, "Loading…"));
  if (view.error) return h("div", { class: "chat-log" }, h("p", { class: "chat-error" }, view.error));
  const out = [];
  for (const it of view.items) {
    const mine = it.by === "user" || it.type === "user_message";
    if (mine) out.push(h("div", { class: "msg me" }, it.text ?? ""));
    else if (it.type.includes("assistant")) {
      if (it.text) out.push(h("div", { class: "msg them" }, it.text));
    } else if (it.type === "reasoning" || it.type === "checkpoint") {
      continue; // thinking shows in the status line while it happens; checkpoints are T3's bookkeeping
    } else {
      // A tool call or step: one quiet line, named after the tool.
      const label = stepLabel(it);
      out.push(h("div", { class: `step s-${it.status}` }, "↳ ", label.length > 90 ? `${label.slice(0, 87)}…` : label));
    }
  }
  for (const r of view.requests ?? []) {
    out.push(
      h(
        "div",
        { class: "request" },
        h("strong", {}, r.kind === "command" ? "It wants to run a command" : `It is asking for: ${r.kind}`),
        h("pre", {}, r.summary || "(no details available)"),
        h(
          "div",
          { class: "row" },
          h("button", { class: "ok", onclick: () => respond(r.id, "accept") }, "Approve"),
          h("button", { class: "secondary", onclick: () => respond(r.id, "acceptForSession"), title: "Approve this kind of action for the rest of the chat" }, "For this chat"),
          h("button", { class: "danger", onclick: () => respond(r.id, "decline") }, "Deny"),
        ),
      ),
    );
  }
  const status =
    view.status === "waiting" ? "Waiting for you" : BUSY.has(view.status) ? "Working…" : view.status === "failed" ? "The last turn failed" : null;
  if (status) out.push(h("div", { class: `chat-status${view.status === "waiting" ? " warn" : ""}` }, status));
  return h("div", { class: "chat-log" }, out.length ? out : h("p", { class: "muted" }, "Starting…"));
}

/** "Studio Catalog", "ToolSearch", "$ npm test": what a step was, in a few words. */
function stepLabel(it) {
  if (it.title) return it.title;
  if (it.text?.startsWith("{")) {
    try {
      const name = JSON.parse(it.text).toolName;
      if (name) return name.replace(/^mcp__studio__studio_/, "Studio: ").replace(/^mcp__(\w+?)__/, "$1: ");
    } catch {}
  }
  return it.type.replace(/_/g, " ");
}

function composer(busy) {
  const { h } = ctx;
  const box = h("textarea", {
    rows: 2,
    placeholder: chatId ? "Reply…" : setup.where === "desk" ? "What should we get going?" : "Ask about this project…",
    oninput: (e) => (draft = e.target.value),
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send(draft);
      }
    },
  });
  box.value = draft;
  const stop = busy && chatId ? h("button", { type: "button", class: "secondary", onclick: stopChat, title: "Stop the current turn" }, "Stop") : null;
  return h("div", { class: "chat-compose" }, box, stop, h("button", { type: "button", disabled: sending, onclick: () => send(draft) }, sending ? "…" : "Send"));
}

async function send(text) {
  text = (text ?? "").trim();
  if (!text || sending) return;
  sending = true;
  render();
  try {
    if (chatId) {
      await ctx.api("POST", `/api/chats/${chatId}/send`, { message: text });
    } else {
      const { id } = await ctx.api("POST", "/api/chats", { message: text, where: setup.where, provider: setup.provider, model: setup.model || null });
      chatId = id;
      chats = await ctx.api("GET", "/api/chats");
      save();
    }
    draft = "";
  } catch (e) {
    ctx.toast(e.message);
  } finally {
    sending = false;
  }
  lastSig = "";
  await poll();
  root.querySelector("textarea")?.focus();
}

async function respond(requestId, decision) {
  try {
    await ctx.api("POST", `/api/chats/${chatId}/respond`, { requestId, decision });
  } catch (e) {
    ctx.toast(e.message);
  }
  await poll();
}

async function stopChat() {
  try {
    await ctx.api("POST", `/api/chats/${chatId}/stop`);
  } catch (e) {
    ctx.toast(e.message);
  }
  await poll();
}

/** Open the dock with a message ready to send, e.g. from the empty office. */
export function openChatWith(text) {
  chatId = null;
  view = null;
  setup.where = "desk";
  draft = text;
  toggle(true);
  root.querySelector("textarea")?.focus();
}
