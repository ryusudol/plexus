import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parentFolder, segmentsFrom } from "../lib/extract.ts";

describe("parentFolder", () => {
  it("strips the last segment", () => {
    assert.equal(parentFolder("/repo/src/app.ts"), "/repo/src");
    assert.equal(parentFolder("/repo/src/"), "/repo");
  });

  it("returns slash for empty unix paths", () => {
    assert.equal(parentFolder(""), "/");
    assert.equal(parentFolder("file.ts"), "/");
  });
});

describe("segmentsFrom", () => {
  it("walks folders under the root", () => {
    const segs = segmentsFrom("/repo", "/repo/web/src/agents");
    assert.equal(segs.length, 3);
    assert.equal(segs[0].name, "web");
    assert.equal(segs[2].path, "/repo/web/src/agents");
  });

  it("ignores paths outside the root", () => {
    assert.deepEqual(segmentsFrom("/repo", "/other/x"), []);
    assert.deepEqual(segmentsFrom("/repo", "/repo"), []);
  });

  it("stops at glob segments", () => {
    const glob = segmentsFrom("/repo", "/repo/web/**/*.js");
    assert.equal(glob.length, 1);
    assert.equal(glob[0].name, "web");
  });
});
