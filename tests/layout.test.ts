import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachChild,
  layoutTrail,
  parseTrailMode,
  type ShownChildren,
} from "../lib/layout.ts";

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
    assert.equal(parseTrailMode("nope"), "tree");
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
});
