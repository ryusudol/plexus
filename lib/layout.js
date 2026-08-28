export const NODE_W = 108;
export const NODE_H = 28;
export const GAP_X = 18;
export const GAP_Y = 72;

export function measureWidth(rootId, getShownChildren, nodeW = NODE_W, gapX = GAP_X) {
  function walk(id) {
    const kids = getShownChildren(id) || [];
    if (!kids.length) return nodeW;
    const inner =
      kids.reduce((sum, child) => sum + walk(child), 0) + gapX * Math.max(0, kids.length - 1);
    return Math.max(nodeW, inner);
  }
  return walk(rootId);
}

function pathSet(pinnedIds, parentOf) {
  const onPath = new Set();
  for (const pinned of pinnedIds) {
    let cursor = pinned;
    const guard = new Set();
    while (cursor && !guard.has(cursor)) {
      onPath.add(cursor);
      guard.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return onPath;
}

function oldestExpandable(expanded, onPath, lastFocus, rootId) {
  const candidates = [];
  for (const id of expanded) {
    if (id === rootId) continue;
    if (onPath.has(id)) continue;
    candidates.push(id);
  }
  candidates.sort((a, b) => {
    const fa = lastFocus.get(a) || 0;
    const fb = lastFocus.get(b) || 0;
    if (fa !== fb) return fa - fb;
    return String(a).localeCompare(String(b));
  });
  return candidates;
}

/**
 * Keep the diagram within maxWidth by folding stale branches, then hiding
 * extra siblings behind overflow. Nodes on an agent/user pin path stay visible.
 */
export function fitToWidth({
  rootId,
  expanded,
  getAllChildIds,
  parentOf,
  pinnedIds,
  lastFocus = new Map(),
  maxWidth,
  nodeW = NODE_W,
  gapX = GAP_X,
}) {
  const exp = new Set(expanded);
  const hidden = new Map();
  const onPath = pathSet(pinnedIds, parentOf);

  const shownOf = (id) => {
    if (!exp.has(id)) return [];
    const hide = hidden.get(id);
    const kids = getAllChildIds(id) || [];
    if (!hide || hide.size === 0) return kids.slice();
    return kids.filter((child) => !hide.has(child));
  };

  const width = () => measureWidth(rootId, shownOf, nodeW, gapX);

  for (const id of oldestExpandable(exp, onPath, lastFocus, rootId)) {
    if (width() <= maxWidth) break;
    exp.delete(id);
  }

  const hideOne = () => {
    let best = null;
    const visit = (id) => {
      if (!exp.has(id)) return;
      const kids = shownOf(id);
      const unpinned = kids.filter((child) => !onPath.has(child));
      if (unpinned.length && (!best || unpinned.length > best.unpinned.length)) {
        best = { id, unpinned };
      }
      for (const child of kids) visit(child);
    };
    visit(rootId);
    if (!best) return false;
    const victim = best.unpinned[best.unpinned.length - 1];
    if (!hidden.has(best.id)) hidden.set(best.id, new Set());
    hidden.get(best.id).add(victim);
    return true;
  };

  let guard = 0;
  while (width() > maxWidth && guard < 400) {
    if (!hideOne()) break;
    guard += 1;
  }

  const shown = new Map();
  const collect = (id) => {
    const kids = shownOf(id);
    shown.set(id, kids);
    if (exp.has(id)) {
      for (const child of kids) collect(child);
    }
  };
  collect(rootId);

  return { expanded: exp, hidden, shown, onPath, width: width() };
}

function coneSpan(n) {
  if (n <= 1) return 0;
  return Math.min(1.22, 0.36 + 0.11 * (n - 1));
}

function coneRadius(n) {
  if (n <= 1) return 62;
  return 62 + Math.min(28, (n - 2) * 4);
}

function ringRadius(depth) {
  if (depth <= 0) return 0;
  return 70 + (depth - 1) * 66;
}

function finishLayout(pos, rootId, getShownChildren) {
  const edges = [];
  function walk(id) {
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

function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function largestGapAngle(angles) {
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
}) {
  const leafCount = new Map();
  function count(id) {
    const kids = getShownChildren(id) || [];
    const n = kids.length ? kids.reduce((sum, child) => sum + count(child), 0) : 1;
    leafCount.set(id, n);
    return n;
  }
  count(rootId);

  const pos = new Map();
  function place(id, x, y, heading, depth) {
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
export function layoutCircular({ rootId, getShownChildren }) {
  const leafCount = new Map();
  function count(id) {
    const kids = getShownChildren(id) || [];
    const n = kids.length ? kids.reduce((sum, child) => sum + count(child), 0) : 1;
    leafCount.set(id, n);
    return n;
  }
  count(rootId);

  const pos = new Map();
  function place(id, a0, a1, depth) {
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

export function layoutTrail({ mode = "tree", rootId, getShownChildren }) {
  if (mode === "circle") return layoutCircular({ rootId, getShownChildren });
  return layoutRadial({ rootId, getShownChildren });
}

function attachOnCircle(parentPos, siblingPositions) {
  const depth = (parentPos.depth || 0) + 1;
  const r = siblingPositions.length
    ? siblingPositions.reduce((sum, p) => sum + Math.hypot(p.x, p.y), 0) /
      siblingPositions.length
    : ringRadius(depth);
  let angle;
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
export function attachChild(parentPos, siblingPositions = [], { mode = "tree" } = {}) {
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
export function cameraPanToInclude({ points, view, camera, pad = 64 }) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return null;
  const w = view?.w || 0;
  const h = view?.h || 0;
  if (w < 80 || h < 80) return null;
  const x = camera.x;
  const y = camera.y;
  const k = camera.k;
  const toView = (p) => ({ vx: p.x * k + x, vy: p.y * k + y });

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
export function clampCameraToGraph({ bounds, view, camera, margin = 72 }) {
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
export function fitCameraToBounds({ bounds, view, pad = 22, minK = 0.22, maxK = 1.7 }) {
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

export function layoutTree({
  rootId,
  getShownChildren,
  nodeW = NODE_W,
  nodeH = NODE_H,
  gapX = GAP_X,
  gapY = GAP_Y,
  maxWidth,
}) {
  const size = new Map();

  function measure(id) {
    const kids = getShownChildren(id) || [];
    if (!kids.length) {
      const leaf = { w: nodeW, h: nodeH };
      size.set(id, leaf);
      return leaf;
    }
    const measured = kids.map(measure);
    const w = Math.max(
      nodeW,
      measured.reduce((sum, item) => sum + item.w, 0) + gapX * (kids.length - 1),
    );
    const h = nodeH + gapY + Math.max(...measured.map((item) => item.h));
    const box = { w, h };
    size.set(id, box);
    return box;
  }

  const rootSize = measure(rootId);
  const pos = new Map();

  function place(id, xLeft, y) {
    const box = size.get(id);
    const cx = xLeft + box.w / 2;
    pos.set(id, { x: cx, y, w: nodeW, h: nodeH, subtreeW: box.w });
    const kids = getShownChildren(id) || [];
    if (!kids.length) return;
    const inner =
      kids.reduce((sum, child) => sum + size.get(child).w, 0) + gapX * (kids.length - 1);
    let x = xLeft + (box.w - inner) / 2;
    for (const child of kids) {
      place(child, x, y + nodeH + gapY);
      x += size.get(child).w + gapX;
    }
  }

  const totalW = Math.max(rootSize.w, maxWidth || 0);
  const x0 = (totalW - rootSize.w) / 2;
  place(rootId, x0, 48);

  const edges = [];
  function walkEdges(id) {
    const parent = pos.get(id);
    const kids = getShownChildren(id) || [];
    for (const child of kids) {
      const c = pos.get(child);
      edges.push({
        from: id,
        to: child,
        x1: parent.x,
        y1: parent.y + nodeH / 2,
        x2: c.x,
        y2: c.y - nodeH / 2,
      });
      walkEdges(child);
    }
  }
  walkEdges(rootId);

  return {
    pos,
    edges,
    width: totalW,
    height: rootSize.h + 96,
    size,
  };
}

export function edgePath(x1, y1, x2, y2) {
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

export function hopsBetween(fromId, toId, parentOf) {
  if (fromId === toId) return [];
  const up = [];
  const fromAncestors = new Map();
  let cursor = fromId;
  let depth = 0;
  while (cursor) {
    fromAncestors.set(cursor, depth);
    if (cursor === toId) break;
    cursor = parentOf.get(cursor) ?? null;
    depth += 1;
  }

  const down = [];
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
  const seq = [];
  for (const id of [...up, lca, ...down]) {
    if (id && id !== seq[seq.length - 1]) seq.push(id);
  }
  if (seq[0] !== fromId) seq.unshift(fromId);
  return seq;
}

export function hiddenCount(allChildIds, shownChildIds) {
  const shown = new Set(shownChildIds);
  return allChildIds.filter((id) => !shown.has(id)).length;
}
