import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeSlash,
  pathUnder,
  pathsOverlap,
  uniquePush,
  uniqueUnder,
} from "../lib/under.ts";

describe("pathUnder", () => {
  it("accepts the root and nested paths", () => {
    assert.equal(pathUnder("/repo", "/repo"), true);
    assert.equal(pathUnder("/repo", "/repo/src/app.ts"), true);
  });

  it("rejects sibling prefixes and empties", () => {
    assert.equal(pathUnder("/repo", "/repo-extra"), false);
    assert.equal(pathUnder("/repo", "/other"), false);
    assert.equal(pathUnder("", "/repo"), false);
    assert.equal(pathUnder("/repo", ""), false);
  });
});

describe("pathsOverlap / uniqueUnder", () => {
  it("overlaps nested paths", () => {
    assert.equal(pathsOverlap("/a", "/a/b"), true);
    assert.equal(pathsOverlap("/a", "/b"), false);
  });

  it("pushes unique items and filters outsiders", () => {
    const list: string[] = [];
    assert.equal(uniquePush(list, "/repo/a"), true);
    assert.equal(uniquePush(list, "/repo/a"), false);
    uniquePush(list, "/repo/b");
    assert.deepEqual(list, ["/repo/a", "/repo/b"]);
    assert.deepEqual(uniqueUnder("/repo", [["/repo/src", "/tmp/x", "/repo/src"], ["/repo/lib"]]), [
      "/repo/src",
      "/repo/lib",
    ]);
  });

  it("normalizes slashes", () => {
    assert.equal(normalizeSlash(String.raw`C:\a\b`), "C:/a/b");
  });
});
