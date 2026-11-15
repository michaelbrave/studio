// The studio view: draws the scene the hub's simulation computed (packages/sim). Canvas 2D, one
// isometric room per machine. It redraws only when the scene changes or someone is animating,
// at a low frame rate, and stops while hidden: a constantly repainting canvas wastes GPU.

const A = "/assets/";
const FPS = 8;
const PERSON_SCALE = 0.27;
const STEP_X = 104;
const STEP_Y = 52;
const ROOM = { cols: 5.8, rows: 2.9 };
const FLOOR_HEIGHT = 520;
const WALL_HEIGHT = 130;

/** Desk positions in grid cells: back row first so nearer desks draw over farther ones. */
const DESK_CELLS = [
  [1.45, 0.75], [2.55, 0.75], [3.65, 0.75], [4.75, 0.75],
  [1.45, 2.05], [2.55, 2.05], [3.65, 2.05], [4.75, 2.05],
];
const WIDGETS = { clipboard: "📋", shield: "🛡️", magnifier: "🔍", notebook: "📓", scales: "⚖️", gamepad: "🎮", cards: "🗂️", toolbox: "🧰" };
/** Speech-bubble emoji for each state the simulation reports. */
const BUBBLES = {
  dots: "💻",
  bars: "🧪",
  idea: "💭",
  exclamation: "🙋",
  question: "❓",
  sleep: "☕",
  star: "✅",
  hourglass: "⏳",
  cross: "❌",
  plug: "🔌",
};
const CARD_COLORS = { proposed: "#cfd8ff", backlog: "#fdf6d8", ready: "#ffe9a8", doing: "#bfe8ff", review: "#ffd2a8", done: "#c8f2c4", blocked: "#ffb8b8" };
const DEPARTMENT_CAPS = { Programming: "#3b4a6b", Design: "#6b3b5e", QA: "#3b6b55", Direction: "#6b5a2e", Production: "#5a3b6b", Review: "#2e5f6b" };

// ------------------------------------------------------------------ images

const images = new Map();
function image(path) {
  if (!images.has(path)) {
    const img = new Image();
    const entry = { img, ok: false, failed: false };
    img.onload = () => {
      entry.ok = true;
      invalidate();
      schedule();
    };
    img.onerror = () => (entry.failed = true);
    img.src = A + path;
    images.set(path, entry);
  }
  const e = images.get(path);
  return e.ok ? e.img : null;
}

const tinted = new Map();
/** White art multiplied by a colour, keeping its shading and transparency (shirts). */
function tint(path, color) {
  const key = `${path}|${color}`;
  if (tinted.has(key)) return tinted.get(key);
  const src = image(path);
  if (!src) return null;
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext("2d");
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(src, 0, 0);
  tinted.set(key, c);
  return c;
}

/** Vendor logos from assets/logos/<vendor>.svg (LobeHub Icons, MIT); the initial if missing. */
function logo(vendor) {
  const path = `logos/${vendor.toLowerCase()}.svg`;
  const entry = images.get(path);
  if (!entry) image(path);
  return images.get(path)?.ok ? images.get(path).img : null;
}

// ------------------------------------------------------------------ helpers

function shortModel(model) {
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const gpt = model.match(/^gpt-([\d.]+)-?(.*)$/i);
  if (gpt) return `GPT ${gpt[1]}${gpt[2] ? ` ${cap(gpt[2])}` : ""}`;
  return cap(model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2"));
}

function draw(g, path, x, y, scale = 1) {
  const img = image(path);
  if (img) g.drawImage(img, x, y, img.width * scale, img.height * scale);
  return img;
}

/** A small white speech bubble whose tail points down-left at (x, y), holding one emoji. */
function speechBubble(g, emoji, x, y, scale) {
  const w = 30 * scale, h = 24 * scale;
  const left = x - 4, top = y - h - 6;
  g.save();
  g.fillStyle = "#ffffff";
  g.strokeStyle = "rgba(0, 0, 0, 0.25)";
  g.lineWidth = 1;
  roundRect(g, left, top, w, h, 8 * scale);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(left + 6, top + h - 1);
  g.lineTo(x - 6, y);
  g.lineTo(left + 14, top + h - 1);
  g.closePath();
  g.fill();
  g.font = `${Math.round(15 * scale)}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(emoji, left + w / 2, top + h / 2 + 1);
  g.restore();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function label(g, text, cx, y, { bg = "#faf6e2", fg = "#2a2a2a", size = 11 } = {}) {
  g.font = `700 ${size}px system-ui, sans-serif`;
  const w = g.measureText(text).width + 12;
  roundRect(g, cx - w / 2, y, w, size + 7, 4);
  g.fillStyle = bg;
  g.fill();
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "top";
  g.fillText(text, cx, y + 3);
  g.textAlign = "left";
}

// ------------------------------------------------------------------ the view

let current = null;
let canvas = null;
let ctx = null;
let tooltip = null;
let onSelect = () => {};
let hitBoxes = [];
let dirty = true;
let timer = null;
let visible = false;
let hovered = null;
/** Tags and bubbles are drawn after everyone on a floor, so no one hides them. */
let overlays = [];

function invalidate() {
  dirty = true;
}

export function mountOffice(el, opts) {
  canvas = el;
  ctx = canvas.getContext("2d");
  onSelect = opts.onSelect;
  tooltip = opts.tooltip;
  canvas.addEventListener("click", (e) => {
    const hit = hitAt(e);
    if (hit) onSelect(hit.attemptId);
  });
  canvas.addEventListener("mousemove", (e) => {
    const hit = hitAt(e);
    canvas.style.cursor = hit ? "pointer" : "default";
    if (hit?.attemptId !== hovered?.attemptId) {
      hovered = hit;
      showTooltip(e, hit);
      invalidate();
    } else if (hit) moveTooltip(e);
  });
  canvas.addEventListener("mouseleave", () => {
    hovered = null;
    showTooltip(null, null);
  });
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("resize", () => {
    invalidate();
    schedule();
  });
}

export function setOfficeVisible(v) {
  visible = v;
  invalidate();
  schedule();
}

export function updateOffice(scene) {
  const changed = JSON.stringify(scene) !== JSON.stringify(current);
  current = scene;
  if (changed) invalidate();
  schedule();
}

function animating() {
  return current?.agents.some((a) => a.pose === "working" || a.pose === "waiting") ?? false;
}

/** Draw now if needed, and keep a slow timer only while something animates and the view is shown. */
function schedule() {
  const active = visible && !document.hidden && current;
  if (!active) {
    clearInterval(timer);
    timer = null;
    return;
  }
  if (dirty) render(performance.now());
  if (animating() && !timer) timer = setInterval(() => render(performance.now()), 1000 / FPS);
  if (!animating() && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function hitAt(e) {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  // The person drawn last is on top, so it gets the click.
  return hitBoxes.findLast((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) ?? null;
}

function showTooltip(e, hit) {
  if (!hit) {
    tooltip.hidden = true;
    return;
  }
  const a = current.agents.find((x) => x.attemptId === hit.attemptId);
  tooltip.replaceChildren();
  const line = (text, cls) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    tooltip.append(d);
  };
  line(a.name ?? a.jobTitle, "tt-title");
  if (a.name && a.jobId) line(a.jobTitle);
  line(`${a.roleTitle}${a.department ? ` · ${a.department}` : ""}`);
  line(`${a.harness.label} · ${a.model}`);
  if (a.kits.length) line(`Kits: ${a.kits.map((k) => k.title).join(", ")}`);
  line(a.status, `tt-status pose-${a.pose}`);
  line("Click to open the job", "tt-hint");
  tooltip.hidden = false;
  moveTooltip(e);
}

function moveTooltip(e) {
  const r = canvas.getBoundingClientRect();
  tooltip.style.left = `${e.clientX - r.left + 16}px`;
  tooltip.style.top = `${e.clientY - r.top + 12}px`;
}

function render(t) {
  dirty = false;
  if (!current) return;
  const width = canvas.parentElement.clientWidth;
  const height = Math.max(1, current.floors.length) * FLOOR_HEIGHT;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const g = ctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  hitBoxes = [];
  const frame = Math.floor((t / 1000) * FPS);
  current.floors.forEach((floor, i) => drawFloor(g, floor, i, width, frame));
}

function drawFloor(g, floor, index, width, frame) {
  const top = index * FLOOR_HEIGHT;
  const ox = width / 2 - (ROOM.cols - ROOM.rows) * STEP_X * 0.5;
  const oy = top + WALL_HEIGHT + 40;
  const iso = (c, r) => ({ x: ox + (c - r) * STEP_X, y: oy + (c + r) * STEP_Y });

  g.save();
  if (!floor.online) g.filter = "grayscale(1) brightness(0.7)";

  // Walls: the two back edges of the room, then the floor.
  const t0 = iso(0, 0), tc = iso(ROOM.cols, 0), tr = iso(0, ROOM.rows), b = iso(ROOM.cols, ROOM.rows);
  g.fillStyle = "#3a4152";
  g.beginPath();
  g.moveTo(tr.x, tr.y);
  g.lineTo(t0.x, t0.y);
  g.lineTo(t0.x, t0.y - WALL_HEIGHT);
  g.lineTo(tr.x, tr.y - WALL_HEIGHT);
  g.fill();
  g.fillStyle = "#454d61";
  g.beginPath();
  g.moveTo(t0.x, t0.y);
  g.lineTo(tc.x, tc.y);
  g.lineTo(tc.x, tc.y - WALL_HEIGHT);
  g.lineTo(t0.x, t0.y - WALL_HEIGHT);
  g.fill();
  g.fillStyle = "#e8b77a";
  g.beginPath();
  g.moveTo(t0.x, t0.y);
  g.lineTo(tc.x, tc.y);
  g.lineTo(b.x, b.y);
  g.lineTo(tr.x, tr.y);
  g.fill();
  g.strokeStyle = "rgba(120, 72, 30, 0.18)";
  g.lineWidth = 1;
  for (let c = 1; c < ROOM.cols; c++) {
    const p = iso(c, 0), q = iso(c, ROOM.rows);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(q.x, q.y);
    g.stroke();
  }

  drawWindow(g, iso);
  drawBoard(g, iso, floor.worker);

  // Furniture and people, back to front.
  const coffee = iso(5.6, 0.2);
  draw(g, "furniture/kitchenCoffeeMachine_SW.png", coffee.x - 24, coffee.y - 62, 1.1);
  const plant = iso(0.15, 2.9);
  draw(g, "furniture/pottedPlant_SW.png", plant.x - 25, plant.y - 70);

  const agents = current.agents.filter((a) => a.floor === floor.worker);
  const deskPos = new Map();
  DESK_CELLS.forEach(([c, r], i) => {
    const p = iso(c, r);
    const X = p.x - 58, Y = p.y - 64;
    deskPos.set(i, { X, Y });
    const a = agents.find((x) => x.desk === i);
    drawStation(g, X, Y, a, frame);
  });

  for (const a of agents.filter((x) => x.visiting)) {
    let x, y;
    if ("place" in a.visiting) {
      // In front of the board on the left wall, clear of the desks.
      const p = iso(0.4, 0.62);
      x = p.x + 4;
      y = p.y - 8;
    } else {
      const host = agents.find((h) => h.attemptId === a.visiting.attemptId);
      const pos = host?.desk != null ? deskPos.get(host.desk) : null;
      if (!pos) continue;
      // At the front corner of the desk, looking over the work being reviewed.
      x = pos.X + 8;
      y = pos.Y + 62;
    }
    drawPerson(g, a, x, y, frame, true);
  }
  for (const o of overlays) o();
  overlays = [];
  g.restore();

  // Floor sign, drawn without the offline filter so it stays readable.
  const people = agents.length;
  label(g, `${floor.worker}${floor.local ? " (this machine)" : ""}`, 90, top + 14, { bg: "#20232b", fg: "#e6e6e9", size: 13 });
  g.font = "12px system-ui, sans-serif";
  g.fillStyle = floor.online ? "#8b8f9c" : "#e06c75";
  g.fillText(floor.online ? `${people} at work` : `unreachable: ${floor.error ?? "offline"}`, 20, top + 42);
  if (!floor.online) {
    const c = iso(ROOM.cols / 2, ROOM.rows / 2);
    label(g, "This machine is unreachable", c.x, c.y - 10, { bg: "#e06c75", fg: "#111", size: 13 });
  } else if (people === 0) {
    const c = iso(ROOM.cols / 2, ROOM.rows / 2);
    g.fillStyle = "rgba(60, 40, 20, 0.45)";
    g.font = "600 13px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(current.agents.length ? "No one on this floor" : "No staff yet: Hire an agent (left)", c.x, c.y);
    g.textAlign = "left";
  }
}

function drawWindow(g, iso) {
  const a = iso(2.2, 0), b = iso(3.8, 0);
  const h0 = 30, h1 = 95;
  g.fillStyle = "#9fd3ff";
  g.beginPath();
  g.moveTo(a.x, a.y - h0);
  g.lineTo(b.x, b.y - h0);
  g.lineTo(b.x, b.y - h1);
  g.lineTo(a.x, a.y - h1);
  g.fill();
  g.strokeStyle = "#2b3140";
  g.lineWidth = 4;
  g.stroke();
}

/** The kanban board on the left wall: one sticky note per card, coloured by column. */
function drawBoard(g, iso, worker) {
  const r0 = 0.35, r1 = 2.6, h0 = 22, h1 = 104;
  const p = (r, h) => {
    const q = iso(0, r);
    return { x: q.x, y: q.y - h };
  };
  const corners = [p(r0, h0), p(r1, h0), p(r1, h1), p(r0, h1)];
  g.fillStyle = "#b98a55";
  g.beginPath();
  corners.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
  g.closePath();
  g.fill();
  g.strokeStyle = "#7a5530";
  g.lineWidth = 3;
  g.stroke();

  const columns = ["backlog", "ready", "doing", "review", "done"];
  // Each floor's board shows the cards for projects on that machine.
  const cards = (col) => (current.wall[col] ?? []).filter((c) => c.project.startsWith(`${worker}/`));
  columns.forEach((col, ci) => {
    const list = cards(col);
    const rc = r0 + 0.12 + (ci * (r1 - r0 - 0.2)) / columns.length;
    list.slice(0, 5).forEach((_, k) => {
      const a = p(rc, h1 - 12 - k * 15), b = p(rc + 0.28, h1 - 12 - k * 15);
      g.fillStyle = CARD_COLORS[col];
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.lineTo(b.x, b.y + 11);
      g.lineTo(a.x, a.y + 11);
      g.fill();
    });
  });
  const proposed = cards("proposed").length;
  if (proposed) {
    const q = p(r1 - 0.1, h1 + 4);
    label(g, `${proposed} proposed`, q.x, q.y - 22, { bg: "#cfd8ff", size: 10 });
  }
}

function drawStation(g, X, Y, a, frame) {
  // The person sits behind the desk: chair, then person, then the desk hides their lower half.
  if (a) {
    draw(g, "furniture/chairDesk_NE.png", X + 30, Y - 16, 0.9);
    drawPerson(g, a, X + 52, Y + 24, frame, false);
  }
  draw(g, "furniture/desk_SW.png", X, Y);
  // Monitor to the side so it does not cover the shirt print.
  draw(g, "furniture/computerScreen_SW.png", X + 82, Y + 16, 0.8);
  draw(g, "furniture/computerKeyboard_SW.png", X + 26, Y + 36, 0.8);
  if (a) {
    // The equipped Kits, as widgets on the front of the desk.
    g.font = "13px system-ui, sans-serif";
    a.kits.forEach((k, i) => g.fillText(WIDGETS[k.widget] ?? WIDGETS.toolbox, X + 10 + i * 15, Y + 58 + i * 7));
  }
}

/**
 * A person, anchored at the bottom centre of their torso (cx, base): torso in the harness colour
 * with the vendor and model on it, a cap in the department colour with the role on a tag.
 */
function drawPerson(g, a, cx, base, frame, standing) {
  const s = PERSON_SCALE;
  const look = a.look;
  const skin = (look % 8) + 1;
  const hair = `character/hair/hair${(look >> 3) % 8}-${(look >> 6) % 4}.png`;
  const face = `character/face/face${((look >> 9) % 4) + 1}.png`;
  base += a.pose === "working" && frame % 4 >= 2 ? 1 : 0;
  const shirtH = 174 * s, headH = 168 * s;
  const shirtTop = base - shirtH;
  const headTop = shirtTop - headH + 14 * s;
  const py = headTop; // top of the head, for labels and bubbles

  g.save();
  if (a.pose === "offline" || a.pose === "failed") g.filter = "grayscale(0.8)";
  if (standing) {
    // Legs, so visitors read as standing rather than floating.
    g.fillStyle = "#3a3f55";
    g.fillRect(cx - 12, base - 4, 10, 34);
    g.fillRect(cx + 2, base - 4, 10, 34);
    g.fillStyle = "#222";
    g.fillRect(cx - 14, base + 28, 13, 5);
    g.fillRect(cx + 2, base + 28, 13, 5);
  }
  const neck = image(`character/skin/neck${skin}.png`);
  if (neck) g.drawImage(neck, cx - (neck.width * s) / 2, shirtTop - 10 * s, neck.width * s, neck.height * s);
  const shirt = tint("character/shirt/shirt.png", a.harness.color);
  if (shirt) g.drawImage(shirt, cx - (shirt.width * s) / 2, shirtTop, shirt.width * s, shirt.height * s);
  const head = image(`character/skin/head${skin}.png`);
  if (head) g.drawImage(head, cx - (head.width * s) / 2, headTop, head.width * s, head.height * s);
  const f = image(face);
  if (f && head) g.drawImage(f, cx - (f.width * s) / 2, headTop + (head.height * s) / 2 - (f.height * s) / 3, f.width * s, f.height * s);
  const h = image(hair);
  if (h) g.drawImage(h, cx - (h.width * s) / 2, headTop - 12 * s, h.width * s, h.height * s);
  g.restore();

  // Shirt print: vendor mark and model name.
  const mark = logo(a.harness.vendor);
  if (mark) g.drawImage(mark, cx - 6, shirtTop + 5, 12, 12);
  else {
    g.beginPath();
    g.arc(cx, shirtTop + 11, 6.5, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.fill();
    g.fillStyle = a.harness.color;
    g.font = "800 8px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(a.harness.vendor.charAt(0), cx, shirtTop + 11.5);
    g.textBaseline = "alphabetic";
  }
  g.font = "700 8px system-ui, sans-serif";
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.fillText(shortModel(a.model), cx, shirtTop + 27);
  g.textAlign = "left";

  // Cap in the department's colour, with the role on a tag above it.
  g.fillStyle = DEPARTMENT_CAPS[a.department] ?? "#343a4a";
  g.beginPath();
  g.ellipse(cx, py + 12, 19, 13, 0, Math.PI, 0);
  g.fill();
  g.fillRect(cx - 22, py + 10, 47, 4);
  overlays.push(() => {
    label(g, (a.name ?? a.roleTitle).toUpperCase(), cx, py - 16, { size: 9 });
    // Speech bubble with an emoji for their state. Needs-you pulses so it catches the eye.
    const emoji = BUBBLES[a.bubble];
    if (emoji) speechBubble(g, emoji, cx + 26, py - 22, a.pose === "waiting" && frame % 4 >= 2 ? 1.18 : 1);
  });
  const box = { x: cx - 30, y: py - 18, w: 60, h: base - py + (standing ? 52 : 22) };
  if (hovered?.attemptId === a.attemptId) {
    g.strokeStyle = "rgba(122, 162, 247, 0.9)";
    g.lineWidth = 2;
    roundRect(g, box.x, box.y, box.w, box.h, 8);
    g.stroke();
  }
  hitBoxes.push({ attemptId: a.attemptId, ...box });
}

/** The flat office has no camera to turn; the Staff list still opens the agent's panel. */
export function focusAgent() {}
