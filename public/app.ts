import { parentFolder, segmentsFrom } from "../lib/extract.ts";
import { pathUnder } from "../lib/under.ts";
import {
  attachChild,
  cameraPanToInclude,
  clampCameraToGraph,
  edgePath,
  fitCameraToBounds,
  hopsBetween,
  layoutTrail,
  type GraphLayout,
  type NodePos,
} from "../lib/layout.ts";
import { buildShowcaseTree, showcaseWalk } from "../lib/demo-tree.ts";
import {
  DEFAULT_ACCENT,
  cssEscape,
  easeInOut,
  edgeKey,
  shortLabel,
  svgEl as el,
  svgNS,
  whisperName,
  type AgentMark,
} from "./hud.ts";
import {
  anyPickerOpen,
  bindChromeEvents,
  fillSessionSelect,
  layoutInstrument,
  restoreChrome,
  setSessionPickerOpen,
  setSessionTitle,
  syncPickerOverlay,
} from "./chrome.ts";
import {
  agentG,
  applyCamera,
  camera,
  defs,
  edgeG,
  els,
  flags,
  graphEls,
  hooks,
  inRoot,
  moreG,
  nodeG,
  peekHere,
  pushLog,
  queues,
  reduceMotion,
  resolvedTheme,
  setLive,
  setPeek,
  stageReady,
  stageSize,
  state,
  syncHitFill,
  whenStageReady,
} from "./runtime.ts";

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

function agentsBusy() {
  for (const agent of state.agents.values()) {
    if (agent.traveling || agent.targetId) return true;
  }
  return false;
}

function fitToStage({ tween = false } = {}) {
  if (!state.layout || !stageReady()) return Promise.resolve();
  const { w, h } = stageSize();
  flags.lastStage = { w, h };
  syncHitFill();
  return tweenCamera(cameraTarget(state.layout), tween ? 360 : 0);
}

function snapCameraToLayout(laid) {
  if (!laid || !stageReady()) return;
  Object.assign(camera, cameraTarget(laid));
  applyCamera();
  flags.lastStage = stageSize();
  syncHitFill();
}

function scheduleFit() {
  flags.pendingCenter = true;
  whenStageReady(() => {
    if (!state.layout || flags.userMovedCamera) return;
    flags.pendingCenter = false;
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
  flags.userMovedCamera = false;
  flags.pendingCenter = true;
  if (!state.layout) {
    scheduleFit();
    return;
  }
  await afterPaint(() => {});
  if (flags.userMovedCamera) return;
  if (!stageReady()) {
    scheduleFit();
    return;
  }
  flags.pendingCenter = false;
  await fitToStage({ tween });
}

function centerView() {
  return centerNewGraph({ tween: true });
}

async function morphShape() {
  if (!state.rootId || !state.layout) return;
  flags.trailEpoch += 1;
  for (const agent of state.agents.values()) {
    agent.traveling = false;
    agent.targetId = null;
  }
  const prev = state.layout.pos ? new Map(state.layout.pos) : null;
  const laid = fitAndLayout();
  if (!laid) return;
  rememberTrailEdges(laid);
  await interpolateLayout(prev, laid, 720, { parkTraveling: true });
  flags.userMovedCamera = false;
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

async function keepGraphFramed({
  tween = true,
  extraIds = [] as string[],
  agent = null,
}: {
  tween?: boolean;
  extraIds?: string[];
  agent?: AgentMark | null;
} = {}) {
  if (!state.layout) return;
  const fit = cameraTarget(state.layout);
  const zoomedIn = flags.userMovedCamera && camera.k > (fit.k || 1) + 0.05;
  if (!zoomedIn && (!flags.userMovedCamera || graphOverflowsView())) {
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
  const gen = ++flags.camGen;
  if (reduceMotion || ms <= 0) {
    camera.x = to.x;
    camera.y = to.y;
    camera.k = to.k;
    applyCamera();
    return Promise.resolve();
  }
  const from = { x: camera.x, y: camera.y, k: camera.k };
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const frame = (now: number) => {
      if (gen !== flags.camGen) {
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

function preserveCameraOnResize() {
  const { w, h } = stageSize();
  if (w < 80 || h < 80) return;
  syncHitFill();
  if (flags.lastStage.w < 80 || flags.lastStage.h < 80) {
    flags.lastStage = { w, h };
    if (!flags.userMovedCamera) fitToStage();
    return;
  }
  if (flags.lastStage.w !== w || flags.lastStage.h !== h) {
    const wx = (flags.lastStage.w / 2 - camera.x) / camera.k;
    const wy = (flags.lastStage.h / 2 - camera.y) / camera.k;
    camera.x = w / 2 - wx * camera.k;
    camera.y = h / 2 - wy * camera.k;
    applyCamera();
  }
  flags.lastStage = { w, h };
}

function onStageResize() {
  layoutInstrument();
  const { w, h } = stageSize();
  syncHitFill();
  if (w < 80 || h < 80) return;
  if (Math.abs(flags.lastStage.w - w) < 2 && Math.abs(flags.lastStage.h - h) < 2) return;
  if (!state.layout) {
    flags.lastStage = { w, h };
    return;
  }
  if (flags.pendingCenter || (!flags.userMovedCamera && !agentsBusy())) {
    flags.pendingCenter = false;
    flags.lastStage = { w, h };
    fitToStage({ tween: false });
    return;
  }
  preserveCameraOnResize();
}

function interpolateLayout(
  fromPos: Map<string, NodePos> | null | undefined,
  laid: GraphLayout,
  ms: number,
  { parkTraveling = false }: { parkTraveling?: boolean } = {},
) {
  const park = (pos?: Map<string, NodePos> | null) => parkAgents(pos, { includeTraveling: parkTraveling });
  const gen = ++flags.morphGen;
  if (reduceMotion || !fromPos || ms <= 0) {
    drawTree(laid);
    park();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const frame = (now: number) => {
      if (gen !== flags.morphGen) {
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
    const d = edgePath(a.x, a.y, b.x, b.y, { mode: state.shape });
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
  const file = node.kind === "file";
  const visited = state.visited.has(id);
  const here = isNeighborhood(id);
  const live = liveNodeIds().has(id);
  const root = id === state.rootId;
  const glow = g.querySelector(".poke-glow");
  const dot = g.querySelector(".dot");
  const mark = g.querySelector(".file-mark");
  const label = g.querySelector(".node-label");
  const title = g.querySelector("title");
  g.classList.toggle("file", file);
  g.classList.toggle("folder", !file);
  g.setAttribute("data-kind", file ? "file" : "folder");
  if (glow) {
    glow.setAttribute("fill", state.accent);
    glow.setAttribute("opacity", live ? "0.14" : "0");
  }
  const fill = live ? "#fff" : visited || root ? state.accent : "#5c5c66";
  const opacity = live || visited || here || root ? "1" : "0.35";
  if (dot) {
    dot.style.display = file ? "none" : "";
    dot.setAttribute("r", live ? "5.2" : root ? "4.4" : visited ? "3.1" : "2.2");
    dot.setAttribute("fill", fill);
    dot.setAttribute("opacity", opacity);
  }
  if (mark) {
    mark.style.display = file ? "" : "none";
    mark.setAttribute("fill", fill);
    mark.setAttribute("opacity", opacity);
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
      label.setAttribute("font-size", root ? "11" : file ? "9.5" : "10");
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

function drawTree(laid: GraphLayout | null | undefined, opts: { posOverride?: Map<string, NodePos>; entering?: Set<string> } = {}) {
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
    const node = state.nodes.get(id);
    if (!node) continue;
    liveNodes.add(id);
    let g = graphEls.nodes.get(id);
    if (!g) {
      g = el("g", {
        class: (node.kind === "file" ? "file" : "folder") + (entering.has(id) ? " born" : ""),
        "data-id": id,
        "data-kind": node.kind === "file" ? "file" : "folder",
      }, nodeG);
      el("circle", { class: "poke-glow", r: "26" }, g);
      el("circle", { class: "dot", r: "2.2" }, g);
      el("rect", { class: "file-mark", x: "-2.1", y: "-2.1", width: "4.2", height: "4.2", rx: "0.7" }, g);
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

function liveNodeIds() {
  const ids = new Set();
  for (const agent of state.agents.values()) {
    if (agent.nodeId) ids.add(agent.nodeId);
    if (agent.targetId) ids.add(agent.targetId);
  }
  return ids;
}

function parkAgents(posMap?: Map<string, NodePos> | null, { includeTraveling = false }: { includeTraveling?: boolean } = {}) {
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
  const core = g.querySelector(".core") as SVGElement | null;
  const face = g.querySelector(".face") as SVGElement | null;
  if (state.agentSymbol && face && core) {
    face.setAttribute("href", state.agentSymbol);
    face.setAttributeNS("http://www.w3.org/1999/xlink", "href", state.agentSymbol);
    face.style.display = "";
    core.style.display = "none";
  } else if (face && core) {
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
  flags.userMovedCamera = false;
  const laid = fitAndLayout();
  if (laid) {
    snapCameraToLayout(laid);
    drawTree(laid);
    scheduleFit();
  }
}

async function attachSession(id) {
  if (!id || id === "sample") return;
  window.clearTimeout(flags.demoTimer);
  state.mode = "live";
  setSessionPickerOpen(false);
  await fetch("/api/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: id }),
  });
  await startLive();
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
    kind: "folder",
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
    window.clearTimeout(flags.demoTimer);
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
    const incomingVisits = (data.visited || []).filter((folder) => pathUnder(root, folder));
    const incomingFiles = (data.files || []).filter((file) => pathUnder(root, file));
    const sparse = sameRoot && laidCount <= 1 && (incomingVisits.length > 0 || incomingFiles.length > 0);
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
      markTrail(folder);
    }
    const files = (data.files || []).filter(inRoot);
    for (const file of files) {
      await ensureFile(file);
      expandPath(file);
      markTrail(file);
    }
    const agents = data.agents || [];
    const liveIds = new Set(agents.map((item) => item.id));
    for (const id of [...state.agents.keys()]) {
      if (!liveIds.has(id)) dropAgent(id);
    }
    for (const item of agents) {
      const agent = ensureAgent(item.id, item.label || item.title);
      const dest = await ensureVisit(item.folderPath, item.filePath);
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
    const lastFile = files[files.length - 1];
    const last = lastFile || visited[visited.length - 1];
    if (last) peekHere(lastFile ? parentFolder(lastFile) : last, lastFile || null);
  } catch (err) {
    setPeek(String(err instanceof Error ? err.message : err));
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

function attachChildNode(parentId, childId) {
  const parent = state.nodes.get(parentId);
  if (parent && !parent.childIds.includes(childId)) parent.childIds.push(childId);
  if (parent) parent.hasChildren = true;
  state.parentOf.set(childId, parentId);
}

function markTrail(nodeId, bump = false) {
  if (!nodeId) return;
  if (bump) state.visited.set(nodeId, (state.visited.get(nodeId) || 0) + 1);
  else if (!state.visited.has(nodeId)) state.visited.set(nodeId, 1);
  for (const anc of ancestorsOf(nodeId)) {
    if (!state.visited.has(anc)) state.visited.set(anc, 1);
  }
}

async function loadChildren(dirPath) {
  if (state.mode === "demo") return;
  const node = state.nodes.get(dirPath);
  if (node?.kind === "file") {
    node.childrenLoaded = true;
    node.hasChildren = false;
    return;
  }
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
      kind: "folder",
    });
  }
  const parent = state.nodes.get(dirPath);
  const folderIds = data.children.map((c) => c.path);
  const keepFiles = (parent.childIds || []).filter(
    (id) => state.nodes.get(id)?.kind === "file" && !folderIds.includes(id),
  );
  parent.childIds = [...folderIds, ...keepFiles];
  parent.hasChildren = parent.childIds.length > 0;
  parent.childrenLoaded = true;
  parent.kind = parent.kind || "folder";
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
        kind: "folder",
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
  if (!pathUnder(state.rootPath, target)) {
    return state.rootId;
  }
  await loadChildren(state.rootPath);
  const segs = segmentsFrom(state.rootPath, target);
  let cursor = state.rootPath;
  for (const seg of segs) {
    const existing = state.nodes.get(seg.path);
    if (existing?.kind === "file") return seg.path;
    if (!existing) {
      state.nodes.set(seg.path, {
        id: seg.path,
        name: seg.name,
        path: seg.path,
        parentId: cursor,
        childIds: [],
        hasChildren: true,
        childrenLoaded: false,
        kind: "folder",
      });
      attachChildNode(cursor, seg.path);
    }
    cursor = seg.path;
    await loadChildren(cursor);
  }
  return target;
}

async function ensureFile(filePath) {
  if (!filePath) return state.rootId;
  if (state.mode === "demo") return state.nodes.has(filePath) ? filePath : state.rootId;
  if (!inRoot(filePath) || filePath === state.rootPath) return state.rootId;
  const folder = parentFolder(filePath);
  const parentId = await ensurePath(folder === filePath ? state.rootPath : folder);
  const name = filePath.split("/").filter(Boolean).pop() || filePath;
  const existing = state.nodes.get(filePath);
  if (existing) {
    existing.kind = "file";
    existing.hasChildren = false;
    existing.childrenLoaded = true;
    existing.parentId = parentId;
  } else {
    state.nodes.set(filePath, {
      id: filePath,
      name,
      path: filePath,
      parentId,
      childIds: [],
      hasChildren: false,
      childrenLoaded: true,
      kind: "file",
    });
  }
  attachChildNode(parentId, filePath);
  return filePath;
}

async function ensureVisit(folderPath, filePath) {
  if (filePath && inRoot(filePath) && filePath !== state.rootPath) {
    return ensureFile(filePath);
  }
  if (folderPath && inRoot(folderPath)) return ensurePath(folderPath);
  return state.rootId;
}

function expandPath(folderPath) {
  for (const id of ancestorsOf(folderPath).reverse()) {
    state.expanded.add(id);
    state.lastFocus.set(id, Date.now());
  }
}

async function relayout({ tween = true, force = false }: { tween?: boolean; force?: boolean } = {}) {
  if (force || !state.layout) {
    const prev = state.layout?.pos ? new Map(state.layout.pos) : null;
    const laid = fitAndLayout();
    if (!laid) return;
    rememberTrailEdges(laid);
    await interpolateLayout(tween ? prev : null, laid, tween && prev ? 480 : 0);
    flags.userMovedCamera = false;
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
  return edgePath(a.x, a.y, b.x, b.y, { mode: state.shape });
}

function measurePath(d: string) {
  const path = el("path", { d, fill: "none", stroke: "none" }, defs) as SVGPathElement;
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

function animateAlong(agent: AgentMark, d: string | null | undefined, ms: number, reverse = false) {
  if (!d) return Promise.resolve();
  const epoch = flags.trailEpoch;
  const measured = measurePath(d);
  if (reduceMotion || ms <= 0) {
    const pt = reverse ? measured.start : measured.end;
    agent.x = pt.x;
    agent.y = pt.y;
    drawAgent(agent);
    measured.release();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const frame = (now: number) => {
      if (epoch !== flags.trailEpoch) {
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

async function travel(agent: AgentMark, destId: string) {
  const epoch = flags.trailEpoch;
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
    if (epoch !== flags.trailEpoch) {
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

async function visit(
  agentId: string | null | undefined,
  folderPath: string,
  meta: { agentLabel?: string; filePath?: string | null; toolName?: string } = {},
) {
  const id = agentId || "main";
  if (
    state.mode === "live" &&
    state.sessionId &&
    id !== state.sessionId
  ) {
    return enqueue(`trail:${id}`, async () => {
      const resolved = await ensureVisit(folderPath, meta.filePath);
      expandPath(resolved);
      markTrail(resolved, true);
      const added = appendMissingNodes();
      rememberTrailEdges(state.layout);
      if (added.length) drawTree(state.layout, { entering: new Set(added) });
      else refreshNodeLooks();
    });
  }
  return enqueue(id, async () => {
    const resolved = await ensureVisit(folderPath, meta.filePath);
    const agent = ensureAgent(id, meta.agentLabel);
    agent.targetId = resolved;
    expandPath(resolved);
    state.lastFocus.set(resolved, Date.now());
    markTrail(resolved, true);
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
  if (node.kind === "file") {
    peekHere(node.parentId, node.path);
    return;
  }
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
  window.clearTimeout(flags.demoTimer);
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
    const dest = steps[i];
    i += 1;
    const node = state.nodes.get(dest);
    const isFile = node?.kind === "file";
    await visit("main", isFile ? node.parentId || dest : dest, {
      toolName: isFile ? "read_file" : "list_dir",
      filePath: isFile ? dest : null,
      agentLabel: "agent",
    });
    flags.demoTimer = window.setTimeout(tick, 280);
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
      const loc = data.filePath || data.folderPath;
      if (!inRoot(loc) && data.cwd && data.cwd !== state.rootPath) return;
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
bindChromeEvents();

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
    flags.userMovedCamera = true;
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
  flags.userMovedCamera = true;
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
  flags.userMovedCamera = true;
  camera.x -= dx;
  camera.y -= dy;
  confineCamera();
}
window.addEventListener("wheel", onMapWheel, { passive: false, capture: true });

window.addEventListener("resize", () => {
  flags.seq += 1;
  const token = flags.seq;
  if (anyPickerOpen()) syncPickerOverlay();
  window.setTimeout(() => {
    if (token === flags.seq) onStageResize();
  }, 80);
});

if (window.ResizeObserver) {
  const relayoutUi = () => {
    flags.seq += 1;
    const token = flags.seq;
    window.setTimeout(() => {
      if (token === flags.seq) onStageResize();
    }, 40);
  };
  if (els.stage) new ResizeObserver(relayoutUi).observe(els.stage);
  if (els.instrument) new ResizeObserver(() => layoutInstrument()).observe(els.instrument);
}

hooks.drawTree = (laid) => drawTree(laid);
hooks.drawAgent = (agent) => drawAgent(agent);
hooks.colorFor = (id) => colorFor(id);
hooks.morphShape = () => morphShape();
hooks.centerView = () => centerView();
hooks.attachSession = (id) => attachSession(id);

const autoDemo = new URLSearchParams(location.search).get("demo") === "1";
restoreChrome();
if (autoDemo) startDemo();
else {
  connectStream();
  window.setTimeout(() => {
    if (!state.rootId) startLive();
  }, 900);
}
