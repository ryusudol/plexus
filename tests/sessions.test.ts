import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { extractVisit, visitFromAcpRecord } from "../lib/extract.ts";
import { readClaudeSessions } from "../server/claude.ts";
import { readCodexSessions } from "../server/codex.ts";
import {
  encodeCwd,
  isUserPromptEvent,
  parseAcpLine,
  parseSessionEvent,
  pickFocusedSession,
  readActiveSessions,
  readOrcaActiveCwd,
  readOrcaFocus,
  readOrcaLivePanes,
  replaySession,
  rosterFingerprint,
  SessionHub,
} from "../server/sessions.ts";

describe("ACP visit parsing", () => {
  it("reads list_dir as the directory itself", () => {
    const parsed = visitFromAcpRecord(
      {
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "c1",
            title: "list_dir",
            rawInput: { target_directory: "/repo/lib" },
            _meta: { "x.ai/tool": { name: "list_dir" } },
          },
        },
      },
      { session_id: "s1", cwd: "/repo" },
    );
    assert.ok(parsed);
    assert.equal(parsed.visit.folderPath, "/repo/lib");
    assert.equal(parsed.visit.filePath, null);
  });

  it("maps grep on a file to the parent folder", () => {
    const parsed = parseAcpLine(
      JSON.stringify({
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "c2",
            title: "grep",
            rawInput: { pattern: "foo", path: "/repo/web/app.js" },
            _meta: { "x.ai/tool": { name: "grep" } },
          },
        },
      }),
      { session_id: "s1", cwd: "/repo" },
    );
    assert.ok(parsed);
    assert.equal(parsed.visit.folderPath, "/repo/web");
    assert.equal(parsed.visit.filePath, "/repo/web/app.js");
  });

  it("uses locations[] when rawInput is missing", () => {
    const parsed = visitFromAcpRecord({
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c3",
          locations: [{ path: "/repo/src/main.ts" }],
          _meta: { "x.ai/tool": { name: "read_file" } },
        },
      },
    });
    assert.ok(parsed);
    assert.equal(parsed.visit.folderPath, "/repo/src");
  });

  it("ignores shell commands even when the command contains slashes", () => {
    const parsed = visitFromAcpRecord({
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c5",
          rawInput: { command: "cd /Users/me/proj && npm test" },
          _meta: { "x.ai/tool": { name: "run_terminal_command" } },
        },
      },
    });
    assert.equal(parsed, null);
  });

  it("ignores shell commands with no path", () => {
    const parsed = visitFromAcpRecord({
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c4",
          rawInput: { command: "ls" },
          _meta: { "x.ai/tool": { name: "run_terminal_command" } },
        },
      },
    });
    assert.equal(parsed, null);
  });
});

describe("parseSessionEvent", () => {
  it("marks a prompt and a tool call as busy", () => {
    assert.equal(
      parseSessionEvent(
        JSON.stringify({ params: { update: { sessionUpdate: "user_message_chunk" } } }),
      ),
      "busy",
    );
    assert.equal(
      parseSessionEvent(JSON.stringify({ params: { update: { sessionUpdate: "tool_call" } } })),
      "busy",
    );
  });

  it("marks turn_completed as idle", () => {
    assert.equal(
      parseSessionEvent(
        JSON.stringify({ params: { update: { sessionUpdate: "turn_completed" } } }),
      ),
      "idle",
    );
  });
});

describe("isUserPromptEvent", () => {
  it("treats a user message as a new prompt", () => {
    assert.equal(
      isUserPromptEvent(
        JSON.stringify({ params: { update: { sessionUpdate: "user_message_chunk" } } }),
      ),
      true,
    );
    assert.equal(
      isUserPromptEvent(
        JSON.stringify({ params: { update: { event_name: "user_prompt_submit" } } }),
      ),
      true,
    );
  });

  it("does not treat tool calls as a new prompt", () => {
    assert.equal(
      isUserPromptEvent(JSON.stringify({ params: { update: { sessionUpdate: "tool_call" } } })),
      false,
    );
  });
});

describe("readActiveSessions", () => {
  it("lists sessions from a fake GROK_HOME", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-"));
    const cwd = "/Users/me/proj";
    const id = "01aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const dir = path.join(home, "sessions", encodeCwd(cwd), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(home, "active_sessions.json"),
      JSON.stringify([{ session_id: id, pid: process.pid, cwd, opened_at: "2026-01-01T00:00:00Z" }]),
    );
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({ generated_title: "Fix login", agent_name: "grok-build" }),
    );
    fs.writeFileSync(
      path.join(dir, "updates.jsonl"),
      `${JSON.stringify({
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            rawInput: { target_file: "/Users/me/proj/src/a.ts" },
            _meta: { "x.ai/tool": { name: "read_file" } },
          },
        },
      })}\n`,
    );
    const roster = readActiveSessions(home);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].title, "Fix login");
    const visits = replaySession(roster[0], home);
    assert.ok(visits[0]);
    assert.equal(visits[0].folderPath, "/Users/me/proj/src");
  });

  it("keeps a live CLI session alongside an open Orca pane", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-"));
    const orcaId = "01bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const cliId = "01ffffffffffffffffffffffffff";
    const cwd = "/Users/me/proj";
    const cliCwd = "/Users/me/other";
    const rows = [
      { session_id: orcaId, pid: process.pid, cwd, opened_at: "2026-01-01T00:00:00Z" },
      { session_id: cliId, pid: process.pid, cwd: cliCwd, opened_at: "2026-01-01T00:00:00Z" },
    ];
    fs.writeFileSync(path.join(home, "active_sessions.json"), JSON.stringify(rows));
    for (const row of rows) {
      const dir = path.join(home, "sessions", encodeCwd(row.cwd), row.session_id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: row.session_id }));
      fs.writeFileSync(path.join(dir, "updates.jsonl"), "{}\n");
    }
    const orca = path.join(home, "orca-data.json");
    fs.writeFileSync(
      orca,
      JSON.stringify({
        workspaceSession: {
          tabsByWorktree: {
            "abc::/Users/me/proj": [{ id: "tab-live" }],
          },
          sleepingAgentSessionsByPaneKey: {
            "tab-live:leaf-1": {
              tabId: "tab-live",
              worktreeId: "abc::/Users/me/proj",
              providerSession: { key: "session_id", id: orcaId },
            },
          },
        },
      }),
    );
    const roster = readActiveSessions(home, readOrcaLivePanes(orca));
    assert.equal(roster.length, 2);
    assert.ok(roster.some((row) => row.session_id === orcaId));
    assert.ok(roster.some((row) => row.session_id === cliId));
  });

  it("drops leftover sessions that are not attached to an open Orca pane", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-"));
    const liveId = "01bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const staleId = "01cccccccccccccccccccccccccc";
    const cwd = "/Users/me/proj";
    const rows = [
      { session_id: liveId, pid: process.pid, cwd, opened_at: "2026-01-01T00:00:00Z" },
      { session_id: staleId, pid: 0, cwd, opened_at: "2026-01-01T00:00:00Z" },
    ];
    fs.writeFileSync(path.join(home, "active_sessions.json"), JSON.stringify(rows));
    for (const row of rows) {
      const dir = path.join(home, "sessions", encodeCwd(row.cwd), row.session_id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: row.session_id }));
      const updates = path.join(dir, "updates.jsonl");
      fs.writeFileSync(updates, "{}\n");
      if (row.session_id === staleId) {
        const old = new Date(Date.now() - 20 * 60 * 1000);
        fs.utimesSync(updates, old, old);
      }
    }
    const orca = path.join(home, "orca-data.json");
    fs.writeFileSync(
      orca,
      JSON.stringify({
        workspaceSession: {
          tabsByWorktree: {
            "abc::/Users/me/proj": [{ id: "tab-live" }],
          },
          sleepingAgentSessionsByPaneKey: {
            "tab-live:leaf-1": {
              tabId: "tab-live",
              worktreeId: "abc::/Users/me/proj",
              providerSession: { key: "session_id", id: liveId },
            },
          },
        },
      }),
    );
    const roster = readActiveSessions(home, readOrcaLivePanes(orca));
    assert.equal(roster.length, 1);
    assert.equal(roster[0].session_id, liveId);
  });

  it("includes a running Orca session missing from active_sessions.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-"));
    const liveId = "01dddddddddddddddddddddddddd";
    const cwd = "/Users/me/other";
    const dir = path.join(home, "sessions", encodeCwd(cwd), liveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: "Live tab" }));
    fs.writeFileSync(path.join(home, "active_sessions.json"), JSON.stringify([]));
    const orca = path.join(home, "orca-data.json");
    fs.writeFileSync(
      orca,
      JSON.stringify({
        workspaceSession: {
          tabsByWorktree: {
            "abc::/Users/me/other": [{ id: "tab-2" }],
          },
          sleepingAgentSessionsByPaneKey: {
            "tab-2:leaf-2": {
              tabId: "tab-2",
              worktreeId: "abc::/Users/me/other",
              providerSession: { key: "session_id", id: liveId },
            },
          },
        },
      }),
    );
    const roster = readActiveSessions(home, readOrcaLivePanes(orca));
    assert.equal(roster.length, 1);
    assert.equal(roster[0].session_id, liveId);
    assert.equal(roster[0].title, "Live tab");
  });

  it("ignores a pane whose tab is already closed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-"));
    const closedId = "01eeeeeeeeeeeeeeeeeeeeeeeeee";
    const cwd = "/Users/me/proj";
    fs.writeFileSync(
      path.join(home, "active_sessions.json"),
      JSON.stringify([{ session_id: closedId, pid: 0, cwd, opened_at: "2026-01-01T00:00:00Z" }]),
    );
    const dir = path.join(home, "sessions", encodeCwd(cwd), closedId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: "Closed" }));
    const updates = path.join(dir, "updates.jsonl");
    fs.writeFileSync(updates, "{}\n");
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(updates, old, old);
    const orca = path.join(home, "orca-data.json");
    fs.writeFileSync(
      orca,
      JSON.stringify({
        workspaceSession: {
          tabsByWorktree: {
            "abc::/Users/me/proj": [{ id: "tab-open" }],
          },
          sleepingAgentSessionsByPaneKey: {
            "tab-closed:leaf-1": {
              tabId: "tab-closed",
              worktreeId: "abc::/Users/me/proj",
              providerSession: { key: "session_id", id: closedId },
            },
          },
        },
      }),
    );
    const roster = readActiveSessions(home, readOrcaLivePanes(orca));
    assert.equal(roster.length, 0);
  });
});

describe("focused Orca session", () => {
  it("reads the active worktree path from orca-data.json", () => {
    const file = path.join(os.tmpdir(), `orca-data-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        workspaceSession: {
          activeWorktreeId: "abc::/Users/me/proj",
        },
      }),
    );
    assert.equal(readOrcaActiveCwd(file), "/Users/me/proj");
    fs.unlinkSync(file);
  });

  it("reads the focused Grok session id from the active Orca pane", () => {
    const file = path.join(os.tmpdir(), `orca-focus-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        workspaceSession: {
          activeWorktreeId: "abc::/Users/me/proj",
          activeTabId: "tab-1",
          terminalLayoutsByTabId: {
            "tab-1": { activeLeafId: "leaf-1" },
          },
          sleepingAgentSessionsByPaneKey: {
            "tab-1:leaf-1": {
              tabId: "tab-1",
              providerSession: { key: "session_id", id: "sess-now" },
            },
          },
        },
      }),
    );
    assert.deepEqual(readOrcaFocus(file), { cwd: "/Users/me/proj", sessionId: "sess-now" });
    fs.unlinkSync(file);
  });

  it("picks the live session whose cwd matches the focused worktree", () => {
    const roster = [
      { session_id: "old", cwd: "/Users/me/proj", live: false, mtime: 9 },
      { session_id: "now", cwd: "/Users/me/proj", live: true, mtime: 3 },
      { session_id: "other", cwd: "/Users/me/other", live: true, mtime: 99 },
    ];
    assert.equal(pickFocusedSession(roster, "/Users/me/proj")?.session_id, "now");
  });

  it("prefers the Orca pane session id over a cwd match", () => {
    const roster = [
      { session_id: "older", cwd: "/Users/me/proj", live: true, mtime: 9 },
      { session_id: "now", cwd: "/Users/me/proj", live: true, mtime: 3 },
    ];
    assert.equal(
      pickFocusedSession(roster, { cwd: "/Users/me/proj", sessionId: "now" })?.session_id,
      "now",
    );
  });

  it("stays on the selected session when follow is project", () => {
    const hub = new SessionHub({ emit: () => {} });
    hub.followMode = "project";
    hub.selectedId = "keep";
    hub.roster = [
      { session_id: "keep", cwd: "/a", live: true, mtime: 1 },
      { session_id: "other", cwd: "/b", live: true, mtime: 9 },
    ];
    assert.equal(hub.followFocus("/b"), false);
    assert.equal(hub.selectedId, "keep");
  });

  it("keeps a picker selection while the focused session stays the same", () => {
    const hub = new SessionHub({ emit: () => {} });
    hub.followMode = "focus";
    hub.selectedId = "picked";
    hub.lastFocusedId = "keep";
    hub.roster = [
      { session_id: "keep", cwd: "/a", live: true, mtime: 1 },
      { session_id: "picked", cwd: "/b", live: true, mtime: 9 },
    ];
    assert.equal(hub.followFocus("/a"), false);
    assert.equal(hub.selectedId, "picked");
  });

  it("follows when the user moves to another session", () => {
    const hub = new SessionHub({ emit: () => {} });
    hub.followMode = "focus";
    hub.selectedId = "keep";
    hub.lastFocusedId = "keep";
    hub.roster = [
      { session_id: "keep", cwd: "/a", live: true, mtime: 1 },
      { session_id: "other", cwd: "/b", live: true, mtime: 9 },
    ];
    assert.equal(hub.followFocus("/b"), true);
    assert.equal(hub.selectedId, "other");
    assert.equal(hub.lastFocusedId, "other");
  });

  it("follows the focused session when the current selection is gone", () => {
    const hub = new SessionHub({ emit: () => {} });
    hub.followMode = "focus";
    hub.selectedId = "gone";
    hub.roster = [
      { session_id: "keep", cwd: "/a", live: true, mtime: 1 },
      { session_id: "other", cwd: "/b", live: true, mtime: 9 },
    ];
    assert.equal(hub.followFocus("/b"), true);
    assert.equal(hub.selectedId, "other");
  });

  it("switches to another session when that session gets a prompt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-"));
    const rows = [
      { session_id: "keep", pid: process.pid, cwd: "/a", opened_at: "2026-01-01T00:00:00Z" },
      { session_id: "other", pid: process.pid, cwd: "/b", opened_at: "2026-01-01T00:00:00Z" },
    ];
    fs.writeFileSync(path.join(home, "active_sessions.json"), JSON.stringify(rows));
    for (const row of rows) {
      const dir = path.join(home, "sessions", encodeCwd(row.cwd), row.session_id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: row.session_id }));
    }
    const events: Array<{ type?: string; sessionId?: string | null }> = [];
    const hub = new SessionHub({ home, emit: (event) => events.push(event) });
    hub.followMode = "focus";
    hub.selectedId = "keep";
    hub.scanRoster();
    assert.equal(hub.followPrompt({ session_id: "other", cwd: "/b" }), true);
    assert.equal(hub.selectedId, "other");
    assert.equal(events.some((event) => event.type === "snapshot" && event.sessionId === "other"), true);
  });

  it("does not follow a prompt in project mode", () => {
    const hub = new SessionHub({ emit: () => {} });
    hub.followMode = "project";
    hub.selectedId = "keep";
    hub.roster = [
      { session_id: "keep", cwd: "/a", live: true, mtime: 1 },
      { session_id: "other", cwd: "/b", live: true, mtime: 9 },
    ];
    assert.equal(hub.followPrompt({ session_id: "other", cwd: "/b" }), false);
    assert.equal(hub.selectedId, "keep");
  });

  it("fingerprints roster so a new session is a change", () => {
    const a = [{ session_id: "a", pid: 1, cwd: "/x", title: "A", live: true }];
    const b = [
      { session_id: "a", pid: 1, cwd: "/x", title: "A", live: true },
      { session_id: "b", pid: 2, cwd: "/y", title: "B", live: true },
    ];
    assert.notEqual(rosterFingerprint(a), rosterFingerprint(b));
  });
});

describe("visit trail snapshot", () => {
  it("keeps the full unique visit trail, not only the last 40 folders", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-trail-"));
    const cwd = "/Users/me/proj";
    const id = "01ffffffffffffffffffffffffff";
    const dir = path.join(home, "sessions", encodeCwd(cwd), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(home, "active_sessions.json"),
      JSON.stringify([{ session_id: id, pid: process.pid, cwd, opened_at: "2026-01-01T00:00:00Z" }]),
    );
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: "Trail", agent_name: "grok-build" }));
    const lines = [];
    for (let i = 0; i < 55; i += 1) {
      lines.push(
        JSON.stringify({
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `t${i}`,
              rawInput: { target_file: `${cwd}/pkg${i}/src/a.ts` },
              _meta: { "x.ai/tool": { name: "read_file" } },
            },
          },
        }),
      );
    }
    fs.writeFileSync(path.join(dir, "updates.jsonl"), `${lines.join("\n")}\n`);
    const hub = new SessionHub({ home, emit: () => {} });
    hub.scanRoster();
    hub.syncTails();
    const snap = hub.snapshot();
    assert.equal(snap.visited.length, 55);
    assert.equal(snap.visited[0], `${cwd}/pkg0/src`);
    assert.equal(snap.visited[54], `${cwd}/pkg54/src`);
    assert.equal(snap.files.length, 55);
    assert.equal(snap.files[0], `${cwd}/pkg0/src/a.ts`);
    assert.equal(snap.files[54], `${cwd}/pkg54/src/a.ts`);
    assert.equal(snap.agents[0].filePath, `${cwd}/pkg54/src/a.ts`);
    hub.stop();
  });

  it("keeps unique visited files and parks on the last file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-files-"));
    const cwd = "/Users/me/proj";
    const id = "01eeeeeeeeeeeeeeeeeeeeeeeeee";
    const dir = path.join(home, "sessions", encodeCwd(cwd), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(home, "active_sessions.json"),
      JSON.stringify([{ session_id: id, pid: process.pid, cwd, opened_at: "2026-01-01T00:00:00Z" }]),
    );
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: "Files", agent_name: "grok-build" }));
    const tool = (toolCallId: string, rawInput: Record<string, string>, name: string) =>
      JSON.stringify({
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            rawInput,
            _meta: { "x.ai/tool": { name } },
          },
        },
      });
    fs.writeFileSync(
      path.join(dir, "updates.jsonl"),
      [
        tool("d1", { target_directory: `${cwd}/src` }, "list_dir"),
        tool("f1", { target_file: `${cwd}/src/a.ts` }, "read_file"),
        tool("f2", { target_file: `${cwd}/src/b.ts` }, "read_file"),
        tool("f3", { target_file: `${cwd}/src/a.ts` }, "read_file"),
        tool("d2", { target_directory: `${cwd}/lib` }, "list_dir"),
      ].join("\n") + "\n",
    );
    const hub = new SessionHub({ home, emit: () => {} });
    hub.scanRoster();
    hub.syncTails();
    const snap = hub.snapshot();
    assert.deepEqual(snap.visited, [`${cwd}/src`, `${cwd}/lib`]);
    assert.deepEqual(snap.files, [`${cwd}/src/a.ts`, `${cwd}/src/b.ts`]);
    assert.equal(snap.agents[0].filePath, null);
    assert.equal(snap.agents[0].folderPath, `${cwd}/lib`);
    hub.stop();
  });

  it("parks the agent on a file when the last visit is a file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-lastfile-"));
    const cwd = "/Users/me/proj";
    const id = "01dddddddddddddddddddddddddd";
    const dir = path.join(home, "sessions", encodeCwd(cwd), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(home, "active_sessions.json"),
      JSON.stringify([{ session_id: id, pid: process.pid, cwd, opened_at: "2026-01-01T00:00:00Z" }]),
    );
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ generated_title: "Last", agent_name: "grok-build" }));
    fs.writeFileSync(
      path.join(dir, "updates.jsonl"),
      `${JSON.stringify({
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "f1",
            rawInput: { target_file: `${cwd}/src/app.ts` },
            _meta: { "x.ai/tool": { name: "read_file" } },
          },
        },
      })}\n`,
    );
    const hub = new SessionHub({ home, emit: () => {} });
    hub.scanRoster();
    hub.syncTails();
    const snap = hub.snapshot();
    assert.deepEqual(snap.files, [`${cwd}/src/app.ts`]);
    assert.equal(snap.agents[0].filePath, `${cwd}/src/app.ts`);
    assert.equal(snap.agents[0].folderPath, `${cwd}/src`);
    hub.stop();
  });
});

describe("extractVisit grep heuristic", () => {
  it("keeps a directory grep on that directory", () => {
    const visit = extractVisit({
      toolName: "grep",
      toolInput: { path: "/repo/src", pattern: "TODO" },
    });
    assert.ok(visit);
    assert.ok(visit);
    assert.equal(visit.folderPath, "/repo/src");
  });
});

describe("Claude and Codex session lists", () => {
  it("lists a recent Claude Code transcript", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-claude-"));
    const cwd = "/Users/me/proj";
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const dir = path.join(home, "projects", "-Users-me-proj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({
        type: "user",
        cwd,
        message: { content: "fix login" },
      })}\n${JSON.stringify({
        type: "assistant",
        cwd,
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${cwd}/src/a.ts` } }],
        },
      })}\n`,
    );
    const roster = readClaudeSessions(home);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].session_id, `claude:${id}`);
    assert.equal(roster[0].cwd, cwd);
    assert.equal(roster[0].provider, "claude");
  });

  it("lists a recent Codex rollout", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-codex-"));
    const cwd = "/Users/me/proj";
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const dir = path.join(home, "sessions", "2026", "08", "25");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-08-25T10-00-00-${id}.jsonl`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { cwd, id } })}\n`,
    );
    const now = Date.parse("2026-08-25T12:00:00Z");
    fs.utimesSync(file, new Date(now), new Date(now));
    const roster = readCodexSessions(home, now);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].session_id, `codex:${id}`);
    assert.equal(roster[0].cwd, cwd);
  });

  it("registers a Claude hook as a live session", () => {
    const events = [];
    const hub = new SessionHub({ emit: (event) => events.push(event) });
    hub.noteHook({
      provider: "claude",
      session_id: "uuid-1",
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/a.ts" },
      pid: 4242,
    });
    hub.scanRoster();
    const row = hub.roster.find((item) => item.session_id === "claude:uuid-1");
    assert.ok(row);
    assert.equal(row.pid, 4242);
  });
});
