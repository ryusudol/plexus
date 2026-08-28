import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractVisit,
  inferProvider,
  segmentsFrom,
  visitFromClaudeRecord,
  visitFromCodexRecord,
} from "../lib/extract.js";

describe("extractVisit", () => {
  it("maps read_file to the parent folder", () => {
    const visit = extractVisit({
      hookEventName: "pre_tool_use",
      sessionId: "abc",
      toolName: "read_file",
      toolInput: { target_file: "/Users/me/proj/src/app.ts" },
      workspaceRoot: "/Users/me/proj",
    });
    assert.equal(visit.folderPath, "/Users/me/proj/src");
    assert.equal(visit.filePath, "/Users/me/proj/src/app.ts");
    assert.equal(visit.agentId, "abc");
  });

  it("keeps list_dir on the directory itself", () => {
    const visit = extractVisit({
      toolName: "list_dir",
      toolInput: { target_directory: "/Users/me/proj/lib" },
    });
    assert.equal(visit.folderPath, "/Users/me/proj/lib");
    assert.equal(visit.filePath, null);
  });

  it("parses JSON string arguments from session replay", () => {
    const visit = extractVisit({
      name: "read_file",
      arguments: JSON.stringify({ target_file: "/repo/web/page.tsx" }),
    });
    assert.equal(visit.folderPath, "/repo/web");
  });

  it("resolves relative paths against workspaceRoot", () => {
    const visit = extractVisit({
      toolName: "read_file",
      toolInput: { target_file: "./src/main.js" },
      workspaceRoot: "/repo",
    });
    assert.equal(visit.folderPath, "/repo/src");
    assert.equal(visit.filePath, "/repo/src/main.js");
  });
});

describe("segmentsFrom", () => {
  it("walks from root to the folder", () => {
    const segs = segmentsFrom("/repo", "/repo/web/src/agents");
    assert.deepEqual(
      segs.map((s) => s.name),
      ["web", "src", "agents"],
    );
    assert.equal(segs.at(-1).path, "/repo/web/src/agents");
  });

  it("returns empty when the path is outside the root", () => {
    assert.deepEqual(segmentsFrom("/repo", "/other/x"), []);
  });

  it("stops before glob tokens so ** is not a folder", () => {
    const segs = segmentsFrom("/repo", "/repo/web/**/*.js");
    assert.deepEqual(
      segs.map((s) => s.name),
      ["web"],
    );
  });
});

describe("glob patterns", () => {
  it("does not turn **/*.js into a folder named **", () => {
    const visit = extractVisit({
      toolName: "grep",
      toolInput: { pattern: "foo", glob: "**/*.{js,css}" },
      workspaceRoot: "/Users/me/proj",
    });
    assert.equal(visit.folderPath, "/Users/me/proj");
  });

  it("keeps the real directory from an absolute glob", () => {
    const visit = extractVisit({
      toolName: "grep",
      toolInput: { path: "/Users/me/proj/src/**/*.ts" },
      workspaceRoot: "/Users/me/proj",
    });
    assert.equal(visit.folderPath, "/Users/me/proj/src");
  });

  it("prefers grep path over the glob filter", () => {
    const visit = extractVisit({
      toolName: "grep",
      toolInput: { pattern: "foo", path: "/Users/me/proj/lib", glob: "**/*.js" },
      workspaceRoot: "/Users/me/proj",
    });
    assert.equal(visit.folderPath, "/Users/me/proj/lib");
  });
});

describe("Claude and Codex visits", () => {
  it("maps Claude Read file_path to the parent folder", () => {
    const visit = extractVisit({
      hook_event_name: "PreToolUse",
      session_id: "uuid-1",
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/app.ts" },
      cwd: "/repo",
    });
    assert.equal(visit.folderPath, "/repo/src");
    assert.equal(inferProvider({ tool_name: "Read" }), "claude");
  });

  it("ignores Claude Bash", () => {
    assert.equal(
      extractVisit({
        tool_name: "Bash",
        tool_input: { command: "cd /repo/src && npm test" },
        cwd: "/repo",
      }),
      null,
    );
  });

  it("reads Claude assistant tool_use blocks", () => {
    const parsed = visitFromClaudeRecord(
      {
        type: "assistant",
        cwd: "/repo",
        sessionId: "uuid-1",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/lib/a.ts" } }],
        },
      },
      { session_id: "uuid-1", cwd: "/repo" },
    );
    assert.equal(parsed[0].visit.folderPath, "/repo/lib");
  });

  it("maps Codex apply_patch paths", () => {
    const parsed = visitFromCodexRecord(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          call_id: "c1",
          arguments: "*** Begin Patch\n*** Update File: /repo/web/app.js\n@@\n-a\n+b\n*** End Patch\n",
        },
      },
      { session_id: "s1", cwd: "/repo" },
    );
    assert.equal(parsed.visit.folderPath, "/repo/web");
    assert.equal(parsed.visit.filePath, "/repo/web/app.js");
  });

  it("ignores Codex local_shell_call", () => {
    assert.equal(
      visitFromCodexRecord({
        payload: { type: "local_shell_call", action: { command: ["ls", "/repo"] } },
      }),
      null,
    );
  });
});
