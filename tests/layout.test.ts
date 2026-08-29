import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachChild,
  layoutTrail,
  parseTrailMode,
  type ShownChildren,
} from "../lib/layout.ts";
import { buildShowcaseTree } from "../lib/demo-tree.ts";

const kids: Record<string, string[]> = {
  root: ["root/a", "root/b", "root/c", "root/d"],
  "root/a": ["root/a/1", "root/a/2"],
  "root/b": ["root/b/1"],
  "root/c": [],
  "root/d": ["root/d/1", "root/d/2", "root/d/3"],
};

const getShownChildren: ShownChildren = (id) => kids[id] || [];

function radiiFromRoot(mode: string) {
  const laid = layoutTrail({ mode, rootId: "root", getShownChildren });
  const origin = laid.pos.get("root");
  assert.ok(origin);
  return kids.root.map((id) => {
    const p = laid.pos.get(id);
    assert.ok(p);
    return Math.hypot(p.x - origin.x, p.y - origin.y);
  });
}

describe("parseTrailMode", () => {
  it("keeps tree, circle, and neurons", () => {
    assert.equal(parseTrailMode("tree"), "tree");
    assert.equal(parseTrailMode("circle"), "circle");
    assert.equal(parseTrailMode("neurons"), "neurons");
    assert.equal(parseTrailMode("nope"), "neurons");
    assert.equal(parseTrailMode(undefined), "neurons");
  });
});

describe("trail layouts", () => {
  it("puts circle children on one ring around the origin", () => {
    const radii = radiiFromRoot("circle");
    const mean = radii.reduce((sum, r) => sum + r, 0) / radii.length;
    for (const r of radii) {
      assert.ok(Math.abs(r - mean) < 0.001);
    }
  });

  it("defaults to neurons when mode is omitted", () => {
    const implied = layoutTrail({ rootId: "root", getShownChildren });
    const explicit = layoutTrail({ mode: "neurons", rootId: "root", getShownChildren });
    for (const [id, pos] of explicit.pos) {
      const other = implied.pos.get(id);
      assert.ok(other);
      assert.equal(pos.x, other.x);
      assert.equal(pos.y, other.y);
    }
  });

  it("gives neuron dendrites uneven lengths instead of a ring", () => {
    const radii = radiiFromRoot("neurons");
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    assert.ok(max - min > 4);
  });

  it("spreads neuron root children wider than the tree cone", () => {
    const spread = (mode: string) => {
      const laid = layoutTrail({ mode, rootId: "root", getShownChildren });
      const origin = laid.pos.get("root");
      assert.ok(origin);
      const angles = kids.root.map((id) => {
        const p = laid.pos.get(id);
        assert.ok(p);
        return Math.atan2(p.y - origin.y, p.x - origin.x);
      });
      const sorted = angles.slice().sort((a, b) => a - b);
      return sorted[sorted.length - 1] - sorted[0];
    };
    assert.ok(spread("neurons") > spread("tree") + 0.4);
  });

  it("keeps a full neurons layout stable", () => {
    const a = layoutTrail({ mode: "neurons", rootId: "root", getShownChildren });
    const b = layoutTrail({ mode: "neurons", rootId: "root", getShownChildren });
    for (const [id, pos] of a.pos) {
      const other = b.pos.get(id);
      assert.ok(other);
      assert.equal(pos.x, other.x);
      assert.equal(pos.y, other.y);
    }
  });

  it("grows a neuron child off the parent, not onto the origin ring", () => {
    const parent = { x: 40, y: 50, w: 40, h: 14, angle: 0.4, depth: 1 };
    const child = attachChild(parent, [], { mode: "neurons" });
    const fromParent = Math.hypot(child.x - parent.x, child.y - parent.y);
    const fromOrigin = Math.hypot(child.x, child.y);
    assert.ok(fromParent > 40);
    assert.ok(Math.abs(fromOrigin - fromParent) > 8);
  });

  it("parks a new neuron root child in the open gap", () => {
    const parent = { x: 0, y: 0, w: 40, h: 14, angle: Math.PI / 2, depth: 0 };
    const first = attachChild(parent, [], { mode: "neurons" });
    const second = attachChild(parent, [first], { mode: "neurons" });
    const a = Math.atan2(first.y, first.x);
    const b = Math.atan2(second.y, second.x);
    let gap = Math.abs(b - a);
    if (gap > Math.PI) gap = Math.PI * 2 - gap;
    assert.ok(gap > 2.2);
  });

  it("fills open space as more neuron root children attach", () => {
    const parent = { x: 0, y: 0, w: 40, h: 14, angle: Math.PI / 2, depth: 0 };
    const placed = [];
    for (let i = 0; i < 4; i += 1) {
      placed.push(attachChild(parent, placed, { mode: "neurons" }));
    }
    const angles = placed.map((p) => Math.atan2(p.y, p.x)).sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 0; i < angles.length; i += 1) {
      const a = angles[i];
      const b = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
      maxGap = Math.max(maxGap, b - a);
    }
    const occupied = Math.PI * 2 - maxGap;
    assert.ok(occupied > 3.2);
  });

  it("keeps tree siblings far enough for labels", () => {
    const laid = layoutTrail({ mode: "tree", rootId: "root", getShownChildren });
    const origin = laid.pos.get("root");
    assert.ok(origin);
    const pts = kids.root.map((id) => {
      const p = laid.pos.get(id);
      assert.ok(p);
      return p;
    });
    let min = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
      }
    }
    assert.ok(min > 70);
  });

  it("spreads a dense tree so sibling folders do not sit on each other", () => {
    const dense: Record<string, string[]> = {
      root: Array.from({ length: 12 }, (_, i) => `root/${i}`),
    };
    for (const id of dense.root) dense[id] = [];
    const laid = layoutTrail({
      mode: "tree",
      rootId: "root",
      getShownChildren: (id) => dense[id] || [],
    });
    const pts = dense.root.map((id) => laid.pos.get(id)!);
    let min = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
      }
    }
    assert.ok(min > 64);
  });

  it("keeps a wide expanded tree from stacking cousin folders", () => {
    const { rootId, nodes } = buildShowcaseTree();
    const laid = layoutTrail({
      mode: "tree",
      rootId,
      getShownChildren: (id) => nodes.get(id)?.childIds ?? [],
    });
    const ids = [...laid.pos.keys()];
    let min = Infinity;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = laid.pos.get(ids[i]);
        const b = laid.pos.get(ids[j]);
        if (!a || !b) continue;
        min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    assert.ok(min > 50);
  });
});
