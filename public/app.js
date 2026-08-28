import { segmentsFrom } from "/lib/extract.js";
import {
  attachChild,
  cameraPanToInclude,
  clampCameraToGraph,
  edgePath,
  fitCameraToBounds,
  hopsBetween,
  layoutTrail,
} from "/lib/layout.js";
import { buildShowcaseTree, showcaseWalk } from "/lib/demo-tree.js";

const svgNS = "http://www.w3.org/2000/svg";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEFAULT_ACCENT = "#ff4fcb";
const PALETTE = [
  { id: "pink", hex: "#ff4fcb" },
  { id: "red", hex: "#ff4d4d" },
  { id: "orange", hex: "#ff8a3a" },
  { id: "yellow", hex: "#f5d76e" },
  { id: "green", hex: "#3ddc97" },
  { id: "blue", hex: "#4d9fff" },
  { id: "purple", hex: "#b57bff" },
  { id: "white", hex: "#f4f4f6" },
];
const SHAPES = [
  { id: "tree", label: "Tree" },
  { id: "circle", label: "Circle" },
];

function nearestPalette(hex) {
  const want = String(hex || "").toLowerCase();
  const exact = PALETTE.find((c) => c.hex === want);
  if (exact) return exact.hex;
  const toRgb = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  let best = DEFAULT_ACCENT;
  let bestDist = Infinity;
  const [r, g, b] = /^#[0-9a-f]{6}$/.test(want) ? toRgb(want) : [255, 79, 203];
  for (const color of PALETTE) {
    const [cr, cg, cb] = toRgb(color.hex);
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = color.hex;
    }
  }
  return best;
}

const els = {
  svg: document.getElementById("map"),
  session: document.getElementById("session"),
  demo: document.getElementById("btn-demo"),
  liveStatus: document.getElementById("live"),
  peek: document.getElementById("peek"),
  menu: document.getElementById("overflow-menu"),
  stage: document.getElementById("stage"),
  palette: document.getElementById("palette"),
  colorPick: document.getElementById("color-pick"),
  colorCurrent: document.getElementById("color-current"),
  opacity: document.getElementById("opacity"),
  opacityOut: document.getElementById("opacity-out"),
  themeSeg: document.getElementById("theme-seg"),
  shape: document.getElementById("shape"),
  center: document.getElementById("btn-center"),
  face: document.getElementById("agent-face"),
  faceWrap: document.getElementById("agent-face-wrap"),
  faceBtn: document.getElementById("agent-face-btn"),
  faceMenu: document.getElementById("face-menu"),
  settings: document.getElementById("settings"),
  settingsBtn: document.getElementById("btn-settings"),
  settingsTray: document.getElementById("settings-tray"),
  settingsPicker: document.getElementById("settings-picker"),
  instrument: document.querySelector(".instrument"),
  followSeg: document.getElementById("follow-seg"),
  sessionPicker: document.getElementById("session-picker"),
  sessionSearch: document.getElementById("session-search"),
  sessionList: document.getElementById("session-list"),
  pickerScrim: document.getElementById("picker-scrim"),
};

const camera = { x: 0, y: 0, k: 1 };
let userMovedCamera = false;
let pendingCenter = false;
const state = {
  mode: "live",
  rootId: "",
  rootPath: "",
  nodes: new Map(),
  parentOf: new Map(),
  expanded: new Set(),
  lastFocus: new Map(),
  userPins: new Set(),
  visited: new Map(),
  visitedEdges: new Set(),
  agents: new Map(),
  hidden: new Map(),
  shown: new Map(),
  layout: null,
  log: [],
  accent: DEFAULT_ACCENT,
  agentSymbol: null,
  shape: "tree",
  theme: "system",
  opacity: 0.96,
  graphFollow: "focus",
  settingsHidden: false,
  sessionId: null,
  sessions: [],
};

const queues = new Map();
let seq = 0;
let demoTimer = 0;

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

const defs = el("defs", {}, els.svg);
const cameraG = el("g", { id: "camera" }, els.svg);
const edgeG = el("g", { id: "edges" }, cameraG);
const nodeG = el("g", { id: "nodes" }, cameraG);
const moreG = el("g", { id: "more" }, cameraG);
const agentG = el("g", { id: "agents" }, cameraG);
const graphEls = { nodes: new Map(), edges: new Map() };
let camGen = 0;
let morphGen = 0;
let trailEpoch = 0;
let lastStage = { w: 0, h: 0 };

el("marker", { id: "dot", viewBox: "0 0 6 6", refX: "3", refY: "3", markerWidth: "6", markerHeight: "6" }, defs);
const agentClip = el("clipPath", { id: "agent-clip" }, defs);
el("circle", { r: "11", cx: "0", cy: "0" }, agentClip);
const hitFill = el("rect", {
  class: "hitfill",
  x: "0",
  y: "0",
  width: "4000",
  height: "4000",
  fill: "#0a0a0c",
});
els.svg.insertBefore(hitFill, cameraG);

function applyCamera() {
  cameraG.setAttribute(
    "transform",
    `translate(${camera.x.toFixed(1)} ${camera.y.toFixed(1)}) scale(${camera.k.toFixed(3)})`,
  );
}

function graphWorldBounds(laid = state.layout) {
  if (!laid?.pos?.size) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // Equal halo so the bbox center is the node-position center. An extra
  // right pad here (old 40/86) shifted the fitted graph left of the view.
  const hx = 48;
  const hy = 28;
  for (const p of laid.pos.values()) {
    minX = Math.min(minX, p.x - hx);
    maxX = Math.max(maxX, p.x + hx);
    minY = Math.min(minY, p.y - hy);
    maxY = Math.max(maxY, p.y + hy);
  }
  return { minX, minY, maxX, maxY };
}

function confineCamera() {
  const bounds = graphWorldBounds();
  if (!bounds) return;
  const next = clampCameraToGraph({
    bounds,
    view: stageSize(),
    camera,
    margin: 72,
  });
  camera.x = next.x;
  camera.y = next.y;
  applyCamera();
}

function stageReady() {
  const { w, h } = stageSize();
  return w >= 80 && h >= 80;
}

function whenStageReady(fn) {
  const tick = (n = 0) => {
    if (stageReady()) {
      fn();
      return;
    }
    if (n > 180) return;
    requestAnimationFrame(() => tick(n + 1));
  };
  tick();
}

function syncHitFill() {
  const { w, h } = stageSize();
  hitFill.setAttribute("x", "0");
  hitFill.setAttribute("y", "0");
  hitFill.setAttribute("width", String(Math.max(w, 8)));
  hitFill.setAttribute("height", String(Math.max(h, 8)));
}

function agentsBusy() {
  for (const agent of state.agents.values()) {
    if (agent.traveling || agent.targetId) return true;
  }
  return false;
}

function fitToStage({ tween = false } = {}) {
  if (!state.layout || !stageReady()) return Promise.resolve();
  const { w, h } = stageSize();
  lastStage = { w, h };
  syncHitFill();
  return tweenCamera(cameraTarget(state.layout), tween ? 360 : 0);
}

function snapCameraToLayout(laid) {
  if (!laid || !stageReady()) return;
  Object.assign(camera, cameraTarget(laid));
  applyCamera();
  lastStage = stageSize();
  syncHitFill();
}

function scheduleFit() {
  pendingCenter = true;
  whenStageReady(() => {
    if (!state.layout || userMovedCamera) return;
    pendingCenter = false;
    fitToStage({ tween: false });
  });
}

function afterPaint(fn) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(fn()));
    });
  });
}

async function centerNewGraph({ tween = true } = {}) {
  userMovedCamera = false;
  pendingCenter = true;
  if (!state.layout) {
    scheduleFit();
    return;
  }
  await afterPaint(() => {});
  if (userMovedCamera) return;
  if (!stageReady()) {
    scheduleFit();
    return;
  }
  pendingCenter = false;
  await fitToStage({ tween });
}

function stageSize() {
  return { w: els.stage.clientWidth, h: els.stage.clientHeight };
}

function setAgentSymbol(dataUrl) {
  state.agentSymbol = dataUrl || null;
  const face = els.faceBtn || els.faceWrap;
  if (face) {
    if (state.agentSymbol) {
      face.style.backgroundImage = `url("${state.agentSymbol}")`;
      face.classList.add("has-face");
    } else {
      face.style.backgroundImage = "";
      face.classList.remove("has-face");
    }
  }
  const reset = els.faceMenu?.querySelector('[data-face="reset"]');
  if (reset) reset.hidden = !state.agentSymbol;
  for (const agent of state.agents.values()) drawAgent(agent);
}

function readFace(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("not an image"));
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext("2d");
      ctx.beginPath();
      ctx.arc(48, 48, 48, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const scale = Math.max(96 / img.width, 96 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, 48 - w / 2, 48 - h / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read image"));
    };
    img.src = url;
  });
}

function notifyHost(payload) {
  window.webkit?.messageHandlers?.plexus?.postMessage(payload);
}

function prefGet(key) {
  return localStorage.getItem(`plexus-${key}`) ?? localStorage.getItem(`grok-explore-${key}`);
}

function prefSet(key, value) {
  if (value == null || value === "") {
    localStorage.removeItem(`plexus-${key}`);
    localStorage.removeItem(`grok-explore-${key}`);
    return;
  }
  localStorage.setItem(`plexus-${key}`, value);
}

function savePrefs(extra = {}) {
  const body = {
    accent: state.accent,
    agentSymbol: state.agentSymbol,
    shape: state.shape,
    theme: state.theme,
    opacity: state.opacity,
    graphFollow: state.graphFollow,
    settingsHidden: state.settingsHidden,
    ...extra,
  };
  prefSet("accent", state.accent);
  prefSet("shape", state.shape);
  prefSet("theme", state.theme);
  prefSet("opacity", String(state.opacity));
  prefSet("follow", state.graphFollow);
  prefSet("settings", state.settingsHidden ? "off" : "on");
  prefSet("face", state.agentSymbol);
  fetch("/api/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedTheme() {
  if (state.theme === "system") return systemDark.matches ? "dark" : "light";
  return state.theme === "light" ? "light" : "dark";
}

const WHITE = "#f4f4f6";
const INK = "#16161a";

function accentForTheme(hex = state.accent) {
  if (String(hex).toLowerCase() === WHITE && resolvedTheme() === "light") return INK;
  return hex;
}

function stageFill() {
  return resolvedTheme() === "light" ? "#f3f3f6" : "#0a0a0c";
}

function applyTheme(theme, { persist = false } = {}) {
  state.theme = theme === "light" || theme === "system" ? theme : "dark";
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = state.theme;
  document.documentElement.style.setProperty("--accent", accentForTheme());
  hitFill.setAttribute("fill", stageFill());
  notifyHost({ type: "theme", value: state.theme, resolved });
  for (const agent of state.agents.values()) drawAgent(agent);
  if (state.layout) drawTree(state.layout);
  paintTheme();
  paintPalette();
  if (persist) savePrefs();
}

function applyOpacity(value, { persist = false } = {}) {
  const next = Math.min(1, Math.max(0.4, Number(value) || 0.96));
  state.opacity = next;
  const pct = Math.round(next * 100);
  if (els.opacity) els.opacity.value = String(pct);
  if (els.opacityOut) els.opacityOut.textContent = String(pct);
  document.documentElement.style.setProperty("--glass-fill", `${((pct - 40) / 60) * 100}%`);
  notifyHost({ type: "opacity", value: next });
  if (persist) savePrefs();
}

function paintFollow() {
  const root = els.followSeg || document.getElementById("follow-seg");
  if (!root) return;
  for (const btn of root.querySelectorAll("button[data-follow]")) {
    const on = btn.dataset.follow === state.graphFollow;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
}

function applyFollow(mode, { persist = false } = {}) {
  state.graphFollow = mode === "project" ? "project" : "focus";
  paintFollow();
  if (persist) savePrefs({ graphFollow: state.graphFollow });
}

function applySettingsHidden(hidden, { persist = false } = {}) {
  state.settingsHidden = Boolean(hidden);
  document.documentElement.dataset.settings = state.settingsHidden ? "off" : "on";
  if (persist) savePrefs({ settingsHidden: state.settingsHidden });
}

function anyPickerOpen() {
  return Boolean(
    (els.sessionPicker && !els.sessionPicker.hidden) ||
      (els.settingsPicker && !els.settingsPicker.hidden),
  );
}

function syncPickerOverlay() {
  const open = anyPickerOpen();
  if (els.pickerScrim) els.pickerScrim.hidden = !open;
  if (open) document.documentElement.dataset.picker = "open";
  else delete document.documentElement.dataset.picker;
  const picker =
    els.sessionPicker && !els.sessionPicker.hidden
      ? els.sessionPicker
      : els.settingsPicker && !els.settingsPicker.hidden
        ? els.settingsPicker
        : null;
  const post = () => {
    const rect = picker?.getBoundingClientRect();
    notifyHost({
      type: "picker",
      open,
      x: rect?.left ?? 0,
      y: rect?.top ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    });
  };
  if (open) requestAnimationFrame(post);
  else post();
}

function closePickers() {
  setSessionPickerOpen(false);
  setSettingsPickerOpen(false);
}

function setSettingsPickerOpen(open) {
  if (!els.settingsPicker) return;
  if (open) {
    if (els.sessionPicker) {
      els.sessionPicker.hidden = true;
      if (els.sessionSearch) els.sessionSearch.value = "";
    }
  }
  els.settingsPicker.hidden = !open;
  syncPickerOverlay();
}

function toggleSettingsPicker() {
  setSettingsPickerOpen(Boolean(els.settingsPicker?.hidden));
}

function setColorMenuOpen(_open) {}

function setFaceMenuOpen(open) {
  if (!els.faceMenu || !els.faceBtn) return;
  els.faceMenu.hidden = !open;
  els.faceBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function paintPalette() {
  if (els.colorCurrent) {
    els.colorCurrent.style.backgroundColor = state.accent;
    const name = PALETTE.find((c) => c.hex === state.accent)?.id || "color";
    els.colorCurrent.title = name;
  }
  if (!els.palette) return;
  els.palette.replaceChildren();
  for (const color of PALETTE) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (color.hex === state.accent ? " on" : "");
    btn.title = color.id;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-label", color.id);
    btn.style.background = color.id === "white" && resolvedTheme() === "light" ? INK : color.hex;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setAccent(color.hex);
      savePrefs();
    });
    els.palette.appendChild(btn);
  }
}

function setAccent(hex) {
  const value = nearestPalette(hex);
  state.accent = value;
  document.documentElement.style.setProperty("--accent", accentForTheme(value));
  paintPalette();
  for (const agent of state.agents.values()) {
    agent.color = colorFor(agent.id);
    drawAgent(agent);
  }
  if (state.layout) drawTree(state.layout);
}

function bindCenterBtn() {
  const stage = els.stage || document.getElementById("stage");
  if (!stage) return;
  let tools = document.querySelector(".stage-tools");
  if (!tools) {
    tools = document.createElement("div");
    tools.className = "stage-tools";
    stage.appendChild(tools);
  }
  const demo = document.getElementById("btn-demo") || els.demo;
  if (demo) {
    demo.title = "Watch a sample trail";
    demo.setAttribute("aria-label", "Preview");
    if (!demo.querySelector("svg")) {
      demo.textContent = "";
      demo.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.1 3.05a.9.9 0 0 1 1.37-.76l7.2 4.45a.9.9 0 0 1 0 1.52l-7.2 4.45a.9.9 0 0 1-1.37-.76z"/></svg>';
    }
    if (demo.parentElement !== tools) tools.appendChild(demo);
  }
  let btn = document.getElementById("btn-center") || els.center;
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btn-center";
    btn.title = "Center graph";
    btn.setAttribute("aria-label", "Center graph");
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><path d="M8 1.2v2.6M8 12.2v2.6M1.2 8h2.6M12.2 8h2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  } else if (!btn.querySelector("svg")) {
    btn.textContent = "";
    btn.setAttribute("aria-label", "Center graph");
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><path d="M8 1.2v2.6M8 12.2v2.6M1.2 8h2.6M12.2 8h2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  }
  if (btn.parentElement !== tools) tools.appendChild(btn);
  els.center = btn;
  els.demo = demo;
  if (btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    centerView();
  });
}

function ensureShapeEl() {
  if (els.shape && document.body.contains(els.shape)) return els.shape;
  let shape = document.getElementById("shape");
  if (!shape) {
    shape = document.createElement("div");
    shape.id = "shape";
    shape.className = "seg";
    shape.setAttribute("role", "tablist");
    shape.setAttribute("aria-label", "Trail layout");
    document.querySelector(".instrument")?.appendChild(shape);
  }
  els.shape = shape;
  return shape;
}

function paintTheme() {
  const root = els.themeSeg || document.getElementById("theme-seg");
  if (!root) return;
  for (const btn of root.querySelectorAll("button")) {
    const on = btn.dataset.theme === state.theme;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
}

function setSettingsOpen(open) {
  const tray = els.settingsTray || document.getElementById("settings-tray");
  const btn = els.settingsBtn || document.getElementById("btn-settings");
  if (!tray || !btn) return;
  tray.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

let instrumentBusy = false;
function layoutInstrument() {
  const header = els.instrument || document.querySelector(".instrument");
  const bar = els.settings || document.getElementById("settings");
  const tray = els.settingsTray || document.getElementById("settings-tray");
  const gear = els.settingsBtn || document.getElementById("btn-settings");
  if (!header || !bar || !tray || instrumentBusy) return;
  instrumentBusy = true;
  const keys = ["color", "display", "follow", "trail", "glass"];
  const cells = keys
    .map((id) => header.querySelector(`[data-setting="${id}"]`) || bar.querySelector(`[data-setting="${id}"]`) || tray.querySelector(`[data-setting="${id}"]`))
    .filter(Boolean);
  header.classList.toggle("settings-off", state.settingsHidden);
  if (state.settingsHidden) {
    for (const cell of cells) bar.appendChild(cell);
    header.classList.remove("compact");
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      instrumentBusy = false;
    });
    return;
  }
  for (const cell of cells) bar.appendChild(cell);
  const styles = getComputedStyle(header);
  const pad = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  const gap = parseFloat(getComputedStyle(bar).columnGap || getComputedStyle(bar).gap) || 12;
  const widths = new Map(cells.map((cell) => [cell, Math.ceil(cell.getBoundingClientRect().width) || 80]));
  const pack = () => {
    let space = header.clientWidth - pad;
    const shown = [];
    const hidden = [];
    for (const cell of cells) {
      const need = (widths.get(cell) || 80) + gap;
      if (need <= space) {
        shown.push(cell);
        space -= need;
      } else hidden.push(cell);
    }
    return { shown, hidden };
  };
  const result = pack();
  for (const cell of result.shown) bar.appendChild(cell);
  for (const cell of result.hidden) tray.appendChild(cell);
  const compact = result.hidden.length > 0;
  header.classList.toggle("compact", compact);
  setSettingsOpen(compact);
  requestAnimationFrame(() => {
    instrumentBusy = false;
  });
}

function centerView() {
  return centerNewGraph({ tween: true });
}

function paintShape() {
  bindCenterBtn();
  const root = ensureShapeEl();
  if (!root) return;
  root.replaceChildren();
  for (const item of SHAPES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.textContent = item.label;
    btn.title = item.id === "circle" ? "Circular map" : "Branching tree";
    btn.className = item.id === state.shape ? "on" : "";
    btn.setAttribute("aria-selected", item.id === state.shape ? "true" : "false");
    btn.addEventListener("click", () => setShape(item.id));
    els.shape.appendChild(btn);
  }
}

async function setShape(shape, { persist = true, morph = true } = {}) {
  const next = shape === "circle" ? "circle" : "tree";
  const changed = next !== state.shape;
  state.shape = next;
  paintShape();
  if (persist) savePrefs({ shape: next });
  else prefSet("shape", next);
  if (changed && morph && state.layout) await morphShape();
}

async function morphShape() {
  if (!state.rootId || !state.layout) return;
  trailEpoch += 1;
  for (const agent of state.agents.values()) {
    agent.traveling = false;
    agent.targetId = null;
  }
  const prev = state.layout.pos ? new Map(state.layout.pos) : null;
  const laid = fitAndLayout();
  if (!laid) return;
  rememberTrailEdges(laid);
  await interpolateLayout(prev, laid, 720, { parkTraveling: true });
  userMovedCamera = false;
  if (stageReady()) await fitToStage({ tween: true });
  else scheduleFit();
  drawTree(state.layout);
  refreshNodeLooks();
}

function colorFor(id) {
  const ids = [...state.agents.keys()];
  const idx = Math.max(0, ids.indexOf(id));
  if (idx <= 0) return state.accent;
  return idx === 1 ? "#f7f7f8" : "#d4a5c9";
}

function whisperName(name) {
  const raw = String(name || "").replace(/[_-]+/g, " ").trim();
  if (raw.length <= 16) return raw;
  return raw.slice(0, 15);
}

function ancestorsOf(id) {
  const out = [];
  let cursor = id;
  const guard = new Set();
  while (cursor && !guard.has(cursor)) {
    out.push(cursor);
    guard.add(cursor);
    cursor = state.parentOf.get(cursor) ?? null;
  }
  return out;
}

function pinnedIds() {
  const pins = new Set(state.userPins);
  for (const agent of state.agents.values()) {
    if (agent.nodeId) pins.add(agent.nodeId);
    if (agent.targetId) pins.add(agent.targetId);
  }
  return pins;
}

function isOnTrail(id) {
  if (state.visited.has(id)) return true;
  const prefix = `${id}/`;
  for (const folder of state.visited.keys()) {
    if (folder.startsWith(prefix)) return true;
  }
  for (const agent of state.agents.values()) {
    const at = agent.targetId || agent.nodeId;
    if (!at) continue;
    if (at === id || at.startsWith(prefix)) return true;
  }
  return false;
}

function isNeighborhood(id) {
  return [...state.agents.values()].some((agent) => agent.nodeId === id || agent.targetId === id);
}

function visibleKids(id) {
  if (!state.expanded.has(id)) return [];
  const kids = state.nodes.get(id)?.childIds ?? [];
  if (state.userPins.has(id)) return kids.slice();
  return kids.filter(
    (child) => isOnTrail(child) || state.layout?.pos.has(child) || state.userPins.has(child),
  );
}

function rebuildEdges() {
  if (!state.layout) return;
  const edges = [];
  const walk = (id) => {
    const parent = state.layout.pos.get(id);
    if (!parent) return;
    for (const child of visibleKids(id)) {
      const c = state.layout.pos.get(child);
      if (!c) continue;
      edges.push({
        from: id,
        to: child,
        x1: parent.x,
        y1: parent.y,
        x2: c.x,
        y2: c.y,
      });
      walk(child);
    }
  };
  walk(state.rootId);
  state.layout.edges = edges;
}

function appendMissingNodes() {
  if (!state.rootId) return [];
  const before = state.layout?.pos ? new Set(state.layout.pos.keys()) : new Set();
  if (!state.layout) {
    fitAndLayout();
    return [...(state.layout?.pos.keys() ?? [])].filter((id) => !before.has(id));
  }
  const stack = [state.rootId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (!state.layout.pos.has(id)) {
      const parentId = state.parentOf.get(id);
      const parent = parentId ? state.layout.pos.get(parentId) : null;
      if (id === state.rootId) {
        state.layout.pos.set(id, {
          x: 0,
          y: 0,
          angle: Math.PI / 2,
          depth: 0,
          w: 40,
          h: 14,
        });
      } else if (parent) {
        const siblings = visibleKids(parentId)
          .filter((child) => child !== id && state.layout.pos.has(child))
          .map((child) => state.layout.pos.get(child));
        state.layout.pos.set(id, attachChild(parent, siblings, { mode: state.shape }));
      }
    }
    for (const child of visibleKids(id)) stack.push(child);
  }
  const added = [...state.layout.pos.keys()].filter((id) => !before.has(id));
  if (added.length) rebuildEdges();
  const shown = new Map();
  const mark = (id) => {
    const kids = visibleKids(id);
    shown.set(id, kids);
    for (const child of kids) mark(child);
  };
  mark(state.rootId);
  state.shown = shown;
  return added;
}

function fitAndLayout() {
  if (!state.rootId || !state.nodes.has(state.rootId)) return null;
  const shown = new Map();
  const walk = (id) => {
    const kids = visibleKids(id);
    shown.set(id, kids);
    for (const child of kids) walk(child);
  };
  walk(state.rootId);
  state.shown = shown;
  state.layout = layoutTrail({
    mode: state.shape,
    rootId: state.rootId,
    getShownChildren: (id) => shown.get(id) ?? [],
  });
  return state.layout;
}

function cameraTarget(laid) {
  const { w, h } = stageSize();
  if (w < 80 || h < 80) return { x: camera.x, y: camera.y, k: camera.k };
  if (!laid?.pos?.size) return { x: w / 2, y: h / 2, k: 1 };
  const bounds = graphWorldBounds(laid);
  return (
    fitCameraToBounds({ bounds, view: { w, h }, pad: 22, maxK: 1.7 }) || {
      x: w / 2,
      y: h / 2,
      k: 1,
    }
  );
}

function graphOverflowsView(laid = state.layout) {
  if (!laid?.pos?.size) return false;
  const { w, h } = stageSize();
  if (w < 80 || h < 80) return false;
  const pad = 22;
  const k = camera.k || 1;
  for (const p of laid.pos.values()) {
    const vx = p.x * k + camera.x;
    const vy = p.y * k + camera.y;
    if (vx < pad || vx > w - pad || vy < pad || vy > h - pad) return true;
  }
  return false;
}

async function keepGraphFramed({ tween = true, extraIds = [], agent = null } = {}) {
  if (!state.layout) return;
  const fit = cameraTarget(state.layout);
  const zoomedIn = userMovedCamera && camera.k > (fit.k || 1) + 0.05;
  if (!zoomedIn && (!userMovedCamera || graphOverflowsView())) {
    await fitToStage({ tween });
    return;
  }
  const to = cameraFocus(extraIds, agent);
  if (to) await tweenCamera(to, tween ? 460 : 0);
}

function cameraFocus(extraIds = [], agent = null) {
  if (!state.layout) return null;
  const points = [];
  if (agent && Number.isFinite(agent.x) && Number.isFinite(agent.y)) {
    points.push({ x: agent.x, y: agent.y });
  }
  for (const id of extraIds) {
    if (!id) continue;
    const p = state.layout.pos.get(id);
    if (p) points.push(p);
  }
  return cameraPanToInclude({
    points,
    view: stageSize(),
    camera,
    pad: 68,
  });
}

function tweenCamera(to, ms) {
  if (!to) return Promise.resolve();
  if (
    Math.hypot(to.x - camera.x, to.y - camera.y) < 0.6 &&
    Math.abs(to.k - camera.k) < 0.002
  ) {
    return Promise.resolve();
  }
  const gen = ++camGen;
  if (reduceMotion || ms <= 0) {
    camera.x = to.x;
    camera.y = to.y;
    camera.k = to.k;
    applyCamera();
    return Promise.resolve();
  }
  const from = { x: camera.x, y: camera.y, k: camera.k };
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      if (gen !== camGen) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - t0) / ms);
      const e = easeInOut(t);
      camera.x = from.x + (to.x - from.x) * e;
      camera.y = from.y + (to.y - from.y) * e;
      camera.k = from.k + (to.k - from.k) * e;
      applyCamera();
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function preserveCameraOnResize() {
  const { w, h } = stageSize();
  if (w < 80 || h < 80) return;
  syncHitFill();
  if (lastStage.w < 80 || lastStage.h < 80) {
    lastStage = { w, h };
    if (!userMovedCamera) fitToStage();
    return;
  }
  if (lastStage.w !== w || lastStage.h !== h) {
    const wx = (lastStage.w / 2 - camera.x) / camera.k;
    const wy = (lastStage.h / 2 - camera.y) / camera.k;
    camera.x = w / 2 - wx * camera.k;
    camera.y = h / 2 - wy * camera.k;
    applyCamera();
  }
  lastStage = { w, h };
}

function onStageResize() {
  layoutInstrument();
  const { w, h } = stageSize();
  syncHitFill();
  if (w < 80 || h < 80) return;
  if (Math.abs(lastStage.w - w) < 2 && Math.abs(lastStage.h - h) < 2) return;
  if (!state.layout) {
    lastStage = { w, h };
    return;
  }
  if (pendingCenter || (!userMovedCamera && !agentsBusy())) {
    pendingCenter = false;
    lastStage = { w, h };
    fitToStage({ tween: false });
    return;
  }
  preserveCameraOnResize();
}

function interpolateLayout(fromPos, laid, ms, { parkTraveling = false } = {}) {
  const park = (pos) => parkAgents(pos, { includeTraveling: parkTraveling });
  const gen = ++morphGen;
  if (reduceMotion || !fromPos || ms <= 0) {
    drawTree(laid);
    park();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      if (gen !== morphGen) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - t0) / ms);
      const e = easeInOut(t);
      const mixed = new Map();
      for (const [id, to] of laid.pos) {
        const prev = fromPos.get(id) || to;
        mixed.set(id, {
          x: prev.x + (to.x - prev.x) * e,
          y: prev.y + (to.y - prev.y) * e,
          w: to.w,
          h: to.h,
          angle: to.angle,
          depth: to.depth,
        });
      }
      drawTree({ ...laid, pos: mixed }, { posOverride: mixed });
      park(mixed);
      if (t < 1) requestAnimationFrame(frame);
      else {
        drawTree(laid);
        park();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

function edgeKey(from, to) {
  return `${from}->${to}`;
}

function edgeVisited(from, to) {
  return (
    state.visitedEdges.has(edgeKey(from, to)) ||
    state.visitedEdges.has(edgeKey(to, from)) ||
    (state.visited.has(from) && state.visited.has(to))
  );
}

function rememberTrailEdges(laid) {
  if (!laid?.edges) return;
  for (const edge of laid.edges) {
    if (state.visited.has(edge.from) && state.visited.has(edge.to)) {
      state.visitedEdges.add(edgeKey(edge.from, edge.to));
    }
  }
}

function paintEdge(g, from, to, a, b) {
  if (!g) return;
  const visited = edgeVisited(from, to);
  g.classList.toggle("visited", visited);
  if (a && b) {
    const d = edgePath(a.x, a.y, b.x, b.y);
    g.querySelector(".glow")?.setAttribute("d", d);
    g.querySelector(".stroke")?.setAttribute("d", d);
  }
  const glow = g.querySelector(".glow");
  const stroke = g.querySelector(".stroke");
  if (glow) {
    glow.setAttribute("fill", "none");
    glow.setAttribute("stroke", visited ? state.accent : "none");
    glow.setAttribute("stroke-width", visited ? "7" : "0");
    glow.setAttribute("opacity", visited ? "0.16" : "0");
  }
  if (stroke) {
    stroke.setAttribute("fill", "none");
    stroke.setAttribute("stroke", visited ? state.accent : "#2a2a32");
    stroke.setAttribute("stroke-width", visited ? "1.6" : "0.8");
    stroke.setAttribute("opacity", visited ? "0.95" : "0.55");
  }
}

function paintNodeLooks(g, id, p) {
  const node = state.nodes.get(id);
  if (!g || !node) return;
  const visited = state.visited.has(id);
  const here = isNeighborhood(id);
  const live = liveNodeIds().has(id);
  const root = id === state.rootId;
  const glow = g.querySelector(".poke-glow");
  const dot = g.querySelector(".dot");
  const label = g.querySelector(".node-label");
  const title = g.querySelector("title");
  if (glow) {
    glow.setAttribute("fill", state.accent);
    glow.setAttribute("opacity", live ? "0.14" : "0");
  }
  if (dot) {
    dot.setAttribute("r", live ? "5.2" : root ? "4.4" : visited ? "3.1" : "2.2");
    dot.setAttribute("fill", live ? "#fff" : visited || root ? state.accent : "#5c5c66");
    dot.setAttribute("opacity", live || visited || here || root ? "1" : "0.35");
  }
  if (label) {
    if (live) {
      label.textContent = "";
    } else {
      const ang = p.angle ?? Math.PI / 2;
      const outward = Math.cos(ang) >= 0 ? 1 : -1;
      label.setAttribute("x", String(Math.cos(ang) * 9 + outward * 2));
      label.setAttribute("y", String(Math.sin(ang) * 9 + 4));
      label.setAttribute("text-anchor", outward > 0 ? "start" : "end");
      label.setAttribute("fill", visited ? state.accent : "#8b8b93");
      label.setAttribute("opacity", visited || here || root ? "1" : "0.38");
      label.setAttribute("font-size", root ? "11" : "10");
      label.textContent = whisperName(node.name);
    }
  }
  if (title) title.textContent = node.path;
}

function refreshNodeLooks() {
  if (!state.layout) return;
  for (const [id, g] of graphEls.nodes) {
    const p = state.layout.pos.get(id);
    if (p) paintNodeLooks(g, id, p);
  }
}

function markEdgeVisited(from, to) {
  state.visitedEdges.add(edgeKey(from, to));
  const g = graphEls.edges.get(edgeKey(from, to)) || graphEls.edges.get(edgeKey(to, from));
  const a = state.layout?.pos.get(from);
  const b = state.layout?.pos.get(to);
  paintEdge(g, from, to, a, b);
}

function drawTree(laid, opts = {}) {
  if (!laid) return;
  const pos = opts.posOverride || laid.pos;
  const entering = opts.entering || new Set();
  const liveEdges = new Set();
  for (const edge of laid.edges) {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    if (!a || !b) continue;
    const key = edgeKey(edge.from, edge.to);
    const alt = edgeKey(edge.to, edge.from);
    liveEdges.add(key);
    let g = graphEls.edges.get(key) || graphEls.edges.get(alt);
    if (g && !graphEls.edges.has(key)) {
      graphEls.edges.delete(alt);
      graphEls.edges.set(key, g);
      g.setAttribute("data-edge", key);
    }
    if (!g) {
      g = el("g", {
        class: "link" + (entering.has(edge.to) ? " born" : ""),
        "data-edge": key,
      }, edgeG);
      el("path", { class: "glow", fill: "none" }, g);
      el("path", { class: "stroke", fill: "none" }, g);
      graphEls.edges.set(key, g);
    }
    paintEdge(g, edge.from, edge.to, a, b);
  }
  for (const [key, g] of graphEls.edges) {
    if (!liveEdges.has(key)) {
      g.remove();
      graphEls.edges.delete(key);
    }
  }

  const liveNodes = new Set();
  for (const [id, p] of pos) {
    if (!state.nodes.get(id)) continue;
    liveNodes.add(id);
    let g = graphEls.nodes.get(id);
    if (!g) {
      g = el("g", {
        class: "folder" + (entering.has(id) ? " born" : ""),
        "data-id": id,
      }, nodeG);
      el("circle", { class: "poke-glow", r: "26" }, g);
      el("circle", { class: "dot", r: "2.2" }, g);
      el("text", { class: "node-label" }, g);
      g.appendChild(document.createElementNS(svgNS, "title"));
      g.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onNodeClick(id);
      });
      graphEls.nodes.set(id, g);
    }
    g.setAttribute("transform", `translate(${p.x} ${p.y})`);
    paintNodeLooks(g, id, p);
  }
  for (const [id, g] of graphEls.nodes) {
    if (!liveNodes.has(id)) {
      g.remove();
      graphEls.nodes.delete(id);
    }
  }
}

function clearGraph() {
  graphEls.nodes.clear();
  graphEls.edges.clear();
  edgeG.replaceChildren();
  nodeG.replaceChildren();
  moreG.replaceChildren();
}

function descendantVisitCount(id) {
  const prefix = `${id}/`;
  let n = 0;
  for (const key of state.visited.keys()) {
    if (key === id || key.startsWith(prefix)) n += 1;
  }
  return n;
}

function liveNodeIds() {
  const ids = new Set();
  for (const agent of state.agents.values()) {
    if (agent.nodeId) ids.add(agent.nodeId);
    if (agent.targetId) ids.add(agent.targetId);
  }
  return ids;
}

function parkAgents(posMap, { includeTraveling = false } = {}) {
  const pos = posMap || state.layout?.pos;
  if (!pos) return;
  const occupancy = new Map();
  for (const agent of state.agents.values()) {
    if (agent.traveling && !includeTraveling) continue;
    const p = pos.get(agent.nodeId);
    if (!p) continue;
    const n = occupancy.get(agent.nodeId) || 0;
    occupancy.set(agent.nodeId, n + 1);
    agent.x = p.x + n * 7;
    agent.y = p.y;
    drawAgent(agent);
  }
}

function drawAgent(agent) {
  let g = agentG.querySelector(`[data-agent="${cssEscape(agent.id)}"]`);
  if (!g) {
    g = el("g", { class: "agent-mark", "data-agent": agent.id }, agentG);
    el("circle", { class: "halo h1", r: "18", fill: "none", "stroke-width": "2" }, g);
    el("circle", { class: "halo h2", r: "18", fill: "none", "stroke-width": "1.4" }, g);
    el("circle", { class: "ring", r: "12", fill: "none", "stroke-width": "2.5" }, g);
    el("circle", { class: "core", r: "4.6", fill: "#fff" }, g);
    const face = el("image", {
      class: "face",
      x: "-11",
      y: "-11",
      width: "22",
      height: "22",
      "clip-path": "url(#agent-clip)",
      preserveAspectRatio: "xMidYMid slice",
    }, g);
    face.setAttribute("href", "");
    el("text", {
      class: "agent-tag",
      x: "16",
      y: "-14",
      "font-size": "12",
      "font-weight": "650",
    }, g);
  }
  g.setAttribute("transform", `translate(${agent.x} ${agent.y})`);
  const accent = agent.color || state.accent;
  const ink = resolvedTheme() === "light" ? "#111114" : "#fff";
  g.querySelector(".halo.h1").setAttribute("stroke", accent);
  g.querySelector(".halo.h2").setAttribute("stroke", ink);
  g.querySelector(".ring").setAttribute("stroke", accent);
  const core = g.querySelector(".core");
  const face = g.querySelector(".face");
  if (state.agentSymbol) {
    face.setAttribute("href", state.agentSymbol);
    face.setAttributeNS("http://www.w3.org/1999/xlink", "href", state.agentSymbol);
    face.style.display = "";
    core.style.display = "none";
  } else {
    face.style.display = "none";
    core.style.display = "";
    core.setAttribute("fill", ink);
  }
  const folder = state.nodes.get(agent.nodeId)?.name;
  const tag = g.querySelector(".agent-tag");
  tag.setAttribute("fill", ink);
  tag.textContent = folder
    ? `${whisperName(folder)}`
    : agent.label || "agent";
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}

function setLive(kind, text) {
  if (!els.liveStatus) return;
  els.liveStatus.className = `live ${kind}`;
  els.liveStatus.textContent = text;
}

function pushLog(entry) {
  state.log.unshift(entry);
  state.log = state.log.slice(0, 6);
  if (!els.log) return;
  els.log.replaceChildren();
  for (const item of state.log) {
    const li = document.createElement("li");
    const name = item.filePath ? item.filePath.split("/").pop() : item.folderPath.split("/").pop();
    li.innerHTML = `<strong>${item.toolName || "visit"}</strong> ${name}`;
    els.log.appendChild(li);
  }
}

function setPeek(text) {
  if (!els.peek) return;
  els.peek.textContent = text || "";
}

function peekHere(folderPath, filePath) {
  const loc = filePath || folderPath || "";
  const name = loc.split("/").filter(Boolean).pop() || "";
  setPeek(name ? `now  ${name}` : loc);
}

function resetTree({ rootId, rootPath, name, nodes, parentOf }) {
  state.rootId = rootId;
  state.rootPath = rootPath;
  state.nodes = nodes;
  state.parentOf = parentOf;
  state.expanded = new Set([rootId]);
  state.lastFocus = new Map([[rootId, Date.now()]]);
  state.userPins = new Set();
  state.visited = new Map();
  state.visitedEdges = new Set();
  state.hidden = new Map();
  state.shown = new Map();
  state.log = [];
  if (els.log) els.log.replaceChildren();
  clearGraph();
  agentG.replaceChildren();
  userMovedCamera = false;
  const laid = fitAndLayout();
  if (laid) {
    snapCameraToLayout(laid);
    drawTree(laid);
    scheduleFit();
  }
}

function shortLabel(label, id) {
  if (label && !/^01[a-f0-9-]{20,}$/i.test(label) && label !== "main") return label;
  if (!id) return "agent";
  return id.length > 10 ? id.slice(0, 4) : id;
}

function sessionLabel(item) {
  const title = String(item.title || "").trim();
  if (title && !/^01[a-f0-9-]{20,}$/i.test(title) && title !== "main") return title;
  return String(item.cwd || "").trim() || "project";
}

function setSessionTitle(text) {
  const label = String(text || "").trim() || "Plexus";
  document.title = label;
  notifyHost({ type: "title", value: label });
}

function folderTail(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "";
}

function fillSessionSelect(sessions, selectedId) {
  state.sessions = sessions || [];
  if (selectedId) state.sessionId = selectedId;
  const current =
    state.sessions.find((item) => item.id === state.sessionId || item.selected) || state.sessions[0];
  if (current) {
    state.sessionId = current.id;
    setSessionTitle(sessionLabel(current));
  } else {
    setSessionTitle(state.mode === "demo" ? "Preview" : "Plexus");
  }
  renderSessionPicker();
}

function renderSessionPicker() {
  if (!els.sessionList) return;
  const q = String(els.sessionSearch?.value || "").trim().toLowerCase();
  const list = state.sessions.filter((item) => {
    if (!q) return true;
    const hay = `${sessionLabel(item)} ${item.cwd || ""} ${item.id || ""}`.toLowerCase();
    return hay.includes(q);
  });
  els.sessionList.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "picker-sub";
    empty.style.padding = "12px 10px";
    empty.textContent = state.sessions.length ? "No matches" : "No live sessions";
    els.sessionList.appendChild(empty);
    return;
  }
  for (const item of list) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "picker-row" + (item.id === state.sessionId ? " on" : "");
    row.setAttribute("role", "option");
    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "picker-title";
    title.textContent = sessionLabel(item);
    const sub = document.createElement("div");
    sub.className = "picker-sub";
    if (item.id === state.sessionId) {
      const dot = document.createElement("span");
      dot.className = "picker-dot";
      sub.appendChild(dot);
    }
    const bits = [];
    if (item.id === state.sessionId) bits.push("Current");
    if (item.provider && item.provider !== "grok") bits.push(item.provider);
    const place = folderTail(item.cwd);
    if (place) bits.push(place);
    const meta = document.createElement("span");
    meta.textContent = bits.join(" · ");
    sub.appendChild(meta);
    body.append(title, sub);
    row.appendChild(body);
    row.addEventListener("click", () => attachSession(item.id));
    els.sessionList.appendChild(row);
  }
}

function setSessionPickerOpen(open) {
  if (!els.sessionPicker) return;
  if (open && els.settingsPicker) els.settingsPicker.hidden = true;
  els.sessionPicker.hidden = !open;
  if (open) {
    renderSessionPicker();
    queueMicrotask(() => els.sessionSearch?.focus());
  } else if (els.sessionSearch) {
    els.sessionSearch.value = "";
  }
  syncPickerOverlay();
}

function toggleSessionPicker() {
  setSessionPickerOpen(Boolean(els.sessionPicker?.hidden));
}

async function attachSession(id) {
  if (!id || id === "sample") return;
  window.clearTimeout(demoTimer);
  state.mode = "live";
  setSessionPickerOpen(false);
  await fetch("/api/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: id }),
  });
  await startLive();
}

window.__toggleSessions = toggleSessionPicker;
window.__toggleSettings = toggleSettingsPicker;
window.__closePickers = closePickers;
window.__syncPickerOverlay = syncPickerOverlay;

function inRoot(folder) {
  if (!folder || !state.rootPath) return false;
  return folder === state.rootPath || folder.startsWith(`${state.rootPath}/`);
}

async function mountRoot(root, name) {
  const nodes = new Map();
  const parentOf = new Map();
  nodes.set(root, {
    id: root,
    name: name || root.split("/").pop(),
    path: root,
    parentId: null,
    childIds: [],
    hasChildren: true,
    childrenLoaded: false,
  });
  parentOf.set(root, null);
  resetTree({
    rootId: root,
    rootPath: root,
    name: name || root.split("/").pop(),
    nodes,
    parentOf,
  });
  await loadChildren(root);
  state.expanded.add(root);
}

let applying = Promise.resolve();
function applySnapshot(data) {
  const run = () => applySnapshotNow(data);
  applying = applying.then(run, run);
  return applying;
}

async function applySnapshotNow(data) {
  try {
    window.clearTimeout(demoTimer);
    state.mode = "live";
    const root = data.root;
    if (!root) {
      fillSessionSelect(data.sessions, data.sessionId);
      setLive("waiting", "waiting");
      return;
    }
    const sessionId = data.sessionId || "";
    const sameRoot = Boolean(state.layout && state.rootPath === root);
    const laidCount = state.layout?.pos?.size || 0;
    const incomingVisits = (data.visited || []).filter((folder) => folder === root || String(folder).startsWith(`${root}/`));
    const sparse = sameRoot && laidCount <= 1 && incomingVisits.length > 0;
    const switchedView = !sameRoot || sparse;
    state.sessionId = sessionId || state.sessionId;
    if (!sameRoot) {
      state.agents = new Map();
      queues.clear();
      await mountRoot(root, data.name);
    }
    const visited = (data.visited || []).filter(inRoot);
    for (const folder of visited) {
      await ensurePath(folder);
      expandPath(folder);
      state.visited.set(folder, 1);
      for (const anc of ancestorsOf(folder)) {
        if (!state.visited.has(anc)) state.visited.set(anc, 1);
      }
    }
    const agents = data.agents || [];
    const liveIds = new Set(agents.map((item) => item.id));
    for (const id of [...state.agents.keys()]) {
      if (!liveIds.has(id)) dropAgent(id);
    }
    for (const item of agents) {
      const agent = ensureAgent(item.id, item.label || item.title);
      const dest = inRoot(item.folderPath) ? item.folderPath : root;
      await ensurePath(dest);
      expandPath(dest);
      if (!agent.traveling) agent.nodeId = dest;
    }
    if (sameRoot && !sparse) {
      const added = appendMissingNodes();
      rememberTrailEdges(state.layout);
      if (added.length) drawTree(state.layout, { entering: new Set(added) });
      else refreshNodeLooks();
      parkAgents();
      if (added.length) await keepGraphFramed({ tween: true, extraIds: added });
    } else {
      await relayout({ tween: false, force: true });
      parkAgents();
    }
    if (switchedView) await centerNewGraph({ tween: true });
    fillSessionSelect(data.sessions, data.sessionId);
    setLive(
      data.busy ? "on" : agents.length ? "on" : "waiting",
      data.busy ? "exploring" : agents.length ? "attached" : "waiting",
    );
    const last = visited[visited.length - 1];
    if (last) peekHere(last);
  } catch (err) {
    setPeek(String(err && err.message ? err.message : err));
  }
}

function ensureAgent(id, label) {
  if (state.agents.has(id)) {
    const existing = state.agents.get(id);
    if (label) existing.label = label;
    drawAgent(existing);
    return existing;
  }
  const agent = {
    id,
    label: shortLabel(label, id),
    color: DEFAULT_ACCENT,
    nodeId: state.rootId,
    targetId: null,
    traveling: false,
    x: 0,
    y: 0,
  };
  state.agents.set(id, agent);
  agent.color = colorFor(id);
  const pos = state.layout?.pos.get(state.rootId);
  if (pos) {
    agent.x = pos.x;
    agent.y = pos.y;
  }
  drawAgent(agent);
  parkAgents();
  return agent;
}

function dropAgent(id) {
  state.agents.delete(id);
  const node = agentG.querySelector(`[data-agent="${cssEscape(id)}"]`);
  if (node) node.remove();
}

async function loadChildren(dirPath) {
  if (state.mode === "demo") return;
  const node = state.nodes.get(dirPath);
  if (node?.childrenLoaded) return;
  const res = await fetch(`/api/children?path=${encodeURIComponent(dirPath)}`);
  if (!res.ok) return;
  const data = await res.json();
  if (!state.nodes.has(dirPath)) {
    state.nodes.set(dirPath, {
      id: dirPath,
      name: data.name,
      path: dirPath,
      parentId: null,
      childIds: [],
      hasChildren: data.children.length > 0,
      childrenLoaded: true,
    });
  }
  const parent = state.nodes.get(dirPath);
  parent.childIds = data.children.map((c) => c.path);
  parent.hasChildren = data.children.length > 0;
  parent.childrenLoaded = true;
  for (const child of data.children) {
    if (!state.nodes.has(child.path)) {
      state.nodes.set(child.path, {
        id: child.path,
        name: child.name,
        path: child.path,
        parentId: dirPath,
        childIds: [],
        hasChildren: child.hasChildren,
        childrenLoaded: false,
      });
    }
    state.parentOf.set(child.path, dirPath);
  }
}

async function ensurePath(folderPath) {
  if (state.mode === "demo") return state.nodes.has(folderPath) ? folderPath : state.rootId;
  const segsProbe = segmentsFrom(state.rootPath, folderPath);
  let target =
    folderPath === state.rootPath
      ? folderPath
      : segsProbe.length
        ? segsProbe.at(-1).path
        : state.rootId;
  if (target !== state.rootPath && !target.startsWith(`${state.rootPath}/`)) {
    return state.rootId;
  }
  await loadChildren(state.rootPath);
  const segs = segmentsFrom(state.rootPath, target);
  let cursor = state.rootPath;
  for (const seg of segs) {
    if (!state.nodes.has(seg.path)) {
      state.nodes.set(seg.path, {
        id: seg.path,
        name: seg.name,
        path: seg.path,
        parentId: cursor,
        childIds: [],
        hasChildren: true,
        childrenLoaded: false,
      });
      const parent = state.nodes.get(cursor);
      if (parent && !parent.childIds.includes(seg.path)) parent.childIds.push(seg.path);
      state.parentOf.set(seg.path, cursor);
    }
    cursor = seg.path;
    await loadChildren(cursor);
  }
  return target;
}

function expandPath(folderPath) {
  for (const id of ancestorsOf(folderPath).reverse()) {
    state.expanded.add(id);
    state.lastFocus.set(id, Date.now());
  }
}

async function relayout({ tween = true, force = false } = {}) {
  if (force || !state.layout) {
    const prev = state.layout?.pos ? new Map(state.layout.pos) : null;
    const laid = fitAndLayout();
    if (!laid) return;
    rememberTrailEdges(laid);
    await interpolateLayout(tween ? prev : null, laid, tween && prev ? 480 : 0);
    userMovedCamera = false;
    if (stageReady()) await fitToStage({ tween });
    else scheduleFit();
    return;
  }
  const added = appendMissingNodes();
  if (state.layout) {
    rememberTrailEdges(state.layout);
    drawTree(state.layout, { entering: new Set(added) });
    parkAgents();
  }
  await keepGraphFramed({ tween, extraIds: added });
}

function edgeFor(from, to, pos) {
  const a = pos.get(from);
  const b = pos.get(to);
  if (!a || !b) return null;
  return edgePath(a.x, a.y, b.x, b.y);
}

function measurePath(d) {
  const path = el("path", { d, fill: "none", stroke: "none" }, defs);
  const len = path.getTotalLength();
  const at = (u) => path.getPointAtLength(Math.min(len, Math.max(0, u * len)));
  return {
    len,
    at,
    start: at(0),
    end: at(1),
    release() {
      path.remove();
    },
  };
}

function animateAlong(agent, d, ms, reverse = false) {
  if (!d) return Promise.resolve();
  const epoch = trailEpoch;
  const measured = measurePath(d);
  if (reduceMotion || ms <= 0) {
    const pt = reverse ? measured.start : measured.end;
    agent.x = pt.x;
    agent.y = pt.y;
    drawAgent(agent);
    measured.release();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      if (epoch !== trailEpoch) {
        measured.release();
        resolve();
        return;
      }
      const t = Math.min(1, (now - t0) / ms);
      const u = reverse ? 1 - easeInOut(t) : easeInOut(t);
      const pt = measured.at(u);
      agent.x = pt.x;
      agent.y = pt.y;
      drawAgent(agent);
      if (t < 1) requestAnimationFrame(frame);
      else {
        measured.release();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

async function travel(agent, destId) {
  const epoch = trailEpoch;
  const start = agent.nodeId || state.rootId;
  if (start === destId) {
    agent.nodeId = destId;
    parkAgents();
    return;
  }
  const hops = hopsBetween(start, destId, state.parentOf);
  agent.traveling = true;
  agent.targetId = destId;
  const pos = state.layout.pos;
  for (let i = 0; i < hops.length - 1; i += 1) {
    if (epoch !== trailEpoch) {
      agent.traveling = false;
      agent.targetId = null;
      return;
    }
    const from = hops[i];
    const to = hops[i + 1];
    const down = state.parentOf.get(to) === from;
    const parent = down ? from : to;
    const child = down ? to : from;
    const d = edgeFor(parent, child, pos);
    if (d) {
      const measured = measurePath(d);
      const entry = down ? measured.start : measured.end;
      measured.release();
      await animateAlong(agent, `M ${agent.x} ${agent.y} L ${entry.x} ${entry.y}`, 70);
      await animateAlong(agent, d, 360, !down);
      if (down) markEdgeVisited(from, to);
      else markEdgeVisited(to, from);
    } else {
      const p = pos.get(to);
      if (p) {
        agent.x = p.x;
        agent.y = p.y;
        drawAgent(agent);
      }
    }
    state.visited.set(to, (state.visited.get(to) || 0) + 1);
    agent.nodeId = to;
    refreshNodeLooks();
  }
  agent.nodeId = destId;
  agent.targetId = null;
  agent.traveling = false;
  refreshNodeLooks();
  parkAgents();
}

function enqueue(agentId, fn) {
  const prev = queues.get(agentId) || Promise.resolve();
  const next = prev.then(fn).catch((err) => console.error(err));
  queues.set(agentId, next);
  return next;
}

async function visit(agentId, folderPath, meta = {}) {
  const id = agentId || "main";
  if (
    state.mode === "live" &&
    state.sessionId &&
    id !== state.sessionId
  ) {
    return enqueue(`trail:${id}`, async () => {
      const resolved = await ensurePath(folderPath);
      expandPath(resolved);
      state.visited.set(resolved, (state.visited.get(resolved) || 0) + 1);
      for (const anc of ancestorsOf(resolved)) {
        if (!state.visited.has(anc)) state.visited.set(anc, 1);
      }
      const added = appendMissingNodes();
      rememberTrailEdges(state.layout);
      if (added.length) drawTree(state.layout, { entering: new Set(added) });
      else refreshNodeLooks();
    });
  }
  return enqueue(id, async () => {
    const resolved = await ensurePath(folderPath);
    const agent = ensureAgent(id, meta.agentLabel);
    agent.targetId = resolved;
    expandPath(resolved);
    state.lastFocus.set(resolved, Date.now());
    state.visited.set(resolved, (state.visited.get(resolved) || 0) + 1);
    for (const anc of ancestorsOf(resolved)) {
      if (!state.visited.has(anc)) state.visited.set(anc, 1);
    }
    const added = appendMissingNodes();
    rememberTrailEdges(state.layout);
    if (added.length) {
      drawTree(state.layout, { entering: new Set(added) });
    } else {
      refreshNodeLooks();
    }
    await keepGraphFramed({ tween: true, extraIds: [...added, resolved], agent });
    peekHere(resolved, meta.filePath);
    pushLog({
      toolName: meta.toolName,
      folderPath: resolved,
      filePath: meta.filePath,
    });
    await travel(agent, resolved);
  });
}

async function onNodeClick(id) {
  els.menu.hidden = true;
  const node = state.nodes.get(id);
  if (!node) return;
  if (node.hasChildren && !node.childrenLoaded && state.mode === "live") {
    await loadChildren(id);
  }
  if (state.expanded.has(id) && id !== state.rootId) {
    state.expanded.delete(id);
  } else if (node.hasChildren) {
    state.expanded.add(id);
    state.userPins.add(id);
    state.lastFocus.set(id, Date.now());
  }
  await relayout({ tween: true });
}

function openOverflow(parentId, ev) {
  const all = state.nodes.get(parentId)?.childIds ?? [];
  const shown = new Set(state.shown.get(parentId) ?? []);
  const hiddenIds = all.filter((id) => !shown.has(id));
  els.menu.replaceChildren();
  for (const id of hiddenIds) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = state.nodes.get(id)?.name || id;
    btn.addEventListener("click", async () => {
      els.menu.hidden = true;
      state.userPins.add(id);
      state.lastFocus.set(id, Date.now());
      await relayout({ tween: true });
    });
    els.menu.appendChild(btn);
  }
  const rect = els.stage.getBoundingClientRect();
  els.menu.hidden = false;
  els.menu.style.left = `${ev.clientX - rect.left}px`;
  els.menu.style.top = `${ev.clientY - rect.top}px`;
}

async function startLive() {
  const res = await fetch("/api/state");
  const data = await res.json();
  await applySnapshot(data);
}

function startDemo() {
  window.clearTimeout(demoTimer);
  state.mode = "demo";
  state.sessionId = "sample";
  setSessionTitle("Preview");
  state.agents = new Map();
  queues.clear();
  const { rootId, nodes } = buildShowcaseTree();
  const parentOf = new Map();
  for (const node of nodes.values()) parentOf.set(node.id, node.parentId);
  resetTree({
    rootId,
    rootPath: rootId,
    name: "acme",
    nodes,
    parentOf,
  });
  ensureAgent("main", "agent");
  setLive("on", "demo walk");
  fetch("/api/state")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data?.sessions) fillSessionSelect(data.sessions, data.sessionId);
    })
    .catch(() => {});
  const steps = showcaseWalk();
  let i = 0;
  const tick = async () => {
    if (state.mode !== "demo") return;
    if (i >= steps.length) {
      setLive("on", "demo idle");
      return;
    }
    const folder = steps[i];
    i += 1;
    await visit("main", folder, { toolName: "list_dir", agentLabel: "agent" });
    demoTimer = window.setTimeout(tick, 280);
  };
  tick();
}

let stream = null;
function connectStream() {
  if (stream) return;
  stream = new EventSource("/api/stream");
  stream.onopen = () => {
    if (state.mode === "live") setLive("on", "attached");
  };
  stream.onerror = () => {
    if (state.mode === "live") setLive("waiting", "reconnecting");
  };
  stream.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.type === "snapshot") {
      if (data.sessions) fillSessionSelect(data.sessions, data.sessionId);
      if (state.mode === "live") applySnapshot(data);
      return;
    }
    if (data.type === "root") {
      return;
    }
    if (data.type === "activity") {
      setLive(data.active ? "on" : "waiting", data.active ? "exploring" : "idle");
    }
    if (data.type === "agent" && data.status === "start") {
      if (data.cwd && state.rootPath && data.cwd !== state.rootPath) return;
      if (state.sessionId && data.agentId !== state.sessionId) return;
      ensureAgent(data.agentId, data.agentLabel);
    }
    if (data.type === "agent" && data.status === "stop") {
      dropAgent(data.agentId);
    }
    if (data.type === "visit") {
      if (state.mode !== "live") return;
      if (!inRoot(data.folderPath) && data.cwd && data.cwd !== state.rootPath) return;
      setLive("on", "exploring");
      visit(data.agentId, data.folderPath, {
        toolName: data.toolName,
        filePath: data.filePath,
        agentLabel: data.agentLabel,
      });
    }
  };
}

els.demo?.addEventListener("click", () => startDemo());

els.opacity?.addEventListener("input", () => {
  applyOpacity(Number(els.opacity.value) / 100);
});
els.opacity?.addEventListener("change", () => {
  applyOpacity(Number(els.opacity.value) / 100, { persist: true });
});
els.themeSeg?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-theme]");
  if (!btn) return;
  applyTheme(btn.dataset.theme, { persist: true });
});
els.followSeg?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-follow]");
  if (!btn) return;
  applyFollow(btn.dataset.follow, { persist: true });
});
els.sessionSearch?.addEventListener("input", () => renderSessionPicker());
els.sessionSearch?.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    setSessionPickerOpen(false);
  }
});
els.pickerScrim?.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  closePickers();
});
if (window.ResizeObserver) {
  for (const picker of [els.sessionPicker, els.settingsPicker]) {
    if (!picker) continue;
    new ResizeObserver(() => {
      if (!picker.hidden) syncPickerOverlay();
    }).observe(picker);
  }
}

document.addEventListener("click", (ev) => {
  if (els.menu && !els.menu.contains(ev.target)) els.menu.hidden = true;
  if (els.colorPick && !els.colorPick.contains(ev.target)) setColorMenuOpen(false);
  if (els.sessionPicker && !els.sessionPicker.hidden && !els.sessionPicker.contains(ev.target)) {
    setSessionPickerOpen(false);
  }
  if (els.settingsPicker && !els.settingsPicker.hidden && !els.settingsPicker.contains(ev.target)) {
    setSettingsPickerOpen(false);
  }
});

document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "p") {
    ev.preventDefault();
    toggleSessionPicker();
  }
  if (ev.key === "Escape") {
    if (els.sessionPicker && !els.sessionPicker.hidden) {
      ev.preventDefault();
      setSessionPickerOpen(false);
    }
    if (els.settingsPicker && !els.settingsPicker.hidden) {
      ev.preventDefault();
      setSettingsPickerOpen(false);
    }
  }
});

let dragging = false;
let dragStart = null;
function overStage(ev) {
  if (!els.stage) return false;
  const rect = els.stage.getBoundingClientRect();
  return (
    ev.clientX >= rect.left &&
    ev.clientX <= rect.right &&
    ev.clientY >= rect.top &&
    ev.clientY <= rect.bottom
  );
}
function onMapPointerDown(ev) {
  const node = ev.target instanceof Element ? ev.target : ev.target?.parentElement;
  if (node?.closest(".folder, .more, #btn-center, #btn-demo, .stage-tools, #overflow-menu, .face, header, footer, .chrome")) {
    return;
  }
  if (!overStage(ev)) return;
  dragging = false;
  dragStart = { x: ev.clientX, y: ev.clientY, cx: camera.x, cy: camera.y };
  els.svg.classList.add("dragging");
}
els.stage?.addEventListener("pointerdown", onMapPointerDown);
window.addEventListener("pointermove", (ev) => {
  if (!dragStart) return;
  const dx = ev.clientX - dragStart.x;
  const dy = ev.clientY - dragStart.y;
  if (Math.hypot(dx, dy) > 4) {
    dragging = true;
    userMovedCamera = true;
  }
  camera.x = dragStart.cx + dx;
  camera.y = dragStart.cy + dy;
  confineCamera();
});
window.addEventListener("pointerup", () => {
  dragStart = null;
  els.svg.classList.remove("dragging");
});
function zoomAt(mx, my, next) {
  const prev = camera.k || 1;
  const k = Math.min(2.4, Math.max(0.22, next));
  if (k === prev) return;
  userMovedCamera = true;
  const sx = (mx - camera.x) / prev;
  const sy = (my - camera.y) / prev;
  camera.k = k;
  camera.x = mx - sx * k;
  camera.y = my - sy * k;
  confineCamera();
}

function onMapWheel(ev) {
  const node = ev.target instanceof Element ? ev.target : ev.target?.parentElement;
  if (node?.closest("#settings-picker, #session-picker, #picker-scrim, header, footer, .chrome, #overflow-menu")) {
    return;
  }
  if (!overStage(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const rect = els.stage.getBoundingClientRect();
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? rect.height : 1;
  const dx = ev.deltaX * (ev.deltaMode === 2 ? rect.width : unit);
  const dy = ev.deltaY * unit;
  if (ev.metaKey) {
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    zoomAt(mx, my, (camera.k || 1) * Math.exp(-dy * 0.012));
    return;
  }
  if (!dx && !dy) return;
  userMovedCamera = true;
  camera.x -= dx;
  camera.y -= dy;
  confineCamera();
}
window.addEventListener("wheel", onMapWheel, { passive: false, capture: true });

window.addEventListener("resize", () => {
  seq += 1;
  const token = seq;
  if (anyPickerOpen()) syncPickerOverlay();
  window.setTimeout(() => {
    if (token === seq) onStageResize();
  }, 80);
});

if (window.ResizeObserver) {
  const relayoutUi = () => {
    seq += 1;
    const token = seq;
    window.setTimeout(() => {
      if (token === seq) onStageResize();
    }, 40);
  };
  if (els.stage) new ResizeObserver(relayoutUi).observe(els.stage);
  if (els.instrument) new ResizeObserver(() => layoutInstrument()).observe(els.instrument);
}

const autoDemo = new URLSearchParams(location.search).get("demo") === "1";
setAccent(prefGet("accent") || DEFAULT_ACCENT);
setAgentSymbol(prefGet("face"));
setShape(prefGet("shape") || "tree", { persist: false, morph: false });
applyTheme(prefGet("theme") || "system");
applyFollow(prefGet("follow") || "focus", { persist: false });
applySettingsHidden(prefGet("settings") === "off", { persist: false });
if (systemDark.addEventListener) {
  systemDark.addEventListener("change", () => {
    if (state.theme === "system") applyTheme("system");
  });
} else if (systemDark.addListener) {
  systemDark.addListener(() => {
    if (state.theme === "system") applyTheme("system");
  });
}
applyOpacity(Number(prefGet("opacity") || 0.96));
fetch("/api/prefs")
  .then((res) => (res.ok ? res.json() : null))
  .then((prefs) => {
    if (prefs?.accent) setAccent(prefs.accent);
    if (Object.prototype.hasOwnProperty.call(prefs || {}, "agentSymbol")) {
      setAgentSymbol(prefs.agentSymbol);
    }
    if (prefs?.shape) setShape(prefs.shape, { persist: false, morph: false });
    if (prefs?.theme) applyTheme(prefs.theme);
    if (typeof prefs?.opacity === "number") applyOpacity(prefs.opacity);
    if (prefs?.graphFollow) applyFollow(prefs.graphFollow, { persist: false });
    if (typeof prefs?.settingsHidden === "boolean") applySettingsHidden(prefs.settingsHidden, { persist: false });
  })
  .catch(() => {});
layoutInstrument();
if (autoDemo) startDemo();
else {
  connectStream();
  window.setTimeout(() => {
    if (!state.rootId) startLive();
  }, 900);
}
