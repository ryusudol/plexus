export type Point = { x: number; y: number };
export type Camera = { x: number; y: number; k: number };
export type ViewSize = { w: number; h: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type TrailMode = "tree" | "circle";

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
  return Math.min(1.22, 0.36 + 0.11 * (n - 1));
}

function coneRadius(n: number): number {
  if (n <= 1) return 62;
  return 62 + Math.min(28, (n - 2) * 4);
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
    const span = coneSpan(kids.length);
    const radius = coneRadius(kids.length);
    const total = kids.reduce((sum, child) => sum + (leafCount.get(child) || 1), 0) || 1;
    let cursor = heading - span / 2;
    for (const child of kids) {
      const slice =
        span === 0
          ? 0
          : span * ((leafCount.get(child) || 1) / total);
      const childHeading = kids.length === 1 ? heading : cursor + slice / 2;
      place(
        child,
        x + Math.cos(childHeading) * radius,
        y + Math.sin(childHeading) * radius,
        childHeading,
        depth + 1,
      );
      cursor += slice || 0;
    }
  }
  place(rootId, 0, 0, Math.PI / 2, 0);
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

export function layoutTrail({
  mode = "tree",
  rootId,
  getShownChildren,
}: {
  mode?: TrailMode | string;
  rootId: string;
  getShownChildren: ShownChildren;
}): GraphLayout {
  if (mode === "circle") return layoutCircular({ rootId, getShownChildren });
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

/**
 * Place one new child without moving siblings already on the map.
 * `mode: "circle"` parks the child on the depth ring around the origin.
 */
export function attachChild(
  parentPos: NodePos,
  siblingPositions: NodePos[] = [],
  { mode = "tree" }: { mode?: TrailMode | string } = {},
): NodePos {
  if (mode === "circle") return attachOnCircle(parentPos, siblingPositions);
  const heading0 = parentPos.angle ?? Math.PI / 2;
  if (!siblingPositions.length) {
    const radius = 62;
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
    r: Math.hypot(p.x - parentPos.x, p.y - parentPos.y) || 62,
  }));
  const radius = rel.reduce((sum, item) => sum + item.r, 0) / rel.length;
  const angles = rel.map((item) => item.a).sort((a, b) => a - b);
  const lo = angles[0];
  const hi = angles[angles.length - 1];
  const delta = 0.22;
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
 * Left/right (and top/bottom) insets stay equal — extra pad on one side
 * would park the graph off-center.
 */
export function fitCameraToBounds({
  bounds,
  view,
  pad = 22,
  minK = 0.22,
  maxK = 1.7,
}: {
  bounds?: Bounds | null;
  view?: Partial<ViewSize> | null;
  pad?: number;
  minK?: number;
  maxK?: number;
}): Camera | null {
  const w = view?.w || 0;
  const h = view?.h || 0;
  if (w < 80 || h < 80 || !bounds) return null;
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const inset = Math.max(0, pad);
  const k = Math.max(minK, Math.min(maxK, (w - inset * 2) / bw, (h - inset * 2) / bh));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    x: w / 2 - cx * k,
    y: h / 2 - cy * k,
    k,
  };
}

export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  if (dist < 1.2) {
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  const nx = -dy / dist;
  const ny = dx / dist;
  const bend = Math.min(34, dist * 0.28);
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
