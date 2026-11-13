// The studio view in 3D: one floor per machine, little agents in capped hats and printed t-shirts,
// and a HUD around it. Draws only the scene the hub's simulation computed (packages/sim): nothing
// here invents state. Renders on demand; animates only while someone works or waits, or while you
// move the camera, and stops while the view is hidden.
//
// Look (PLAN.md §10): cap = role (department colour, role on the front panel), shirt = harness
// colour with the vendor mark and model printed on the chest, desk widgets = equipped Kits.

import * as THREE from "three";
import { OrbitControls } from "/vendor/three/OrbitControls.js";

const FLOOR_GAP = 7;
const ROOM_W = 14;
const ROOM_D = 8;
const WALL_H = 3;
const DESKS = [
  [-2.6, -1.5], [-0.4, -1.5], [1.8, -1.5], [4.0, -1.5],
  [-2.6, 1.5], [-0.4, 1.5], [1.8, 1.5], [4.0, 1.5],
];
const BOARD_SPOT = { x: -6.05, z: -1.1, ry: -1.15 };
const ANIM_FPS = 24;
/** Agents are drawn a little larger than the furniture, toy-style, so hats and shirts read. */
const AGENT_SCALE = 1.15;

const POSE = {
  working: { color: "#22c55e", label: "Working" },
  waiting: { color: "#f59e0b", label: "Needs you" },
  unknown: { color: "#a855f7", label: "Status unknown" },
  break: { color: "#94a3b8", label: "On a break" },
  done: { color: "#3b82f6", label: "Done, waiting for review" },
  failed: { color: "#ef4444", label: "Failed" },
  preparing: { color: "#94a3b8", label: "Getting ready" },
  offline: { color: "#64748b", label: "Machine unreachable" },
};
const DEPARTMENT_CAPS = { Programming: "#3b4a8b", Design: "#9b3b7e", QA: "#2f8a5f", Direction: "#a4782a", Production: "#6d48a8", Review: "#2a7f8f" };
const WIDGETS = { clipboard: "📋", shield: "🛡️", magnifier: "🔍", notebook: "📓", scales: "⚖️", gamepad: "🎮", cards: "🗂️", toolbox: "🧰" };
const CARD_COLORS = { backlog: "#fdf6d8", ready: "#ffe08a", doing: "#9fd8ff", review: "#ffc38a", done: "#a8e6a1", blocked: "#ff9d9d" };
const SKIN = ["#f6d7c0", "#eac0a0", "#d9a37e", "#b97f5a", "#8d5a3b", "#5e3b26"];
const HAIR = ["#2b1d14", "#5a3a22", "#a0662e", "#d9b25f", "#1c1c1c", "#8a8f99", "#b5482f"];
const PANTS = ["#2f3a56", "#3a3a40", "#4a5568", "#2d4a3e", "#4b3b2f"];

// ------------------------------------------------------------------ small helpers

const mats = new Map();
/** Shared matte material per colour, for furniture. */
function mat(color, extra = {}) {
  const key = `${color}|${JSON.stringify(extra)}`;
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra }));
  return mats.get(key);
}

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(rt, rb, h, material, x = 0, y = 0, z = 0, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function sphere(r, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function canvasTexture(w, h, paint) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  paint(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Write text centred at (x, y), shrinking the font until it fits maxW. */
function fitText(g, text, x, y, maxW, size, weight = 800, family = "system-ui, sans-serif") {
  let s = size;
  do {
    g.font = `${weight} ${s}px ${family}`;
    s -= 1;
  } while (g.measureText(text).width > maxW && s > 6);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, x, y);
}

function shade(hex, amount) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amount);
  return `#${c.getHexString()}`;
}

function shortModel(model) {
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  if (model.includes("/")) {
    // OpenCode: "opencode/deepseek-v4.1-flash-free" → "Deepseek V4.1 Flash" (free is not a model name).
    return model.split("/").at(-1).replace(/-free$/, "").split("-").map((w) => (/^v?\d/.test(w) || ["glm", "vl", "gpt", "ai"].includes(w) ? w.toUpperCase() : cap(w))).join(" ");
  }
  const gpt = model.match(/^gpt-([\d.]+)-?(.*)$/i);
  if (gpt) return `GPT ${gpt[1]}${gpt[2] ? ` ${cap(gpt[2])}` : ""}`;
  return cap(model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2"));
}

/** What fits on the front of a cap: the whole title if short, else its last word ("Engineer"). */
function capText(title) {
  const t = title.toUpperCase();
  if (t.length <= 10) return t;
  const last = t.split(/\s+/).at(-1);
  return last.length <= 10 ? last : t.slice(0, 9);
}

function esc(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function clock(ms = Date.now()) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ logos

/**
 * Logos live in assets/logos/<key>.svg (LobeHub Icons, MIT). The chest shows the model
 * family's mark when there is one (Claude, GPT, Gemini...), else the vendor's, else its initial.
 * The cap's side patch shows the harness (Claude Code, Codex).
 */
const MODEL_LOGOS = [
  [/^claude/i, "claude"],
  [/^(gpt|o\d|codex)/i, "openai"],
  [/^gemini/i, "gemini"],
  [/^gemma/i, "gemma"],
  [/^(grok)/i, "grok"],
  [/^deepseek/i, "deepseek"],
  [/^(qwen)/i, "qwen"],
  [/^(mistral|codestral|devstral)/i, "mistral"],
  [/^kimi/i, "kimi"],
  [/^(glm)/i, "zhipu"],
  [/^llama/i, "meta"],
  [/^mimo/i, "xiaomimimo"],
  [/^nemotron/i, "nvidia"],
  [/^minimax/i, "minimax"],
];
const HARNESS_LOGOS = { claude: "claudecode", codex: "openai", opencode: "opencode", cursor: "cursor" };

function chestLogoKeys(a) {
  // OpenCode names models "<provider>/<model>"; the family is in the second part.
  const name = a.model.split("/").at(-1);
  const family = MODEL_LOGOS.find(([re]) => re.test(name))?.[1];
  const vendor = a.harness.vendor.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [family, vendor].filter(Boolean);
}

const logos = new Map(); // key → { img, ok, failed }
/** The logo image if it has loaded; starts loading it (and repaints agents when it arrives). */
function logo(key) {
  if (!logos.has(key)) {
    const entry = { img: null, ok: false, failed: false };
    logos.set(key, entry);
    fetch(`/assets/logos/${key}.svg`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then((svg) => {
        // The icons are sized 1em; give them a real size so they rasterise sharply.
        const sized = svg.replace(/\swidth="[^"]*"/, ' width="256"').replace(/\sheight="[^"]*"/, ' height="256"').replace(/currentColor/g, "#1f2430");
        const img = new Image();
        img.onload = () => {
          entry.img = img;
          entry.ok = true;
          for (const rec of agents.values()) paintShirt(rec);
          kick();
        };
        img.onerror = () => (entry.failed = true);
        img.src = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
      })
      .catch(() => (entry.failed = true));
  }
  const e = logos.get(key);
  return e.ok ? e.img : null;
}

/** First loaded logo among keys; null while loading or if none exist. */
function firstLogo(keys) {
  let found = null;
  for (const k of keys) {
    const img = logo(k);
    if (img && !found) found = img;
  }
  return found;
}

// ------------------------------------------------------------------ module state

let container, stage, renderer, scene3d, camera, controls, hemi, sun, nightLights;
let hud = {};
let onSelect = () => {};
let current = null;
let visible = false;
let raf = null;
let lastFrame = 0;
let selectedFloor = null;
let hovered = null;
let popoverFor = null;
let night = localStorage.getItem("studio.night") === "1";
let touring = null;
let tween = null;
let firstUpdate = true;
const floors = new Map(); // worker → { group, y, notes, tv, clockHands, slabMat }
const agents = new Map(); // attemptId → record
const hitTargets = [];
const activityLog = [];
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// ------------------------------------------------------------------ mount

export function mountOffice(el, opts) {
  container = el;
  onSelect = opts.onSelect;
  container.classList.add("office3d");
  stage = esc("div", "o3-stage");
  container.append(stage);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);

  scene3d = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-10, 10, 6, -6, 0.1, 200);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.minZoom = 0.55;
  controls.maxZoom = 3.5;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.3;
  controls.autoRotateSpeed = 0.6;
  controls.addEventListener("change", kick);
  controls.addEventListener("start", stopTour);

  hemi = new THREE.HemisphereLight("#ffffff", "#b8b2a6", 1.6);
  scene3d.add(hemi);
  sun = new THREE.DirectionalLight("#ffffff", 2.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 9, bottom: -9, near: 1, far: 50 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene3d.add(sun, sun.target);
  nightLights = new THREE.Group();
  for (const [x, z] of [[-2, -1], [3, 0], [-5, 2.5]]) {
    const p = new THREE.PointLight("#ffd9a0", 6, 9, 1.6);
    p.position.set(x, 2.6, z);
    nightLights.add(p);
  }
  scene3d.add(nightLights);

  buildHud();
  applyDayNight();
  resetCamera(true);

  new ResizeObserver(resize).observe(stage);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", () => setHovered(null));
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const hit = pick(e);
    showPopover(hit);
  });
  window.addEventListener("keydown", (e) => {
    if (!visible || e.target.closest?.("input, textarea, select")) return;
    if (e.key === "ArrowUp" || e.key === "PageUp") stepFloor(1);
    else if (e.key === "ArrowDown" || e.key === "PageDown") stepFloor(-1);
    else if (e.key === "Escape") showPopover(null);
    else return;
    e.preventDefault();
  });
  document.addEventListener("visibilitychange", kick);
  // The wall clocks show real time; nudge a redraw now and then while the view is open.
  setInterval(kick, 30_000);
}

export function setOfficeVisible(v) {
  visible = v;
  if (v) resize();
  kick();
}

function resize() {
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  renderer.setSize(w, h, false);
  const view = 9; // world units of height in view at zoom 1
  const aspect = w / h;
  camera.left = (-view * aspect) / 2;
  camera.right = (view * aspect) / 2;
  camera.top = view / 2;
  camera.bottom = -view / 2;
  camera.updateProjectionMatrix();
  kick();
}

// ------------------------------------------------------------------ floors

function floorY(worker) {
  return floors.get(worker)?.y ?? 0;
}

function buildFloor(floor, index) {
  const group = new THREE.Group();
  const y = index * FLOOR_GAP;
  group.position.y = y;
  const f = { group, y, index };

  // Slab, rug, walls, railings.
  const slabMat = mat("#eeece8");
  const slab = box(ROOM_W + 0.4, 0.3, ROOM_D + 0.4, slabMat, 0, -0.15, 0);
  slab.castShadow = false;
  group.add(slab);
  const edge = box(ROOM_W + 0.4, 0.06, ROOM_D + 0.4, mat("#d9d6d0"), 0, -0.33, 0);
  group.add(edge);
  const rug = box(3.4, 0.02, 2.4, mat("#c95b4a"), -4.6, 0.01, 2.4);
  rug.castShadow = false;
  group.add(rug);

  const wallMat = mat("#f7f6f3");
  group.add(box(ROOM_W + 0.4, WALL_H, 0.2, wallMat, 0, WALL_H / 2, -ROOM_D / 2 - 0.1));
  group.add(box(0.2, WALL_H, ROOM_D + 0.4, wallMat, -ROOM_W / 2 - 0.1, WALL_H / 2, 0));
  const glass = new THREE.MeshStandardMaterial({ color: "#cfe6f5", transparent: true, opacity: 0.25, roughness: 0.1 });
  const rail = mat("#c9ccd2", { metalness: 0.3, roughness: 0.4 });
  const front = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W + 0.4, 0.8, 0.04), glass);
  front.position.set(0, 0.4, ROOM_D / 2 + 0.18);
  const side = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.8, ROOM_D + 0.4), glass);
  side.position.set(ROOM_W / 2 + 0.18, 0.4, 0);
  group.add(front, side, box(ROOM_W + 0.4, 0.05, 0.07, rail, 0, 0.82, ROOM_D / 2 + 0.18), box(0.07, 0.05, ROOM_D + 0.4, rail, ROOM_W / 2 + 0.18, 0.82, 0));

  // Floor sign on the back wall, like a team name on a real office floor.
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 0.9),
    new THREE.MeshBasicMaterial({
      transparent: true,
      map: canvasTexture(720, 180, (g, w, h) => {
        g.fillStyle = "#1f2430";
        g.textAlign = "left";
        g.textBaseline = "alphabetic";
        g.font = "800 92px system-ui, sans-serif";
        g.fillText(floor.worker, 8, 110);
        const nameW = g.measureText(floor.worker).width;
        g.font = "600 40px system-ui, sans-serif";
        g.fillStyle = "#8a8f9c";
        g.fillText(`Floor ${index + 1}${floor.local ? " · this machine" : ""}`, Math.min(nameW + 28, w - 330), 110);
      }),
    }),
  );
  sign.position.set(-4.2, 2.35, -ROOM_D / 2 + 0.01);
  group.add(sign);

  // Window strip on the back wall.
  f.windowMat = new THREE.MeshStandardMaterial({ color: "#bfe3ff", roughness: 0.2, emissive: "#000000" });
  const win = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.4, 0.04), f.windowMat);
  win.position.set(3.6, 1.75, -ROOM_D / 2 + 0.02);
  group.add(win, box(3.3, 0.06, 0.08, mat("#2b3140"), 3.6, 1.04, -ROOM_D / 2 + 0.04), box(0.05, 1.4, 0.06, mat("#2b3140"), 3.6, 1.75, -ROOM_D / 2 + 0.05));

  // Wall clock with real time.
  const face = cyl(0.32, 0.32, 0.05, mat("#ffffff"), 0, 0, 0, 32);
  face.rotation.x = Math.PI / 2;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.03, 8, 32), mat("#2b3140"));
  const hour = box(0.03, 0.17, 0.01, mat("#1f2430"), 0, 0, 0.04);
  const minute = box(0.02, 0.25, 0.01, mat("#1f2430"), 0, 0, 0.05);
  hour.geometry.translate(0, 0.07, 0);
  minute.geometry.translate(0, 0.11, 0);
  const clockG = new THREE.Group();
  clockG.add(face, rim, hour, minute);
  clockG.position.set(0.6, 2.3, -ROOM_D / 2 + 0.06);
  group.add(clockG);
  f.clockHands = { hour, minute };

  // Wall TV: this floor's board counts (real cards, not activity).
  f.tvMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const tv = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.95, 0.06), [mat("#111"), mat("#111"), mat("#111"), mat("#111"), f.tvMat, mat("#111")]);
  tv.position.set(-0.6, 1.45, -ROOM_D / 2 + 0.06);
  group.add(tv);

  // Kanban board on the left wall.
  const board = box(0.06, 1.5, 3.6, mat("#c49a64"), -ROOM_W / 2 + 0.03, 1.65, -1.3);
  const frame = box(0.04, 1.6, 3.7, mat("#7a5530"), -ROOM_W / 2 + 0.01, 1.65, -1.3);
  group.add(frame, board);
  f.notes = new THREE.Group();
  group.add(f.notes);

  // Desks, chairs, monitors.
  for (const [x, z] of DESKS) group.add(desk(x, z));

  // Coffee corner, lounge and plants.
  group.add(box(2.2, 0.9, 0.6, mat("#e4e1db"), 5.6, 0.45, -3.6), box(2.2, 0.05, 0.62, mat("#bfb8ad"), 5.6, 0.92, -3.6));
  group.add(box(0.35, 0.45, 0.3, mat("#2b2f38"), 5.0, 1.17, -3.65), box(0.12, 0.1, 0.12, mat("#ffffff"), 5.0, 1.0, -3.45));
  for (const [i, c] of ["#e5484d", "#1e86fc", "#f5a524"].entries()) group.add(cyl(0.05, 0.05, 0.1, mat(c), 5.7 + i * 0.18, 1.0, -3.55, 12));
  group.add(box(2.0, 0.4, 0.8, mat("#4f6b8a"), -4.6, 0.3, 3.3), box(2.0, 0.6, 0.2, mat("#46607d"), -4.6, 0.6, 3.75), box(0.2, 0.55, 0.8, mat("#46607d"), -5.6, 0.4, 3.3), box(0.2, 0.55, 0.8, mat("#46607d"), -3.6, 0.4, 3.3));
  group.add(cyl(0.45, 0.45, 0.05, mat("#f2f0ec"), -4.6, 0.42, 2.2, 28), cyl(0.05, 0.05, 0.4, mat("#9aa0aa"), -4.6, 0.2, 2.2));
  for (const [x, z, s] of [[-6.4, 3.4, 1], [6.5, 3.4, 1.2], [6.4, -0.6, 0.9], [-6.4, -3.5, 0.8]]) group.add(plant(x, z, s));

  scene3d.add(group);
  floors.set(floor.worker, f);
  return f;
}

function desk(x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const top = mat("#f4f2ee");
  const leg = mat("#d8d4cc");
  g.add(box(1.6, 0.05, 0.8, top, 0, 0.7, 0), box(0.05, 0.68, 0.72, leg, -0.76, 0.34, 0), box(0.05, 0.68, 0.72, leg, 0.76, 0.34, 0), box(1.5, 0.3, 0.03, leg, 0, 0.5, 0.3));
  // Monitor to the side, so it never covers a shirt print.
  const mon = new THREE.Group();
  // Left of the agent as the camera sees it, so it never stands between you and the shirt.
  mon.position.set(-0.52, 0.72, -0.12);
  mon.rotation.y = -0.55;
  const screenMat = new THREE.MeshStandardMaterial({ color: "#1d2330", roughness: 0.4, emissive: "#000000" });
  mon.add(box(0.06, 0.2, 0.06, mat("#2b2f38"), 0, 0.1, 0.05), box(0.25, 0.02, 0.18, mat("#2b2f38"), 0, 0.01, 0.05));
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.38, 0.035), [mat("#2b2f38"), mat("#2b2f38"), mat("#2b2f38"), mat("#2b2f38"), mat("#2b2f38"), screenMat]);
  screen.position.set(0, 0.38, 0);
  screen.castShadow = true;
  mon.add(screen);
  g.add(mon);
  g.userData.screenMat = screenMat;
  g.add(box(0.5, 0.02, 0.16, mat("#3a3f4b"), 0.05, 0.735, -0.22));
  // Chair behind the desk.
  const chair = new THREE.Group();
  chair.position.set(0, 0, -0.78);
  const dark = mat("#2b2f38");
  chair.add(box(0.5, 0.07, 0.48, dark, 0, 0.46, 0), box(0.5, 0.55, 0.07, dark, 0, 0.78, -0.24), cyl(0.03, 0.03, 0.4, mat("#7d838f"), 0, 0.24, 0, 10), cyl(0.24, 0.24, 0.03, mat("#7d838f"), 0, 0.03, 0, 16));
  g.add(chair);
  g.userData.isDesk = true;
  return g;
}

function plant(x, z, s) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  g.add(cyl(0.22, 0.17, 0.4, mat("#e9e6e0"), 0, 0.2, 0));
  const leaf = mat("#7cc66a");
  g.add(sphere(0.38, leaf, 0, 0.8, 0), sphere(0.28, leaf, 0.18, 1.1, 0.05), sphere(0.24, mat("#6bb85a"), -0.15, 1.15, -0.05));
  return g;
}

/** Sticky notes on the board and the TV numbers, for this floor's projects. */
function paintBoard(f, worker) {
  f.notes.clear();
  const columns = ["backlog", "ready", "doing", "review", "done"];
  const cards = (col) => (current.wall[col] ?? []).filter((c) => c.project.startsWith(`${worker}/`));
  columns.forEach((col, ci) => {
    cards(col).slice(0, 6).forEach((_, k) => {
      const n = box(0.02, 0.18, 0.5, mat(CARD_COLORS[col]), -ROOM_W / 2 + 0.08, 2.2 - k * 0.22, -2.85 + ci * 0.7);
      n.castShadow = false;
      n.rotation.x = ((k * 7 + ci * 3) % 5) * 0.02 - 0.04;
      f.notes.add(n);
    });
  });
  const counts = Object.fromEntries([...columns, "proposed"].map((c) => [c, cards(c).length]));
  const key = JSON.stringify(counts);
  if (f.tvKey === key) return;
  f.tvKey = key;
  f.tvMat.map?.dispose();
  f.tvMat.map = canvasTexture(340, 190, (g, w, h) => {
    g.fillStyle = "#0e1320";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#8a93a8";
    g.font = "700 15px system-ui, sans-serif";
    g.textAlign = "left";
    g.fillText("BOARD", 14, 24);
    const max = Math.max(1, ...columns.map((c) => counts[c]));
    columns.forEach((c, i) => {
      const bh = (counts[c] / max) * 105;
      const x = 18 + i * 64;
      g.fillStyle = CARD_COLORS[c];
      g.fillRect(x, 150 - bh, 40, bh);
      g.fillStyle = "#ffffff";
      g.font = "800 18px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(String(counts[c]), x + 20, 142 - bh);
      g.fillStyle = "#8a93a8";
      g.font = "600 12px system-ui, sans-serif";
      g.fillText(c, x + 20, 170);
    });
    if (counts.proposed) {
      g.fillStyle = "#c7d2ff";
      g.textAlign = "right";
      g.font = "700 14px system-ui, sans-serif";
      g.fillText(`${counts.proposed} proposed`, w - 12, 24);
    }
  });
  f.tvMat.needsUpdate = true;
}

function syncFloors() {
  const names = current.floors.map((f) => f.worker).join("|");
  if (syncFloors.key !== names) {
    for (const f of floors.values()) scene3d.remove(f.group);
    floors.clear();
    current.floors.forEach((fl, i) => buildFloor(fl, i));
    syncFloors.key = names;
  }
  for (const fl of current.floors) {
    const f = floors.get(fl.worker);
    paintBoard(f, fl.worker);
    f.online = fl.online;
  }
  if (selectedFloor === null || !floors.has(selectedFloor)) {
    const waiting = current.agents.find((a) => a.pose === "waiting");
    selectedFloor = waiting?.floor ?? current.floors.find((f) => f.local)?.worker ?? current.floors[0]?.worker ?? null;
    resetCamera(true);
  }
  for (const [name, f] of floors) f.group.visible = name === selectedFloor;
}

// ------------------------------------------------------------------ agents

function appearanceKey(a) {
  return JSON.stringify([a.role, a.roleTitle, a.department, a.harness, a.model, a.look, a.kits.map((k) => k.widget)]);
}

function paintShirt(rec) {
  const a = rec.data;
  const g = rec.shirtCanvas.getContext("2d");
  const w = rec.shirtCanvas.width, h = rec.shirtCanvas.height;
  const color = rec.grey ? "#8a8f99" : a.harness.color;
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  // Collar.
  g.fillStyle = shade(color, -0.12);
  g.fillRect(0, 0, w, 26);
  // Chest print at u = 0.25 (the capsule's front).
  const cx = w * 0.25;
  const mark = firstLogo(chestLogoKeys(a));
  g.save();
  // A white badge keeps any logo readable on any shirt colour.
  g.beginPath();
  g.arc(cx, 138, 36, 0, Math.PI * 2);
  g.fillStyle = "rgba(255,255,255,0.96)";
  g.fill();
  if (mark) g.drawImage(mark, cx - 24, 114, 48, 48);
  else {
    g.fillStyle = color;
    fitText(g, a.harness.vendor.charAt(0), cx, 141, 50, 44, 900);
  }
  g.fillStyle = "#ffffff";
  fitText(g, shortModel(a.model), cx, 210, 170, 38, 800);
  g.restore();
  rec.shirtTex.needsUpdate = true;
  paintCapPatch(rec);
}

/** Round patch on the side of the cap with the harness's logo (Claude Code, Codex...). */
function paintCapPatch(rec) {
  if (!rec.patchCanvas) return;
  const g = rec.patchCanvas.getContext("2d");
  const w = rec.patchCanvas.width;
  g.clearRect(0, 0, w, w);
  const key = HARNESS_LOGOS[rec.data.harness.provider];
  const mark = key ? logo(key) : null;
  rec.patchMesh.visible = !!mark;
  if (!mark) return;
  g.beginPath();
  g.arc(w / 2, w / 2, w / 2 - 4, 0, Math.PI * 2);
  g.fillStyle = "#ffffff";
  g.fill();
  g.drawImage(mark, w * 0.2, w * 0.2, w * 0.6, w * 0.6);
  rec.patchTex.needsUpdate = true;
}

function buildAgent(a) {
  const look = a.look >>> 0;
  const skin = mat(SKIN[look % SKIN.length], { roughness: 0.7 });
  const hairM = mat(HAIR[(look >> 3) % HAIR.length]);
  const pants = mat(PANTS[(look >> 6) % PANTS.length]);
  const capColor = DEPARTMENT_CAPS[a.department] ?? "#3b4252";

  const root = new THREE.Group();
  const body = new THREE.Group(); // bobs and leans
  root.add(body);
  const rec = { root, body, data: a, key: appearanceKey(a), grey: false };

  // Legs: thigh + shin each, so they can sit or stand.
  rec.legs = [-1, 1].map((side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.095, 0.5, 0);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.18, 6, 12), pants);
    thigh.position.y = -0.14;
    thigh.castShadow = true;
    const knee = new THREE.Group();
    knee.position.y = -0.27;
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.16, 6, 12), pants);
    shin.position.y = -0.11;
    shin.castShadow = true;
    const shoe = box(0.13, 0.07, 0.2, mat("#22252c"), 0, -0.22, 0.04);
    knee.add(shin, shoe);
    hip.add(thigh, knee);
    root.add(hip);
    return { hip, knee };
  });

  // Torso with the shirt print painted into its texture.
  rec.shirtCanvas = document.createElement("canvas");
  rec.shirtCanvas.width = 512;
  rec.shirtCanvas.height = 412;
  rec.shirtTex = new THREE.CanvasTexture(rec.shirtCanvas);
  rec.shirtTex.colorSpace = THREE.SRGBColorSpace;
  rec.shirtTex.anisotropy = 8;
  rec.shirtMat = new THREE.MeshStandardMaterial({ map: rec.shirtTex, roughness: 0.9 });
  paintShirt(rec);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.26, 8, 32), rec.shirtMat);
  torso.scale.z = 0.78;
  torso.position.y = 0.82;
  torso.castShadow = true;
  body.add(torso);

  // Arms from the shoulders, sleeves in the shirt colour and hands in skin.
  rec.sleeveMat = new THREE.MeshStandardMaterial({ color: a.harness.color, roughness: 0.9 });
  rec.arms = [-1, 1].map((side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.235, 1.0, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.2, 6, 12), rec.sleeveMat);
    arm.position.y = -0.15;
    arm.castShadow = true;
    const hand = sphere(0.062, skin, 0, -0.3, 0);
    shoulder.add(arm, hand);
    shoulder.rotation.z = side * 0.12;
    body.add(shoulder);
    return shoulder;
  });
  rec.mug = new THREE.Group();
  rec.mug.add(cyl(0.05, 0.045, 0.1, mat("#ffffff"), 0, 0, 0, 12));
  rec.mug.position.set(0, -0.36, 0.04);
  rec.mug.visible = false;
  rec.arms[1].add(rec.mug);

  // Head: face, eyes, smile, hair.
  const head = new THREE.Group();
  head.position.y = 1.27;
  body.add(head);
  rec.head = head;
  head.add(sphere(0.21, skin));
  const hairBall = sphere(0.2, hairM, 0, 0.0, -0.045);
  hairBall.scale.set(1.04, 0.9, 0.95);
  head.add(hairBall);
  const eye = mat("#1b1b1f", { roughness: 0.3 });
  rec.eyes = [-1, 1].map((side) => {
    const e = sphere(0.027, eye, side * 0.072, -0.035, 0.19);
    e.castShadow = false;
    head.add(e);
    return e;
  });
  const cheek = mat("#f29b9b", { transparent: true, opacity: 0.55 });
  for (const side of [-1, 1]) {
    const c = sphere(0.03, cheek, side * 0.12, -0.085, 0.16);
    c.scale.z = 0.4;
    c.castShadow = false;
    head.add(c);
  }
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.009, 6, 16, Math.PI), eye);
  smile.position.set(0, -0.1, 0.185);
  smile.rotation.z = Math.PI;
  head.add(smile);
  rec.smile = smile;

  // Cap: crown in the department colour, brim, and a front panel with the role on it.
  const capMat = mat(capColor, { roughness: 0.8 });
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.228, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
  crown.scale.y = 0.82;
  crown.position.y = 0.07;
  crown.castShadow = true;
  const brim = cyl(0.17, 0.17, 0.022, mat(shade(capColor, -0.08), { roughness: 0.8 }), 0, 0.08, 0.2, 28);
  brim.scale.z = 0.8;
  brim.rotation.x = 0.12;
  const button = sphere(0.025, capMat, 0, 0.255, 0);
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.12),
    new THREE.MeshStandardMaterial({
      transparent: true,
      roughness: 0.8,
      map: canvasTexture(270, 110, (g, w, h) => {
        g.fillStyle = "#ffffff";
        g.beginPath();
        g.roundRect(4, 8, w - 8, h - 16, 18);
        g.fill();
        g.fillStyle = capColor;
        fitText(g, capText(a.roleTitle), w / 2, h / 2 + 2, w - 34, 52, 900);
      }),
    }),
  );
  panel.position.set(0, 0.16, 0.205);
  panel.rotation.x = -0.6;
  head.add(crown, brim, button, panel);
  // Harness patch on the cap (Claude Code, Codex...).
  rec.patchCanvas = document.createElement("canvas");
  rec.patchCanvas.width = rec.patchCanvas.height = 128;
  rec.patchTex = new THREE.CanvasTexture(rec.patchCanvas);
  rec.patchTex.colorSpace = THREE.SRGBColorSpace;
  rec.patchMesh = new THREE.Mesh(new THREE.CircleGeometry(0.058, 24), new THREE.MeshStandardMaterial({ map: rec.patchTex, transparent: true, roughness: 0.8 }));
  // Front-left of the crown, outside the role panel, turned enough toward the camera to read.
  rec.patchMesh.position.set(0.2, 0.115, 0.118);
  rec.patchMesh.rotation.set(-0.25, 1.03, 0);
  rec.patchMesh.visible = false;
  head.add(rec.patchMesh);
  paintCapPatch(rec);

  // Kit widgets on the desk (shown only while seated).
  rec.widgets = new THREE.Group();
  a.kits.forEach((k, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(WIDGETS[k.widget] ?? WIDGETS.toolbox) }));
    s.scale.setScalar(0.2);
    s.position.set(0.3 + i * 0.2, 0.84, 0.95);
    rec.widgets.add(s);
  });
  root.add(rec.widgets);

  // Status bubble.
  rec.bubble = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
  rec.bubble.renderOrder = 10;
  rec.bubble.scale.setScalar(0.38);
  rec.bubble.position.y = 1.9;
  root.add(rec.bubble);

  // Invisible hit target for hovering and clicking.
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.75, 1.7, 0.75), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.9;
  hit.userData.attemptId = a.attemptId;
  root.add(hit);
  hitTargets.push(hit);
  rec.hit = hit;
  rec.phase = (look % 1000) / 159;
  return rec;
}

const emojiCache = new Map();
function emojiTexture(emoji) {
  if (!emojiCache.has(emoji)) {
    emojiCache.set(
      emoji,
      canvasTexture(96, 96, (g) => {
        g.font = '72px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(emoji, 48, 54);
      }),
    );
  }
  return emojiCache.get(emoji);
}

const bubbleCache = new Map();
/** A round badge in the state's colour with a white glyph, like a chat-status dot. */
function bubbleTexture(bubble, pose) {
  const key = `${bubble}|${pose}`;
  if (bubbleCache.has(key)) return bubbleCache.get(key);
  const color = bubble === "bars" ? "#14b8a6" : bubble === "idea" ? "#6366f1" : POSE[pose]?.color ?? "#94a3b8";
  const t = canvasTexture(128, 128, (g) => {
    g.shadowColor = "rgba(0,0,0,0.25)";
    g.shadowBlur = 8;
    g.shadowOffsetY = 3;
    g.beginPath();
    g.arc(64, 60, 50, 0, Math.PI * 2);
    g.fillStyle = "#ffffff";
    g.fill();
    g.shadowColor = "transparent";
    g.beginPath();
    g.arc(64, 60, 42, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.fillStyle = "#ffffff";
    g.strokeStyle = "#ffffff";
    g.lineCap = "round";
    g.lineJoin = "round";
    g.lineWidth = 9;
    switch (bubble) {
      case "dots":
        for (const x of [42, 64, 86]) {
          g.beginPath();
          g.arc(x, 60, 7, 0, Math.PI * 2);
          g.fill();
        }
        break;
      case "bars": // running tests
        [[44, 22], [60, 34], [76, 16]].forEach(([x, hgt]) => g.fillRect(x, 78 - hgt, 10, hgt));
        g.fillRect(40, 80, 50, 5);
        break;
      case "idea": // thinking
        g.beginPath();
        g.arc(64, 52, 16, 0, Math.PI * 2);
        g.fill();
        g.fillRect(57, 68, 14, 12);
        break;
      case "exclamation":
        g.fillRect(58, 30, 12, 34);
        g.beginPath();
        g.arc(64, 80, 7, 0, Math.PI * 2);
        g.fill();
        break;
      case "star": // done: a check mark
        g.lineWidth = 11;
        g.beginPath();
        g.moveTo(42, 62);
        g.lineTo(58, 77);
        g.lineTo(88, 44);
        g.stroke();
        break;
      case "cross":
        g.lineWidth = 11;
        g.beginPath();
        g.moveTo(46, 42);
        g.lineTo(82, 78);
        g.moveTo(82, 42);
        g.lineTo(46, 78);
        g.stroke();
        break;
      case "hourglass":
        g.beginPath();
        g.moveTo(46, 36);
        g.lineTo(82, 36);
        g.lineTo(46, 84);
        g.lineTo(82, 84);
        g.closePath();
        g.fill();
        break;
      case "plug":
        g.fillRect(52, 34, 7, 16);
        g.fillRect(69, 34, 7, 16);
        g.beginPath();
        g.roundRect(44, 48, 40, 22, 6);
        g.fill();
        g.fillRect(60, 68, 8, 16);
        break;
      default:
        fitText(g, bubble === "question" ? "?" : bubble === "sleep" ? "z" : "", 64, 64, 70, 64, 900);
    }
  });
  bubbleCache.set(key, t);
  return t;
}

function placeAgent(rec) {
  const a = rec.data;
  let x = 0, z = 0, ry = 0, seated = false;
  if (a.desk != null) {
    const [dx, dz] = DESKS[a.desk] ?? DESKS[0];
    x = dx;
    z = dz - 0.78;
    ry = 0.42; // turned a little toward the camera, so the shirt print faces you
    seated = true;
  } else if (a.visiting && "place" in a.visiting) {
    x = BOARD_SPOT.x;
    z = BOARD_SPOT.z;
    ry = BOARD_SPOT.ry;
  } else if (a.visiting) {
    const host = current.agents.find((h) => h.attemptId === a.visiting.attemptId);
    const [dx, dz] = DESKS[host?.desk ?? 0];
    // Looking over the shoulder of the work being reviewed.
    x = dx + 0.95;
    z = dz - 0.45;
    ry = -0.85;
  }
  rec.seated = seated;
  rec.root.position.set(x, 0, z);
  rec.root.scale.setScalar(AGENT_SCALE);
  rec.root.rotation.y = ry;
  rec.widgets.visible = seated;
  for (const l of rec.legs) {
    l.hip.rotation.x = seated ? -Math.PI / 2 : 0;
    l.knee.rotation.x = seated ? Math.PI / 2 : 0;
  }
}

function applyPose(rec) {
  const a = rec.data;
  const grey = a.pose === "offline" || a.pose === "failed";
  if (grey !== rec.grey) {
    rec.grey = grey;
    paintShirt(rec);
    rec.sleeveMat.color.set(grey ? "#8a8f99" : a.harness.color);
  }
  rec.bubble.material.map = a.bubble ? bubbleTexture(a.bubble, a.pose) : null;
  rec.bubble.visible = !!a.bubble;
  rec.bubble.material.needsUpdate = true;
  rec.mug.visible = a.pose === "break";
  rec.smile.rotation.z = a.pose === "failed" ? 0 : Math.PI;
  rec.smile.position.y = a.pose === "failed" ? -0.125 : -0.1;
  // Screen on while working, dim otherwise.
  const f = floors.get(a.floor);
  if (f && a.desk != null) {
    const deskObj = f.group.children.filter((c) => c.userData.isDesk)[a.desk];
    const sm = deskObj?.userData.screenMat;
    if (sm) sm.emissive.set(a.pose === "working" ? "#3aa0ff" : a.pose === "waiting" ? "#b97a10" : "#000000");
  }
  rec.screenDesk = a.desk;
}

function resetScreens() {
  for (const f of floors.values()) for (const d of f.group.children) if (d.userData.isDesk) d.userData.screenMat.emissive.set("#000000");
}

function syncAgents() {
  const seen = new Set();
  resetScreens();
  for (const a of current.agents) {
    seen.add(a.attemptId);
    let rec = agents.get(a.attemptId);
    if (rec && rec.key !== appearanceKey(a)) {
      removeAgent(a.attemptId);
      rec = null;
    }
    if (!rec) {
      rec = buildAgent(a);
      agents.set(a.attemptId, rec);
    }
    rec.data = a;
    const f = floors.get(a.floor);
    if (f && rec.root.parent !== f.group) f.group.add(rec.root);
    placeAgent(rec);
    applyPose(rec);
  }
  for (const id of [...agents.keys()]) if (!seen.has(id)) removeAgent(id);
}

function removeAgent(id) {
  const rec = agents.get(id);
  if (!rec) return;
  rec.root.removeFromParent();
  hitTargets.splice(hitTargets.indexOf(rec.hit), 1);
  rec.shirtTex.dispose();
  agents.delete(id);
  if (hovered === id) setHovered(null);
  if (popoverFor === id) showPopover(null);
}

/** Per-frame motion. Small and cheap: typing, a bounce when it needs you, a slump when failed. */
function animate(t) {
  const s = t / 1000;
  for (const rec of agents.values()) {
    const a = rec.data;
    const p = rec.phase;
    const [l, r] = rec.arms;
    rec.body.position.y = 0;
    rec.body.rotation.x = 0;
    rec.head.rotation.set(0, 0, 0);
    rec.bubble.scale.setScalar(0.38);
    for (const e of rec.eyes) e.scale.y = 1;
    if (rec.seated) {
      // Arms forward to the keyboard.
      l.rotation.set(-1.15, 0, -0.1);
      r.rotation.set(-1.15, 0, 0.1);
    } else {
      l.rotation.set(0.05, 0, -0.12);
      r.rotation.set(0.05, 0, 0.12);
    }
    switch (a.pose) {
      case "working":
        if (rec.seated) {
          l.rotation.x = -1.15 + Math.sin(s * 14 + p) * 0.1;
          r.rotation.x = -1.15 + Math.sin(s * 14 + p + 2) * 0.1;
          rec.head.rotation.x = Math.sin(s * 1.6 + p) * 0.05;
          rec.head.rotation.y = Math.sin(s * 0.7 + p) * 0.12;
        } else {
          // A reviewer or planner: hand on chin, looking around the work.
          r.rotation.set(-2.1, 0, 0.55);
          rec.head.rotation.y = Math.sin(s * 0.8 + p) * 0.35;
          rec.body.position.y = Math.abs(Math.sin(s * 1.2 + p)) * 0.01;
        }
        break;
      case "waiting": {
        rec.body.position.y = Math.abs(Math.sin(s * 4 + p)) * 0.06;
        r.rotation.set(-2.9 + Math.sin(s * 8) * 0.15, 0, 0.25); // hand up
        rec.bubble.scale.setScalar(0.38 * (1 + Math.max(0, Math.sin(s * 5)) * 0.18));
        break;
      }
      case "break":
        rec.body.rotation.x = -0.12;
        r.rotation.set(-1.9 + Math.sin(s * 0.8) * 0.15, 0, 0.35); // mug
        for (const e of rec.eyes) e.scale.y = 0.3;
        break;
      case "failed":
      case "offline":
        rec.head.rotation.x = 0.35;
        rec.body.rotation.x = 0.08;
        l.rotation.x = rec.seated ? -0.6 : 0;
        r.rotation.x = rec.seated ? -0.6 : 0;
        break;
      case "unknown":
        rec.head.rotation.z = Math.sin(s * 1.5 + p) * 0.18;
        break;
      case "done":
        l.rotation.set(-0.4, 0, -0.5);
        r.rotation.set(-0.4, 0, 0.5);
        rec.body.rotation.x = -0.08;
        break;
      default:
        break;
    }
    // Hover highlight.
    const hl = hovered === a.attemptId || popoverFor === a.attemptId;
    rec.shirtMat.emissive.set(hl ? "#2a2a2a" : "#000000");
  }
  for (const f of floors.values()) {
    const d = new Date();
    f.clockHands.hour.rotation.z = -((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6);
    f.clockHands.minute.rotation.z = -d.getMinutes() * (Math.PI / 30);
  }
}

// ------------------------------------------------------------------ camera

function resetCamera(instant = false) {
  const y = floorY(selectedFloor);
  const target = new THREE.Vector3(0.2, y + 1.6, -0.4);
  const pos = target.clone().add(new THREE.Vector3(17, 17, 19));
  if (instant) {
    controls.target.copy(target);
    camera.position.copy(pos);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    placeSun(y);
    controls.update();
    kick();
    return;
  }
  tween = { t0: performance.now(), dur: 650, fromT: controls.target.clone(), toT: target, fromP: camera.position.clone(), toP: pos, fromZ: camera.zoom, toZ: 1 };
  placeSun(y);
  kick();
}

/** Move to another floor, keeping your current angle and zoom. */
function goToFloor(worker) {
  if (!floors.has(worker)) return;
  const dy = floorY(worker) - floorY(selectedFloor);
  selectedFloor = worker;
  for (const [name, f] of floors) f.group.visible = name === worker;
  showPopover(null);
  setHovered(null);
  const toT = controls.target.clone();
  toT.y += dy;
  const toP = camera.position.clone();
  toP.y += dy;
  tween = { t0: performance.now(), dur: 550, fromT: controls.target.clone(), toT, fromP: camera.position.clone(), toP };
  placeSun(floorY(worker));
  renderHud();
  kick();
}

function stepFloor(dir) {
  const list = current?.floors ?? [];
  const i = list.findIndex((f) => f.worker === selectedFloor);
  const next = list[i + dir];
  if (next) goToFloor(next.worker);
}

function placeSun(y) {
  sun.position.set(7, y + 15, 9);
  sun.target.position.set(0, y, 0);
  sun.target.updateMatrixWorld();
  nightLights.position.y = y;
}

function stepTween(now) {
  if (!tween) return false;
  const k = Math.min(1, (now - tween.t0) / tween.dur);
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  controls.target.lerpVectors(tween.fromT, tween.toT, e);
  camera.position.lerpVectors(tween.fromP, tween.toP, e);
  if (tween.toZ) {
    camera.zoom = tween.fromZ + (tween.toZ - tween.fromZ) * e;
    camera.updateProjectionMatrix();
  }
  if (k >= 1) tween = null;
  return true;
}

function startTour() {
  stopTour();
  controls.autoRotate = true;
  let i = 0;
  touring = setInterval(() => {
    const list = current?.floors ?? [];
    if (list.length > 1) goToFloor(list[++i % list.length].worker);
  }, 7000);
  hud.tour.classList.add("on");
  kick();
}

function stopTour() {
  if (!touring && !controls.autoRotate) return;
  clearInterval(touring);
  touring = null;
  controls.autoRotate = false;
  hud.tour?.classList.remove("on");
}

// ------------------------------------------------------------------ render loop

function active() {
  return visible && !document.hidden && current;
}

function animating() {
  return [...agents.values()].some((r) => r.data.floor === selectedFloor && ["working", "waiting", "unknown", "break"].includes(r.data.pose));
}

function kick() {
  if (!raf && active()) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = null;
  if (!active()) return;
  const moving = stepTween(now);
  const damping = controls.update();
  const busy = moving || damping || controls.autoRotate;
  // Idle animation runs at a gentle frame rate; camera moves run at full rate.
  if (busy || now - lastFrame >= 1000 / ANIM_FPS || !lastFrame) {
    lastFrame = now;
    animate(now);
    renderer.render(scene3d, camera);
    positionOverlays();
  }
  if (busy || animating()) raf = requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ picking

function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const targets = hitTargets.filter((h) => agents.get(h.userData.attemptId)?.data.floor === selectedFloor);
  return raycaster.intersectObjects(targets, false)[0]?.object.userData.attemptId ?? null;
}

function onPointerMove(e) {
  if (e.buttons) return;
  setHovered(pick(e));
}

function setHovered(id) {
  if (id === hovered) return;
  hovered = id;
  renderer.domElement.style.cursor = id ? "pointer" : "grab";
  hud.hoverTag.hidden = !id || id === popoverFor;
  if (id) {
    const a = agents.get(id).data;
    hud.hoverTag.replaceChildren(esc("strong", "", a.roleTitle), esc("span", "", a.doing ?? a.status));
  }
  kick();
  positionOverlays();
}

/** Screen position of a point above an agent's head. */
function screenOf(id, lift = 2.15) {
  const rec = agents.get(id);
  if (!rec) return null;
  const v = new THREE.Vector3(0, lift, 0);
  rec.root.localToWorld(v);
  v.project(camera);
  return { x: ((v.x + 1) / 2) * stage.clientWidth, y: ((1 - v.y) / 2) * stage.clientHeight };
}

function positionOverlays() {
  if (hovered && !hud.hoverTag.hidden) {
    const p = screenOf(hovered);
    if (p) Object.assign(hud.hoverTag.style, { left: `${p.x}px`, top: `${p.y}px` });
  }
  if (popoverFor) {
    const p = screenOf(popoverFor);
    if (p) {
      // Above the head when there is room under the top bar; otherwise beside the agent.
      const w = hud.popover.offsetWidth, h = hud.popover.offsetHeight;
      const above = p.y - h - 10 > 56;
      const x = Math.min(Math.max(p.x, w / 2 + 250), stage.clientWidth - w / 2 - 310);
      Object.assign(hud.popover.style, above
        ? { left: `${x}px`, top: `${p.y}px`, transform: "translate(-50%, calc(-100% - 10px))" }
        : { left: `${Math.min(p.x + 40, stage.clientWidth - w - 310)}px`, top: `${Math.max(p.y, 60)}px`, transform: "none" });
    }
  }
}

function showPopover(id) {
  popoverFor = id;
  hud.popover.hidden = !id;
  if (!id) return kick();
  hud.hoverTag.hidden = true;
  const a = agents.get(id).data;
  const pose = POSE[a.pose] ?? POSE.preparing;
  const kits = a.kits.map((k) => `${WIDGETS[k.widget] ?? WIDGETS.toolbox} ${k.title}`).join("  ");
  const open = esc("button", "o3-primary", a.pose === "waiting" ? "Review request" : a.pose === "done" ? "Review result" : "Open job");
  open.addEventListener("click", () => {
    showPopover(null);
    onSelect(a.attemptId);
  });
  const close = esc("button", "o3-x", "✕");
  close.title = "Close";
  close.addEventListener("click", () => showPopover(null));
  const status = esc("div", "o3-pop-status", pose.label);
  status.style.color = pose.color;
  hud.popover.replaceChildren(
    close,
    esc("div", "o3-pop-title", a.jobTitle),
    esc("div", "o3-pop-sub", `${a.roleTitle}${a.department ? ` · ${a.department}` : ""}`),
    status,
    a.doing ? esc("div", "o3-pop-doing", a.doing) : "",
    esc("div", "o3-pop-meta", `${a.harness.label} · ${shortModel(a.model)}`),
    kits ? esc("div", "o3-pop-meta", kits) : "",
    open,
  );
  positionOverlays();
  kick();
}

/** Turn the camera toward one agent (from the floor panel). */
function focusAgent(id) {
  const rec = agents.get(id);
  if (!rec) return;
  if (rec.data.floor !== selectedFloor) goToFloor(rec.data.floor);
  const p = new THREE.Vector3();
  rec.root.getWorldPosition(p);
  p.y += 0.8;
  const off = camera.position.clone().sub(controls.target);
  tween = { t0: performance.now(), dur: 500, fromT: controls.target.clone(), toT: p, fromP: camera.position.clone(), toP: p.clone().add(off) };
  camera.zoom = Math.max(camera.zoom, 1.6);
  camera.updateProjectionMatrix();
  setTimeout(() => showPopover(id), 520);
  kick();
}

// ------------------------------------------------------------------ HUD

function buildHud() {
  const h = (cls, ...kids) => {
    const el = esc("div", cls);
    el.append(...kids);
    return el;
  };
  hud.title = h("o3-panel o3-title");
  hud.modes = h("o3-panel o3-modes");
  const day = esc("button", "", "☀ Day");
  const nightB = esc("button", "", "☾ Night");
  hud.tour = esc("button", "", "▶ Tour");
  day.addEventListener("click", () => setNight(false));
  nightB.addEventListener("click", () => setNight(true));
  hud.tour.addEventListener("click", () => (touring || controls.autoRotate ? stopTour() : startTour()));
  hud.day = day;
  hud.nightB = nightB;
  hud.modes.append(day, nightB, hud.tour);
  hud.counters = h("o3-panel o3-counters");
  hud.left = h("o3-left");
  hud.floorPanel = h("o3-floor-panel");
  hud.activity = h("o3-panel o3-activity");
  hud.hint = h("o3-panel o3-hint");
  hud.hint.innerHTML = "<b>Drag</b> rotate <b>Right-drag</b> move <b>Scroll</b> zoom <b>↑ ↓</b> floors <b>Click</b> an agent";
  hud.zoom = h("o3-zoom");
  for (const [label, title, fn] of [
    ["+", "Zoom in", () => zoomBy(1.25)],
    ["−", "Zoom out", () => zoomBy(0.8)],
    ["⟲", "Reset view", () => resetCamera()],
  ]) {
    const b = esc("button", "o3-panel", label);
    b.title = title;
    b.addEventListener("click", fn);
    hud.zoom.append(b);
  }
  hud.banner = h("o3-banner");
  hud.banner.hidden = true;
  hud.empty = h("o3-empty");
  hud.empty.hidden = true;
  hud.hoverTag = h("o3-hover");
  hud.hoverTag.hidden = true;
  hud.popover = h("o3-panel o3-popover");
  hud.popover.hidden = true;
  const top = h("o3-top", hud.title, hud.modes, hud.counters);
  stage.append(top, hud.left, hud.floorPanel, hud.activity, hud.hint, hud.zoom, hud.banner, hud.empty, hud.hoverTag, hud.popover);
  hud.collapsed = JSON.parse(localStorage.getItem("studio.hud.collapsed") ?? '{"finished":true}');
}

function zoomBy(k) {
  camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, camera.zoom * k));
  camera.updateProjectionMatrix();
  kick();
}

function setNight(v) {
  night = v;
  localStorage.setItem("studio.night", v ? "1" : "0");
  applyDayNight();
  kick();
}

function applyDayNight() {
  container.classList.toggle("o3-night", night);
  hud.day.classList.toggle("on", !night);
  hud.nightB.classList.toggle("on", night);
  const bg = night ? "#0f1320" : "#e7e7ea";
  renderer.setClearColor(bg);
  scene3d.background = new THREE.Color(bg);
  hemi.intensity = night ? 0.45 : 1.6;
  hemi.color.set(night ? "#8ea2ff" : "#ffffff");
  sun.intensity = night ? 0.35 : 2.0;
  sun.color.set(night ? "#9fb3ff" : "#ffffff");
  nightLights.visible = night;
  for (const f of floors.values()) {
    f.windowMat.color.set(night ? "#1b2747" : "#bfe3ff");
    f.windowMat.emissive.set(night ? "#0c1430" : "#000000");
  }
}

function collapsible(id, title, count, body) {
  const wrap = esc("div", "o3-panel o3-section");
  const head = esc("button", "o3-section-head");
  const open = !hud.collapsed[id];
  head.append(esc("span", "", title), esc("span", `o3-count${count && id === "waiting" ? " warn" : ""}`, String(count)), esc("span", "o3-chev", open ? "▴" : "▾"));
  head.addEventListener("click", () => {
    hud.collapsed[id] = open;
    localStorage.setItem("studio.hud.collapsed", JSON.stringify(hud.collapsed));
    renderHud();
  });
  wrap.append(head);
  if (open) wrap.append(body);
  return wrap;
}

function agentRow(a, action) {
  const row = esc("div", "o3-row");
  const dot = esc("span", "o3-avatar");
  dot.style.background = a.harness.color;
  const st = esc("i", "");
  st.style.background = (POSE[a.pose] ?? POSE.preparing).color;
  dot.append(st);
  const text = esc("div", "o3-row-text");
  text.append(esc("div", "o3-row-name", a.roleTitle), esc("div", "o3-row-sub", `${(POSE[a.pose] ?? POSE.preparing).label} · ${a.doing ?? a.jobTitle}`));
  row.append(dot, text);
  if (action) {
    const b = esc("button", "o3-mini", action);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onSelect(a.attemptId);
    });
    row.append(b);
  }
  row.addEventListener("click", () => focusAgent(a.attemptId));
  return row;
}

function renderHud() {
  if (!current) return;
  const all = current.agents;
  const count = (pose) => all.filter((a) => a.pose === pose).length;

  hud.title.replaceChildren(esc("span", "o3-logo", "◆"), esc("strong", "", "Studio Office"), esc("span", "o3-live", `Live · ${clock()}`));

  const chips = [
    ["working", count("working"), "working"],
    ["waiting", count("waiting"), "need you"],
    ["failed", count("failed"), "failed"],
    ["done", count("done"), "to review"],
    ["break", count("break"), "on a break"],
    ["unknown", count("unknown") + count("offline"), "unknown"],
  ];
  hud.counters.replaceChildren(
    ...chips
      .filter(([pose, n]) => n || pose === "working" || pose === "waiting" || pose === "failed")
      .map(([pose, n, label]) => {
        const c = esc("span", "o3-chip");
        const d = esc("i", "");
        d.style.background = POSE[pose].color;
        c.append(d, esc("b", "", String(n)), ` ${label}`);
        return c;
      }),
  );

  // Floors, top floor first like a building directory.
  const floorsEl = esc("div", "o3-panel o3-floors");
  floorsEl.append(esc("div", "o3-head", "Floors"));
  [...current.floors].reverse().forEach((fl) => {
    const i = current.floors.indexOf(fl);
    const here = all.filter((a) => a.floor === fl.worker);
    const row = esc("button", `o3-floor${fl.worker === selectedFloor ? " on" : ""}${fl.online ? "" : " off"}`);
    const dots = esc("span", "o3-dots");
    for (const a of here) {
      const d = esc("i", "");
      d.style.background = (POSE[a.pose] ?? POSE.preparing).color;
      dots.append(d);
    }
    const name = esc("span", "o3-floor-name");
    name.append(esc("span", "", fl.worker), dots);
    row.append(esc("span", "o3-num", String(i + 1)), name, esc("span", "o3-cap", fl.online ? `${here.length}/${fl.desks}` : "offline"));
    row.addEventListener("click", () => goToFloor(fl.worker));
    floorsEl.append(row);
  });

  const waiting = all.filter((a) => a.pose === "waiting");
  const wBody = esc("div", "o3-list");
  if (waiting.length) waiting.forEach((a) => wBody.append(agentRow(a, "Review")));
  else wBody.append(esc("div", "o3-none", "Nothing needs you"));
  const done = all.filter((a) => a.pose === "done" || a.pose === "failed");
  const dBody = esc("div", "o3-list");
  if (done.length) done.forEach((a) => dBody.append(agentRow(a, "Open")));
  else dBody.append(esc("div", "o3-none", "Nothing finished yet"));
  hud.left.replaceChildren(floorsEl, collapsible("waiting", "Needs you", waiting.length, wBody), collapsible("finished", "Finished", done.length, dBody));

  // The selected floor's people.
  const fl = current.floors.find((f) => f.worker === selectedFloor);
  if (!fl) {
    // No machines paired: an empty lot, not a pretend office.
    hud.floorPanel.replaceChildren();
    hud.banner.hidden = true;
    hud.empty.hidden = false;
    hud.empty.textContent = "No machines yet. Pair one under Workers (left) and its floor appears here.";
  }
  if (fl) {
    const here = all.filter((a) => a.floor === fl.worker);
    const working = here.filter((a) => a.pose === "working").length;
    const head = esc("div", `o3-fp-head${fl.online ? "" : " off"}`);
    const l = esc("div", "");
    l.append(esc("div", "o3-fp-name", fl.worker), esc("div", "o3-fp-big", fl.online ? `${working} working` : "unreachable"));
    head.append(l, esc("div", "o3-fp-meta", `Floor ${current.floors.indexOf(fl) + 1} · ${here.length} agent${here.length === 1 ? "" : "s"}`));
    const list = esc("div", "o3-list");
    for (const a of here) list.append(agentRow(a, a.pose === "waiting" ? "Review" : null));
    if (!here.length) list.append(esc("div", "o3-none", "No one at work on this floor"));
    const panel = esc("div", "o3-panel");
    panel.append(head, list);
    hud.floorPanel.replaceChildren(panel);
    hud.banner.hidden = fl.online;
    hud.banner.textContent = fl.online ? "" : `This machine is unreachable: ${fl.error ?? "offline"}`;
    hud.empty.hidden = !fl.online || here.length > 0;
    hud.empty.textContent = "No one at work on this floor";
  }

  hud.activity.replaceChildren(esc("div", "o3-head", "Activity"));
  const items = activityLog.slice(0, 6);
  if (!items.length) hud.activity.append(esc("div", "o3-none", "Changes show up here as they happen"));
  for (const it of items) {
    const row = esc("div", "o3-act");
    row.append(esc("span", "o3-time", it.time), esc("b", "", it.who), ` · ${it.what}`);
    if (it.id) row.addEventListener("click", () => agents.has(it.id) && focusAgent(it.id));
    hud.activity.append(row);
  }
}

/** Log what changed since the last scene: arrivals, state changes, new activity lines, departures. */
function logChanges(prev, next) {
  if (firstUpdate) {
    firstUpdate = false;
    return;
  }
  const before = new Map((prev?.agents ?? []).map((a) => [a.attemptId, a]));
  const after = new Map(next.agents.map((a) => [a.attemptId, a]));
  const now = clock();
  const add = (a, what) => activityLog.unshift({ time: now, who: a.roleTitle, what, id: a.attemptId });
  for (const a of next.agents) {
    const b = before.get(a.attemptId);
    if (!b) add(a, `arrived: ${a.jobTitle}`);
    else if (b.pose !== a.pose) add(a, (POSE[a.pose] ?? POSE.preparing).label);
    else if (a.doing && a.doing !== b.doing) add(a, a.doing);
  }
  for (const [id, b] of before) if (!after.has(id)) activityLog.unshift({ time: now, who: b.roleTitle, what: "went home", id: null });
  activityLog.length = Math.min(activityLog.length, 40);
}

// ------------------------------------------------------------------ public update

export function updateOffice(next) {
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (!changed) {
    renderHud(); // the clock
    return;
  }
  logChanges(current, next);
  current = next;
  syncFloors();
  syncAgents();
  if (popoverFor && agents.has(popoverFor)) showPopover(popoverFor);
  renderHud();
  kick();
}
