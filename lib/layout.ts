export type Point = { x: number; y: number };
export type Camera = { x: number; y: number; k: number };
export type ViewSize = { w: number; h: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type TrailMode = "tree" | "circle" | "neurons";

export function parseTrailMode(value: unknown): TrailMode {
  if (value === "tree" || value === "circle" || value === "neurons") return value;
  return "neurons";
}

export type NodePos = {
  x: number;
  y: number;
  w: number;
  h: number;
  angle?: number;
  depth?: number;
  subtreeW?: number;
};

export type LayoutEdge = {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type GraphLayout = {
  pos: Map<string, NodePos>;
  edges: LayoutEdge[];
  width: number;
  height: number;
  size: Map<string, { w: number; h: number } | NodePos>;
};

export type ShownChildren = (id: string) => string[] | undefined | null;

function coneSpan(n: number): number {
  if (n <= 1) return 0;
  return Math.min(Math.PI * 1.55, 1.02 + 0.3 * (n - 1));
}

function radiusForCount(n: number, span: number, minChord: number): number {
  if (n <= 1 || span <= 0) return 0;
  const theta = span / n;
  const half = Math.max(0.06, theta / 2);
  return minChord / (2 * Math.sin(half));
}

function coneRadius(n: number): number {
  const span = coneSpan(n);
  const base = n <= 1 ? 108 : 116;
  const grown = 108 + Math.min(56, Math.max(0, n - 2) * 8);
  return Math.min(300, Math.max(base, grown, radiusForCount(n, span, 82)));
}

function ringRadius(depth: number): number {
  if (depth <= 0) return 0;
  return 70 + (depth - 1) * 66;
}

function finishLayout(pos: Map<string, NodePos>, rootId: string, getShownChildren: ShownChildren): GraphLayout {
  const edges: LayoutEdge[] = [];
  function walk(id: string) {
    const parent = pos.get(id);
    for (const child of getShownChildren(id) || []) {
      const c = pos.get(child);
      if (!parent || !c) continue;
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
  }
  walk(rootId);

  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return {
    pos,
    edges,
    width: maxX - minX + 96,
    height: maxY - minY + 96,
    size: pos,
  };
}

function unitHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function neuronSpan(n: number, depth: number): number {
  if (n <= 1) return 0;
  // Soma: two dendrites sit nearly opposite; three or more fill the disk.
  if (depth === 0) return n === 2 ? Math.PI * 1.85 : Math.PI * 2;
  return Math.min(2.55, 0.98 + 0.34 * (n - 1));
}

function neuronLen(n: number, depth: number, t: number, index: number): number {
  const base = depth === 0 ? 124 : 92;
  const spread = Math.min(72, Math.max(0, n - 1) * 10);
  const pulse = Math.sin(index * 2.15 + t * 4.2) * (depth === 0 ? 28 : 16);
  const floor = radiusForCount(n, neuronSpan(n, depth), depth === 0 ? 58 : 50);
  return Math.max(floor, base + spread + pulse);
}

function separateOverlaps(
  pos: Map<string, NodePos>,
  rootId: string,
  getShownChildren: ShownChildren,
  minDist: number,
) {
  const parentOf = new Map<string, string>();
  function walk(id: string) {
    for (const child of getShownChildren(id) || []) {
      parentOf.set(child, id);
      walk(child);
    }
  }
  walk(rootId);
  const ids = [...pos.keys()];
  for (let iter = 0; iter < 12; iter += 1) {
    let hits = 0;
    for (let i = 0; i < ids.length; i += 1) {
      if (ids[i] === rootId) continue;
      const a = pos.get(ids[i]);
      if (!a) continue;
      for (let j = i + 1; j < ids.length; j += 1) {
        if (ids[j] === rootId) continue;
        if (parentOf.get(ids[i]) === ids[j] || parentOf.get(ids[j]) === ids[i]) continue;
        const b = pos.get(ids[j]);
        if (!b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d >= minDist) continue;
        hits += 1;
        const push = (minDist - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
    }
    if (!hits) break;
  }
  for (const [id, p] of pos) {
    const parentId = parentOf.get(id);
    const parent = parentId ? pos.get(parentId) : null;
    if (!parent) continue;
    p.angle = Math.atan2(p.y - parent.y, p.x - parent.x);
  }
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function largestGapAngle(angles: number[]): number {
  if (!angles.length) return Math.PI / 2;
  const sorted = angles.slice().sort((a, b) => a - b);
  let bestGap = -1;
  let bestMid = sorted[0];
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    const b = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + Math.PI * 2;
    const gap = b - a;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = a + gap / 2;
    }
  }
  return wrapAngle(bestMid);
}

export function layoutRadial({
  rootId,
  getShownChildren,
}: {
  rootId: string;
  getShownChildren: ShownChildren;
}): GraphLayout {
  const leafCount = new Map<string, number>();
  function count(id: string): number {
    const kids = getShownChildren(id) || [];
    const n = kids.length ? kids.reduce((sum, child) => sum + count(child), 0) : 1;
    leafCount.set(id, n);
    return n;
  }
  count(rootId);

  const pos = new Map<string, NodePos>();
  function place(id: string, x: number, y: number, heading: number, depth: number, a0: number, a1: number) {
    pos.set(id, {
      x,
      y,
      w: 40,
      h: 14,
      angle: heading,
      depth,
    });
    const kids = getShownChildren(id) || [];
    if (!kids.length) return;
    const n = kids.length;
    const avail = Math.max(0, a1 - a0);
    const span = n <= 1 ? 0 : Math.min(coneSpan(n), avail * 0.92);
    const total = kids.reduce((sum, child) => sum + (leafCount.get(child) || 1), 0) || 1;
    const shares = kids.map((child) => 0.55 / n + (0.45 * (leafCount.get(child) || 1)) / total);
    const shareSum = shares.reduce((sum, share) => sum + share, 0) || 1;
    const minTheta = n > 1 ? span * Math.min(...shares) / shareSum : span;
    const radius = Math.min(
      300,
      Math.max(
        coneRadius(n),
        minTheta > 0 ? 78 / (2 * Math.sin(Math.max(0.06, minTheta / 2))) : 0,
      ),
    );
    let start = heading - span / 2;
    if (span > 0 && start < a0) start = a0;
    if (span > 0 && start + span > a1) start = a1 - span;
    let cursor = span === 0 ? heading : start;
    kids.forEach((child, index) => {
      const slice = span === 0 ? 0 : span * (shares[index] / shareSum);
      const childHeading = n === 1 ? heading : cursor + slice / 2;
      const childA0 = n === 1 ? a0 : cursor;
      const childA1 = n === 1 ? a1 : cursor + slice;
      place(
        child,
        x + Math.cos(childHeading) * radius,
        y + Math.sin(childHeading) * radius,
        childHeading,
        depth + 1,
        childA0,
        childA1,
      );
      cursor += slice || 0;
    });
  }
  const rootKids = getShownChildren(rootId) || [];
  const rootSpan = coneSpan(rootKids.length) || 0.01;
  place(rootId, 0, 0, Math.PI / 2, 0, Math.PI / 2 - rootSpan / 2, Math.PI / 2 + rootSpan / 2);
  separateOverlaps(pos, rootId, getShownChildren, 58);
  return finishLayout(pos, rootId, getShownChildren);
}

/**
 * Concentric circular map: root in the center, each depth on a ring.
 * A lone chain stays on the downward ray so a Tree → Circle morph is small.
 */
export function layoutCircular({ rootId, getShownChildren }: {
  rootId: string;
  getShownChildren: ShownChildren;
}): GraphLayout {
  const leafCount = new Map<string, number>();
  function count(id: string): number {
    const kids = getShownChildren(id) || [];
    const n = kids.length ? kids.reduce((sum, child) => sum + count(child), 0) : 1;
    leafCount.set(id, n);
    return n;
  }
  count(rootId);

  const pos = new Map<string, NodePos>();
  function place(id: string, a0: number, a1: number, depth: number) {
    const mid = (a0 + a1) / 2;
    const r = ringRadius(depth);
    pos.set(id, {
      x: depth === 0 ? 0 : Math.cos(mid) * r,
      y: depth === 0 ? 0 : Math.sin(mid) * r,
      w: 40,
      h: 14,
      angle: mid,
      depth,
    });
    const kids = getShownChildren(id) || [];
    if (!kids.length) return;
    const total = kids.reduce((sum, child) => sum + (leafCount.get(child) || 1), 0) || 1;
    const span = a1 - a0;
    let cursor = a0;
    for (const child of kids) {
      const slice = span * ((leafCount.get(child) || 1) / total);
      place(child, cursor, cursor + slice, depth + 1);
      cursor += slice;
    }
  }
  place(rootId, Math.PI / 2 - Math.PI, Math.PI / 2 + Math.PI, 0);
  return finishLayout(pos, rootId, getShownChildren);
}

/**
 * Neural arbor: soma at the root, dendrites radiating around each parent
 * with deterministic length/angle jitter so the map stays stable.
 */
export function layoutNeurons({
  rootId,
  getShownChildren,
}: {
  rootId: string;
  getShownChildren: ShownChildren;
}): GraphLayout {
  const leafCount = new Map<string, number>();
  function count(id: string): number {
    const kids = getShownChildren(id) || [];
    const n = kids.length ? kids.reduce((sum, child) => sum + count(child), 0) : 1;
    leafCount.set(id, n);
    return n;
  }
  count(rootId);

  const pos = new Map<string, NodePos>();
  function place(id: string, x: number, y: number, heading: number, depth: number) {
    pos.set(id, {
      x,
      y,
      w: 40,
      h: 14,
      angle: heading,
      depth,
    });
    const kids = getShownChildren(id) || [];
    if (!kids.length) return;
    const n = kids.length;
    const span = neuronSpan(n, depth);
    const total = kids.reduce((sum, child) => sum + (leafCount.get(child) || 1), 0) || 1;
    let cursor = heading - span / 2;
    kids.forEach((child, index) => {
      const slice = span === 0 ? 0 : span * ((leafCount.get(child) || 1) / total);
      const t = unitHash(child);
      const wobble = span === 0 ? (t - 0.5) * 0.2 : (t - 0.5) * Math.min(0.28, Math.max(0.06, slice * 0.5));
      const childHeading = n === 1 ? heading + wobble : cursor + slice / 2 + wobble;
      const leaves = leafCount.get(child) || 1;
      const bulk = Math.min(96, Math.log2(1 + leaves) * 22);
      const radius = neuronLen(n, depth, t, index) + bulk;
      place(
        child,
        x + Math.cos(childHeading) * radius,
        y + Math.sin(childHeading) * radius,
        childHeading,
        depth + 1,
      );
      cursor += slice || 0;
    });
  }
  place(rootId, 0, 0, Math.PI / 2, 0);
  return finishLayout(pos, rootId, getShownChildren);
}

export function layoutTrail({
  mode = "neurons",
  rootId,
  getShownChildren,
}: {
  mode?: TrailMode | string;
  rootId: string;
  getShownChildren: ShownChildren;
}): GraphLayout {
  const kind = parseTrailMode(mode);
  if (kind === "circle") return layoutCircular({ rootId, getShownChildren });
  if (kind === "neurons") return layoutNeurons({ rootId, getShownChildren });
  return layoutRadial({ rootId, getShownChildren });
}

function attachOnCircle(parentPos: NodePos, siblingPositions: NodePos[]): NodePos {
  const depth = (parentPos.depth || 0) + 1;
  const r = siblingPositions.length
    ? siblingPositions.reduce((sum, p) => sum + Math.hypot(p.x, p.y), 0) /
      siblingPositions.length
    : ringRadius(depth);
  let angle: number;
  if (!siblingPositions.length) {
    angle = parentPos.angle ?? Math.PI / 2;
  } else if ((parentPos.depth || 0) === 0) {
    angle = largestGapAngle(siblingPositions.map((p) => Math.atan2(p.y, p.x)));
  } else {
    const rel = siblingPositions.map((p) => Math.atan2(p.y, p.x)).sort((a, b) => a - b);
    const lo = rel[0];
    const hi = rel[rel.length - 1];
    const delta = 0.28;
    angle = hi - lo > Math.PI ? lo - delta : hi + delta;
  }
  return {
    x: Math.cos(angle) * r,
    y: Math.sin(angle) * r,
    angle,
    depth,
    w: 40,
    h: 14,
  };
}

function attachOnNeuron(parentPos: NodePos, siblingPositions: NodePos[]): NodePos {
  const heading0 = parentPos.angle ?? Math.PI / 2;
  const parentDepth = parentPos.depth || 0;
  const depth = parentDepth + 1;
  const n = siblingPositions.length + 1;
  const jitter = (n * 0.37) % 1;
  const radius = Math.max(
    neuronLen(n, parentDepth, jitter, siblingPositions.length),
    siblingPositions.length
      ? siblingPositions.reduce(
          (sum, p) => sum + Math.hypot(p.x - parentPos.x, p.y - parentPos.y),
          0,
        ) / siblingPositions.length
      : 0,
  );
  let angle: number;
  if (!siblingPositions.length) {
    angle = heading0 + (jitter - 0.5) * 0.22;
  } else if (parentDepth === 0) {
    angle = largestGapAngle(
      siblingPositions.map((p) => Math.atan2(p.y - parentPos.y, p.x - parentPos.x)),
    );
  } else {
    const angles = siblingPositions
      .map((p) => Math.atan2(p.y - parentPos.y, p.x - parentPos.x))
      .sort((a, b) => a - b);
    const lo = angles[0];
    const hi = angles[angles.length - 1];
    const delta = Math.min(1.12, 0.58 + 0.1 * siblingPositions.length);
    angle = hi - lo > Math.PI ? largestGapAngle(angles) : heading0 - lo > hi - heading0 ? lo - delta : hi + delta;
  }
  return {
    x: parentPos.x + Math.cos(angle) * radius,
    y: parentPos.y + Math.sin(angle) * radius,
    angle,
    depth,
    w: 40,
    h: 14,
  };
}

/**
 * Place one new child without moving siblings already on the map.
 * `mode: "circle"` parks the child on the depth ring around the origin.
 * `mode: "neurons"` grows a dendrite off the parent.
 */
export function attachChild(
  parentPos: NodePos,
  siblingPositions: NodePos[] = [],
  { mode = "neurons" }: { mode?: TrailMode | string } = {},
): NodePos {
  const kind = parseTrailMode(mode);
  if (kind === "circle") return attachOnCircle(parentPos, siblingPositions);
  if (kind === "neurons") return attachOnNeuron(parentPos, siblingPositions);
  const heading0 = parentPos.angle ?? Math.PI / 2;
  const n = siblingPositions.length + 1;
  if (!siblingPositions.length) {
    const radius = coneRadius(1);
    return {
      x: parentPos.x + Math.cos(heading0) * radius,
      y: parentPos.y + Math.sin(heading0) * radius,
      angle: heading0,
      depth: (parentPos.depth || 0) + 1,
      w: 40,
      h: 14,
    };
  }
  const rel = siblingPositions.map((p) => ({
    a: Math.atan2(p.y - parentPos.y, p.x - parentPos.x),
    r: Math.hypot(p.x - parentPos.x, p.y - parentPos.y) || coneRadius(n),
  }));
  const radius = Math.max(
    coneRadius(n),
    rel.reduce((sum, item) => sum + item.r, 0) / rel.length,
  );
  const angles = rel.map((item) => item.a).sort((a, b) => a - b);
  const lo = angles[0];
  const hi = angles[angles.length - 1];
  const delta = Math.min(0.92, 0.46 + 0.08 * siblingPositions.length);
  const angle = hi - lo > Math.PI ? lo - delta : hi + delta;
  return {
    x: parentPos.x + Math.cos(angle) * radius,
    y: parentPos.y + Math.sin(angle) * radius,
    angle,
    depth: (parentPos.depth || 0) + 1,
    w: 40,
    h: 14,
  };
}

/**
 * Minimal camera pan so `points` stay inside the padded view.
 * Never changes zoom, never recenters on the whole graph.
 */
export function cameraPanToInclude({
  points,
  view,
  camera,
  pad = 64,
}: {
  points?: Array<Point | null | undefined>;
  view?: Partial<ViewSize> | null;
  camera: Camera;
  pad?: number;
}): Camera | null {
  const pts = (points || []).filter((p): p is Point => p != null && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return null;
  const w = view?.w || 0;
  const h = view?.h || 0;
  if (w < 80 || h < 80) return null;
  const x = camera.x;
  const y = camera.y;
  const k = camera.k;
  const toView = (p: Point) => ({ vx: p.x * k + x, vy: p.y * k + y });

  let needLeft = 0;
  let needRight = 0;
  let needTop = 0;
  let needBottom = 0;
  for (const p of pts) {
    const v = toView(p);
    if (v.vx < pad) needLeft = Math.max(needLeft, pad - v.vx);
    if (v.vx > w - pad) needRight = Math.max(needRight, v.vx - (w - pad));
    if (v.vy < pad) needTop = Math.max(needTop, pad - v.vy);
    if (v.vy > h - pad) needBottom = Math.max(needBottom, v.vy - (h - pad));
  }
  if (!needLeft && !needRight && !needTop && !needBottom) return null;

  const canPan =
    (needLeft === 0 || needRight === 0) && (needTop === 0 || needBottom === 0);
  if (canPan) {
    return {
      x: x + needLeft - needRight,
      y: y + needTop - needBottom,
      k,
    };
  }

  const p = pts[pts.length - 1];
  const v = toView(p);
  let nx = x;
  let ny = y;
  if (v.vx < pad) nx += pad - v.vx;
  else if (v.vx > w - pad) nx -= v.vx - (w - pad);
  if (v.vy < pad) ny += pad - v.vy;
  else if (v.vy > h - pad) ny -= v.vy - (h - pad);
  if (Math.abs(nx - x) < 0.5 && Math.abs(ny - y) < 0.5) return null;
  return { x: nx, y: ny, k };
}

/**
 * Keep at least `margin` pixels of the graph bbox overlapping the view,
 * so the camera cannot wander into empty space.
 */
export function clampCameraToGraph({
  bounds,
  view,
  camera,
  margin = 72,
}: {
  bounds?: Bounds | null;
  view?: Partial<ViewSize> | null;
  camera?: Camera | null;
  margin?: number;
}): Camera | null | undefined {
  if (!bounds || !view || !camera) return camera;
  const w = view.w || 0;
  const h = view.h || 0;
  if (w < 80 || h < 80) return camera;
  const k = camera.k || 1;
  let { x, y } = camera;
  const left = bounds.minX * k + x;
  const right = bounds.maxX * k + x;
  const top = bounds.minY * k + y;
  const bottom = bounds.maxY * k + y;
  if (right < margin) x += margin - right;
  if (left > w - margin) x -= left - (w - margin);
  if (bottom < margin) y += margin - bottom;
  if (top > h - margin) y -= top - (h - margin);
  return { x, y, k };
}

/**
 * Zoom-to-fit a graph bbox so its center sits on the view center.
 * Left/right insets stay equal. Bottom can be tighter than top so the
 * graph does not sit on a large empty band under the stage.
 */
export function fitCameraToBounds({
  bounds,
  view,
  pad = 22,
  padBottom,
  minK = 0.22,
  maxK = 1.7,
}: {
  bounds?: Bounds | null;
  view?: Partial<ViewSize> | null;
  pad?: number;
  padBottom?: number;
  minK?: number;
  maxK?: number;
}): Camera | null {
  const w = view?.w || 0;
  const h = view?.h || 0;
  if (w < 80 || h < 80 || !bounds) return null;
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const insetX = Math.max(0, pad);
  const insetTop = Math.max(0, pad);
  const insetBottom = Math.max(0, padBottom ?? pad);
  const k = Math.max(minK, Math.min(maxK, (w - insetX * 2) / bw, (h - insetTop - insetBottom) / bh));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    x: w / 2 - cx * k,
    y: insetTop + (h - insetTop - insetBottom) / 2 - cy * k,
    k,
  };
}

export function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  { mode }: { mode?: TrailMode | string } = {},
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  if (dist < 1.2) {
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  const nx = -dy / dist;
  const ny = dx / dist;
  const organic = parseTrailMode(mode) === "neurons";
  const bend = Math.min(organic ? 42 : 34, dist * (organic ? 0.36 : 0.28));
  const c1x = x1 + dx * 0.32 + nx * bend;
  const c1y = y1 + dy * 0.32 + ny * bend;
  const c2x = x1 + dx * 0.68 - nx * bend * 0.55;
  const c2y = y1 + dy * 0.68 - ny * bend * 0.55;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

export function hopsBetween(
  fromId: string,
  toId: string,
  parentOf: Map<string, string | null | undefined>,
): string[] {
  if (fromId === toId) return [];
  const up: string[] = [];
  const fromAncestors = new Map<string, number>();
  let cursor: string | null | undefined = fromId;
  let depth = 0;
  while (cursor) {
    fromAncestors.set(cursor, depth);
    if (cursor === toId) break;
    cursor = parentOf.get(cursor) ?? null;
    depth += 1;
  }

  const down: string[] = [];
  cursor = toId;
  while (cursor && !fromAncestors.has(cursor)) {
    down.push(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  const lca = cursor;
  if (!lca) return [toId];

  cursor = fromId;
  while (cursor && cursor !== lca) {
    up.push(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  down.reverse();
  const seq: string[] = [];
  for (const id of [...up, lca, ...down]) {
    if (id && id !== seq[seq.length - 1]) seq.push(id);
  }
  if (seq[0] !== fromId) seq.unshift(fromId);
  return seq;
}
