import { pathUnder } from "../lib/under.ts";
import type { Camera, GraphLayout } from "../lib/layout.ts";
import {
  DEFAULT_ACCENT,
  INK,
  WHITE,
  svgEl as el,
  type AgentMark,
  type AppState,
  type LogEntry,
  type LiveKind,
  type ThemePref,
} from "./hud.ts";

export const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const els = {
  svg: document.querySelector("#map") as SVGSVGElement | null,
  session: document.getElementById("session") as HTMLSelectElement | null,
  demo: document.getElementById("btn-demo") as HTMLElement | null,
  liveStatus: document.getElementById("live"),
  peek: document.getElementById("peek"),
  menu: document.getElementById("overflow-menu") as HTMLElement | null,
  stage: document.getElementById("stage") as HTMLElement | null,
  palette: document.getElementById("palette"),
  colorPick: document.getElementById("color-pick"),
  colorCurrent: document.getElementById("color-current") as HTMLElement | null,
  opacity: document.getElementById("opacity") as HTMLInputElement | null,
  opacityOut: document.getElementById("opacity-out"),
  themeSeg: document.getElementById("theme-seg"),
  shape: document.getElementById("shape") as HTMLElement | null,
  center: document.getElementById("btn-center") as HTMLElement | null,
  face: document.getElementById("agent-face"),
  faceWrap: document.getElementById("agent-face-wrap") as HTMLElement | null,
  faceBtn: document.getElementById("agent-face-btn") as HTMLElement | null,
  faceMenu: document.getElementById("face-menu") as HTMLElement | null,
  settings: document.getElementById("settings") as HTMLElement | null,
  settingsBtn: document.getElementById("btn-settings") as HTMLButtonElement | null,
  settingsTray: document.getElementById("settings-tray") as HTMLElement | null,
  settingsPicker: document.getElementById("settings-picker") as HTMLElement | null,
  instrument: document.querySelector(".instrument") as HTMLElement | null,
  followSeg: document.getElementById("follow-seg"),
  sessionPicker: document.getElementById("session-picker") as HTMLElement | null,
  sessionSearch: document.getElementById("session-search") as HTMLInputElement | null,
  sessionList: document.getElementById("session-list") as HTMLElement | null,
  pickerScrim: document.getElementById("picker-scrim") as HTMLElement | null,
  log: document.getElementById("log"),
};

export const camera: Camera = { x: 0, y: 0, k: 1 };
export const state: AppState = {
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

export const queues = new Map<string, Promise<unknown>>();
export const flags = {
  userMovedCamera: false,
  pendingCenter: false,
  seq: 0,
  demoTimer: 0,
  camGen: 0,
  morphGen: 0,
  trailEpoch: 0,
  lastStage: { w: 0, h: 0 },
  instrumentBusy: false,
};

export const defs = el("defs", {}, els.svg);
export const cameraG = el("g", { id: "camera" }, els.svg);
export const edgeG = el("g", { id: "edges" }, cameraG);
export const nodeG = el("g", { id: "nodes" }, cameraG);
export const moreG = el("g", { id: "more" }, cameraG);
export const agentG = el("g", { id: "agents" }, cameraG);
export const graphEls = { nodes: new Map<string, SVGElement>(), edges: new Map<string, SVGElement>() };

el("marker", { id: "dot", viewBox: "0 0 6 6", refX: "3", refY: "3", markerWidth: "6", markerHeight: "6" }, defs);
const agentClip = el("clipPath", { id: "agent-clip" }, defs);
el("circle", { r: "11", cx: "0", cy: "0" }, agentClip);
export const hitFill = el("rect", {
  class: "hitfill",
  x: "0",
  y: "0",
  width: "4000",
  height: "4000",
  fill: "#0a0a0c",
});
els.svg?.insertBefore(hitFill, cameraG);

export const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

export const hooks = {
  drawTree: (_laid?: GraphLayout | null) => {},
  drawAgent: (_agent: AgentMark) => {},
  colorFor: (_id: string) => state.accent,
  morphShape: async () => {},
  centerView: () => {},
  attachSession: async (_id: string) => {},
};

export function notifyHost(payload: unknown) {
  window.webkit?.messageHandlers?.plexus?.postMessage(payload);
}

export function prefGet(key: string) {
  return localStorage.getItem(`plexus-${key}`) ?? localStorage.getItem(`grok-explore-${key}`);
}

export function prefSet(key: string, value: string | null | undefined) {
  if (value == null || value === "") {
    localStorage.removeItem(`plexus-${key}`);
    localStorage.removeItem(`grok-explore-${key}`);
    return;
  }
  localStorage.setItem(`plexus-${key}`, value);
}

export function savePrefs(extra: Record<string, unknown> = {}) {
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

export function resolvedTheme(): "light" | "dark" {
  if (state.theme === "system") return systemDark.matches ? "dark" : "light";
  return state.theme === "light" ? "light" : "dark";
}

export function accentForTheme(hex = state.accent) {
  if (String(hex).toLowerCase() === WHITE && resolvedTheme() === "light") return INK;
  return hex;
}

export function stageFill() {
  return resolvedTheme() === "light" ? "#f3f3f6" : "#0a0a0c";
}

export function applyCamera() {
  cameraG.setAttribute(
    "transform",
    `translate(${camera.x.toFixed(1)} ${camera.y.toFixed(1)}) scale(${camera.k.toFixed(3)})`,
  );
}

export function stageSize() {
  return { w: els.stage?.clientWidth || 0, h: els.stage?.clientHeight || 0 };
}

export function stageReady() {
  const { w, h } = stageSize();
  return w >= 80 && h >= 80;
}

export function whenStageReady(fn: () => void) {
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

export function syncHitFill() {
  const { w, h } = stageSize();
  hitFill.setAttribute("x", "0");
  hitFill.setAttribute("y", "0");
  hitFill.setAttribute("width", String(Math.max(w, 8)));
  hitFill.setAttribute("height", String(Math.max(h, 8)));
}

export function inRoot(folder: string | null | undefined) {
  return pathUnder(state.rootPath, folder);
}

export function setLive(kind: LiveKind | string, text: string) {
  if (!els.liveStatus) return;
  els.liveStatus.className = `live ${kind}`;
  els.liveStatus.textContent = text;
}

export function pushLog(entry: LogEntry) {
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

export function setPeek(text: string) {
  if (!els.peek) return;
  els.peek.textContent = text || "";
}

export function peekHere(folderPath: string | null | undefined, filePath?: string | null) {
  const loc = filePath || folderPath || "";
  const name = loc.split("/").filter(Boolean).pop() || "";
  setPeek(name ? `now  ${name}` : loc);
}

export type { ThemePref };
