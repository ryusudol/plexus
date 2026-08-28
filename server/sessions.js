import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferProvider, visitFromAcpRecord } from "../lib/extract.js";
import { parseClaudeLine, readClaudeSessions } from "./claude.js";
import { parseCodexLine, readCodexSessions } from "./codex.js";
import { listAgentPids } from "./procs.js";

export function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

export function encodeCwd(cwd) {
  return encodeURIComponent(cwd);
}

export function sessionDir(cwd, sessionId, home = grokHome()) {
  const direct = path.join(home, "sessions", encodeCwd(cwd), sessionId);
  if (fs.existsSync(direct)) return direct;
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return direct;
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return direct;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const candidate = path.join(root, group.name, sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return direct;
}

export function updatesPath(session, home = grokHome()) {
  if (session?.updates) return session.updates;
  const id = session.nativeId || session.session_id;
  return path.join(sessionDir(session.cwd, id, home), "updates.jsonl");
}

export function readSummary(session, home = grokHome()) {
  const file = path.join(sessionDir(session.cwd, session.session_id, home), "summary.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findSessionCwd(sessionId, home = grokHome()) {
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return null;
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    if (!fs.existsSync(path.join(root, group.name, sessionId))) continue;
    try {
      return decodeURIComponent(group.name);
    } catch {
      return group.name;
    }
  }
  return null;
}

function rosterEntry(row, home, { live = false } = {}) {
  const summary = readSummary(row, home);
  const updates = updatesPath(row, home);
  let mtime = 0;
  try {
    mtime = fs.statSync(updates).mtimeMs;
  } catch {
    mtime = 0;
  }
  return {
    session_id: row.session_id,
    pid: row.pid || 0,
    cwd: row.cwd,
    opened_at: row.opened_at,
    title: summary?.generated_title || path.basename(row.cwd),
    agent: summary?.agent_name || "agent",
    provider: row.provider || "grok",
    updates: updates,
    mtime,
    live,
  };
}

function readActiveSessionRows(home) {
  const file = path.join(home, "active_sessions.json");
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(rows) ? rows.filter((row) => row?.session_id && row.cwd) : [];
}

/**
 * Grok sessions currently attached to an open Orca tab.
 * Returns null when Orca state is missing so callers can fall back.
 */
export function readOrcaLivePanes(file) {
  const files = file ? [file] : orcaDataFiles();
  if (!files.length) return null;
  const panes = new Map();
  let saw = false;
  for (const item of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(item, "utf8"));
      const ws = obj?.workspaceSession || {};
      saw = true;
      const openTabs = new Set();
      for (const tabs of Object.values(ws.tabsByWorktree || {})) {
        if (!Array.isArray(tabs)) continue;
        for (const tab of tabs) {
          if (tab?.id) openTabs.add(tab.id);
        }
      }
      for (const pane of Object.values(ws.sleepingAgentSessionsByPaneKey || {})) {
        const id = pane?.providerSession?.id;
        if (typeof id !== "string" || !id) continue;
        if (pane?.tabId && openTabs.size && !openTabs.has(pane.tabId)) continue;
        const cwd = cwdFromWorktreeId(pane?.worktreeId);
        const prev = panes.get(id);
        if (!prev || (cwd && !prev.cwd)) panes.set(id, { sessionId: id, cwd, tabId: pane?.tabId || null });
      }
    } catch {
      // skip unreadable profiles
    }
  }
  return saw ? panes : null;
}

export function readActiveSessions(home = grokHome(), panes) {
  const rows = readActiveSessionRows(home);
  const byId = new Map();
  for (const row of rows) {
    const hostLive = pidAlive(row.pid);
    let mtime = 0;
    try {
      mtime = fs.statSync(updatesPath(row, home)).mtimeMs;
    } catch {
      mtime = 0;
    }
    const recent = Date.now() - mtime < 15 * 60 * 1000;
    byId.set(row.session_id, rosterEntry(row, home, { live: hostLive || recent }));
  }

  const livePanes = panes === undefined && home === grokHome() ? readOrcaLivePanes() : panes;
  const out = [];
  const seen = new Set();
  if (livePanes) {
    for (const [id, pane] of livePanes) {
      const existing = byId.get(id);
      if (existing) {
        existing.live = true;
        out.push(existing);
        seen.add(id);
        continue;
      }
      const cwd = pane?.cwd || findSessionCwd(id, home);
      if (!cwd) continue;
      out.push(rosterEntry({ session_id: id, cwd, pid: 0, provider: "grok" }, home, { live: true }));
      seen.add(id);
    }
  }
  for (const session of byId.values()) {
    if (seen.has(session.session_id)) continue;
    if (!session.live) continue;
    out.push(session);
    seen.add(session.session_id);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function readAllSessions(home = grokHome()) {
  const grok = readActiveSessions(home);
  const others = [...readClaudeSessions(), ...readCodexSessions()];
  const byId = new Map();
  for (const row of [...grok, ...others]) {
    const prev = byId.get(row.session_id);
    if (!prev || row.mtime >= prev.mtime) byId.set(row.session_id, row);
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime);
}

export function rosterFingerprint(roster) {
  return (roster || [])
    .map((s) => `${s.session_id}:${s.pid || 0}:${s.cwd}:${s.title}:${s.live ? 1 : 0}`)
    .join("|");
}

export function orcaDataFiles() {
  if (process.env.ORCA_DATA_FILE) return [process.env.ORCA_DATA_FILE];
  const root = path.join(os.homedir(), "Library/Application Support/orca/profiles");
  const files = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const candidate = path.join(root, name, "orca-data.json");
      if (fs.existsSync(candidate)) files.push(candidate);
    }
  } catch {
    // none
  }
  return files;
}

function cwdFromWorktreeId(key) {
  if (typeof key !== "string") return null;
  const idx = key.indexOf("::");
  if (idx < 0) return null;
  return key.slice(idx + 2) || null;
}

function sessionIdFromOrcaWorkspace(ws = {}) {
  const worktreeId = ws.activeWorktreeId || "";
  const tabId =
    ws.activeTabId ||
    (worktreeId && ws.activeTabIdByWorktree && ws.activeTabIdByWorktree[worktreeId]) ||
    null;
  if (!tabId) return null;
  const panes = ws.sleepingAgentSessionsByPaneKey || {};
  const layout = (ws.terminalLayoutsByTabId || {})[tabId] || {};
  const leafId = layout.activeLeafId;
  if (leafId) {
    const pane = panes[`${tabId}:${leafId}`];
    const id = pane?.providerSession?.id;
    if (typeof id === "string" && id) return id;
  }
  for (const pane of Object.values(panes)) {
    if (pane?.tabId === tabId && typeof pane?.providerSession?.id === "string") {
      return pane.providerSession.id;
    }
  }
  return null;
}

export function readOrcaFocus(file) {
  const files = file ? [file] : orcaDataFiles();
  let best = null;
  let bestM = 0;
  for (const item of files) {
    try {
      const m = fs.statSync(item).mtimeMs;
      const obj = JSON.parse(fs.readFileSync(item, "utf8"));
      const ws = obj?.workspaceSession || {};
      const worktreeId = ws.activeWorktreeId || obj?.ui?.lastActiveWorktreeId || "";
      const cwd = cwdFromWorktreeId(worktreeId);
      const sessionId = sessionIdFromOrcaWorkspace(ws);
      if ((cwd || sessionId) && m >= bestM) {
        best = { cwd, sessionId };
        bestM = m;
      }
    } catch {
      // skip
    }
  }
  return best;
}

export function readOrcaActiveCwd(file) {
  return readOrcaFocus(file)?.cwd || null;
}

function focusHint(hint) {
  if (hint && typeof hint === "object") return hint;
  if (typeof hint === "string" && hint) return { cwd: hint };
  return readOrcaFocus() || {};
}

export function pickFocusedSession(roster, hint = readOrcaFocus()) {
  if (!roster?.length) return null;
  const focus = focusHint(hint);
  if (focus.sessionId) {
    const byId = roster.find((s) => s.session_id === focus.sessionId);
    if (byId) return byId;
  }
  const cwd = focus.cwd;
  if (cwd) {
    const exact = roster.filter((s) => s.cwd === cwd);
    const nested = roster.filter((s) => s.cwd === cwd || String(s.cwd).startsWith(`${cwd}/`));
    const pool = exact.length ? exact : nested;
    if (pool.length) {
      return pool.slice().sort((a, b) => Number(b.live) - Number(a.live) || b.mtime - a.mtime)[0];
    }
  }
  return null;
}

export function parseAcpLine(line, session) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  return visitFromAcpRecord(record, session);
}

function sessionUpdateOf(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  return record?.params?.update || record?.update || null;
}

export function isUserPromptEvent(line) {
  const update = sessionUpdateOf(line);
  if (!update) return false;
  const kind = update.sessionUpdate;
  const hook = update.event_name;
  return (
    kind === "user_message_chunk" ||
    kind === "user_message" ||
    hook === "user_prompt_submit"
  );
}

export function parseSessionEvent(line) {
  const update = sessionUpdateOf(line);
  if (!update) return null;
  const kind = update.sessionUpdate;
  const hook = update.event_name;
  if (
    kind === "tool_call" ||
    kind === "user_message_chunk" ||
    kind === "user_message" ||
    kind === "agent_thought_chunk" ||
    hook === "user_prompt_submit" ||
    hook === "pre_tool_use"
  ) {
    return "busy";
  }
  if (
    kind === "turn_completed" ||
    hook === "stop" ||
    hook === "Stop" ||
    hook === "stop_cancelled" ||
    hook === "StopCancelled"
  ) {
    return "idle";
  }
  return null;
}

class FileTail {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.buf = "";
    this.watcher = null;
  }

  replay() {
    this.offset = 0;
    this.buf = "";
    this.readNew();
  }

  readNew() {
    let st;
    try {
      st = fs.statSync(this.filePath);
    } catch {
      return;
    }
    if (st.size < this.offset) {
      this.offset = 0;
      this.buf = "";
    }
    if (st.size === this.offset) return;
    const length = st.size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(this.filePath, "r");
    fs.readSync(fd, buffer, 0, length, this.offset);
    fs.closeSync(fd);
    this.offset = st.size;
    this.buf += buffer.toString("utf8");
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim()) this.onLine(line);
    }
  }

  start() {
    this.stop();
    try {
      this.watcher = fs.watch(this.filePath, () => this.readNew());
    } catch {
      this.watcher = null;
    }
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
  }
}

export class SessionHub {
  constructor({ home = grokHome(), emit } = {}) {
    this.home = home;
    this.emit = emit || (() => {});
    this.selectedId = null;
    this.tails = new Map();
    this.seen = new Map();
    this.visits = new Map();
    this.lastFolder = new Map();
    this.busy = new Map();
    this.roster = [];
    this.rosterWatcher = null;
    this.orcaWatchers = [];
    this.poll = null;
    this.refreshTimer = null;
    this.fingerprint = "";
    this.followMode = "focus";
    this.lastFocusedId = null;
    this.hooked = new Map();
  }

  snapshot() {
    this.scanRoster();
    const roster = this.roster;
    if (!roster.length) {
      return {
        sessions: [],
        sessionId: null,
        sessionTitle: null,
        root: null,
        agents: [],
        visited: [],
        busy: false,
        pids: [],
      };
    }
    if (!this.selectedId || !roster.some((s) => s.session_id === this.selectedId)) {
      this.selectedId = roster[0].session_id;
    }
    const selected = roster.find((s) => s.session_id === this.selectedId) || roster[0];
    const peers = roster.filter((s) => s.cwd === selected.cwd);
    const visited = [];
    const seenFolders = new Set();
    const underRoot = (folder) =>
      folder === selected.cwd || String(folder).startsWith(`${selected.cwd}/`);
    for (const session of peers) {
      const list = this.visits.get(session.session_id) || [];
      for (const folder of list) {
        if (!underRoot(folder) || seenFolders.has(folder)) continue;
        seenFolders.add(folder);
        visited.push(folder);
      }
    }
    const last = this.lastFolder.get(selected.session_id);
    const folderPath = last && underRoot(last) ? last : selected.cwd;
    const agents = [
      {
        id: selected.session_id,
        label: selected.agent === "grok-build-plan" ? "plan" : selected.agent || "agent",
        title: selected.title,
        folderPath,
      },
    ];
    return {
      sessions: roster.map((s) => ({
        id: s.session_id,
        title: s.title,
        cwd: s.cwd,
        live: s.live,
        provider: s.provider || "grok",
        selected: s.session_id === selected.session_id,
      })),
      sessionId: selected.session_id,
      sessionTitle: selected.title,
      root: selected.cwd,
      agents,
      visited: visited.slice(-40),
      busy: peers.some((s) => this.busy.get(s.session_id)),
      pids: [...new Set([...roster.map((s) => s.pid).filter(Boolean), ...listAgentPids()])],
      followMode: this.followMode === "project" ? "project" : "focus",
    };
  }

  select(sessionId) {
    this.selectedId = sessionId;
    this.syncTails();
    this.emit({ type: "snapshot", ...this.snapshot() });
    this.emitActivity();
  }

  sessionStillLive(id = this.selectedId) {
    return Boolean(id && this.roster.some((s) => s.session_id === id));
  }

  /**
   * Jump to a session that just received a user prompt.
   * Picker / project follow stay put until that happens.
   */
  noteHook(event) {
    const provider = inferProvider(event);
    const native = event.session_id || event.sessionId;
    if (!native) return;
    const id = provider === "grok" ? native : `${provider}:${native}`;
    const cwd = event.cwd || event.workspace_root || event.workspaceRoot;
    const updates = event.transcript_path || event.transcriptPath || "";
    const prev = this.hooked.get(id) || {};
    if (cwd) {
      this.hooked.set(id, {
        session_id: id,
        nativeId: native,
        pid: Number(event.pid) || prev.pid || 0,
        cwd,
        title: prev.title || path.basename(cwd),
        agent: provider === "grok" ? prev.agent || "agent" : provider,
        provider,
        updates: updates || prev.updates,
        mtime: Date.now(),
        live: true,
      });
    }
    const hook = event.hook_event_name || event.hookEventName || event.type || "";
    if (/UserPromptSubmit|user_prompt_submit|user_message/i.test(hook)) {
      this.busy.set(id, true);
      const row = this.hooked.get(id) || this.roster.find((s) => s.session_id === id);
      if (row) this.followPrompt(row);
    } else if (/PreToolUse|pre_tool_use|tool_call/i.test(hook)) {
      this.busy.set(id, true);
    } else if (/^(Stop|StopFailure|stop)/i.test(String(hook))) {
      this.busy.set(id, false);
    }
  }

  followPrompt(session) {
    if (this.followMode === "project") return false;
    const id = session?.session_id;
    if (!id || id === this.selectedId) return false;
    this.selectedId = id;
    this.emit({ type: "snapshot", ...this.snapshot() });
    this.emitActivity();
    return true;
  }

  start() {
    this.refresh({ force: true });
    try {
      this.rosterWatcher = fs.watch(path.join(this.home, "active_sessions.json"), () => {
        this.scheduleRefresh();
      });
    } catch {
      this.rosterWatcher = null;
    }
    for (const file of orcaDataFiles()) {
      try {
        this.orcaWatchers.push(fs.watch(file, () => this.scheduleRefresh()));
      } catch {
        // skip
      }
    }
    for (const dir of [
      path.join(os.homedir(), ".claude", "projects"),
      path.join(os.homedir(), ".codex", "sessions"),
    ]) {
      try {
        this.orcaWatchers.push(fs.watch(dir, { recursive: true }, () => this.scheduleRefresh()));
      } catch {
        // skip
      }
    }
    this.poll = setInterval(() => {
      for (const tail of this.tails.values()) tail.readNew();
      this.refresh();
    }, 750);
    this.poll.unref?.();
  }

  stop() {
    this.rosterWatcher?.close();
    for (const watcher of this.orcaWatchers) watcher.close();
    this.orcaWatchers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.poll) clearInterval(this.poll);
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
  }

  scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 120);
  }

  scanRoster() {
    const listed = readAllSessions(this.home);
    const byId = new Map(listed.map((row) => [row.session_id, row]));
    const now = Date.now();
    for (const [id, row] of this.hooked) {
      if (now - row.mtime > 15 * 60 * 1000) {
        this.hooked.delete(id);
        continue;
      }
      const existing = byId.get(id);
      if (existing) {
        existing.live = true;
        if (row.pid) existing.pid = row.pid;
        if (row.updates) existing.updates = row.updates;
      } else {
        byId.set(id, row);
      }
    }
    this.roster = [...byId.values()].sort((a, b) => b.mtime - a.mtime);
  }

  followFocus(hint = readOrcaFocus()) {
    if (this.followMode === "project") return false;
    const focused = pickFocusedSession(this.roster, hint);
    const focusedId = focused?.session_id || null;
    if (!this.sessionStillLive()) {
      if (!focusedId) return false;
      this.selectedId = focusedId;
      this.lastFocusedId = focusedId;
      return true;
    }
    if (!focusedId) return false;
    // Picker choice sticks while the focused Grok tab stays put.
    // Moving to another session (tab / worktree) follows that session.
    if (focusedId === this.lastFocusedId) return false;
    this.lastFocusedId = focusedId;
    if (focusedId === this.selectedId) return false;
    this.selectedId = focusedId;
    return true;
  }

  refresh({ force = false } = {}) {
    this.scanRoster();
    const fingerprint = rosterFingerprint(this.roster);
    const rosterChanged = fingerprint !== this.fingerprint;
    this.fingerprint = fingerprint;
    const focusedChanged = this.followFocus();
    this.syncTails();
    if (force || rosterChanged || focusedChanged) {
      this.emit({ type: "snapshot", ...this.snapshot() });
      this.emitActivity();
    }
  }

  syncTails() {
    const liveIds = new Set(this.roster.map((s) => s.session_id));
    for (const [id, tail] of this.tails) {
      if (!liveIds.has(id)) {
        tail.stop();
        this.tails.delete(id);
        this.emit({ type: "agent", agentId: id, status: "stop" });
        this.busy.delete(id);
      }
    }
    for (const session of this.roster) {
      if (this.tails.has(session.session_id)) continue;
      const file = updatesPath(session, this.home);
      if (!fs.existsSync(file)) continue;
      const seen = new Set();
      this.seen.set(session.session_id, seen);
      this.visits.set(session.session_id, []);
      const gate = { live: false };
      const tail = new FileTail(file, (line) => this.onLine(session, line, seen, gate.live));
      tail.replay();
      gate.live = true;
      tail.start();
      this.tails.set(session.session_id, tail);
      this.emit({
        type: "agent",
        agentId: session.session_id,
        agentLabel: session.agent || "agent",
        cwd: session.cwd,
        status: "start",
      });
    }
    this.emitActivity();
  }

  emitActivity() {
    const selected = this.roster.find((s) => s.session_id === this.selectedId) || this.roster[0];
    if (!selected) {
      this.emit({ type: "activity", active: false, sessionId: null });
      return;
    }
    const peers = this.roster.filter((s) => s.cwd === selected.cwd);
    const active = peers.some((s) => this.busy.get(s.session_id));
    this.emit({
      type: "activity",
      active,
      sessionId: selected.session_id,
      cwd: selected.cwd,
    });
  }

  interpretLine(session, line) {
    if (session.provider === "claude") return parseClaudeLine(line, session);
    if (session.provider === "codex") return parseCodexLine(line, session);
    const activity = parseSessionEvent(line);
    const prompt = isUserPromptEvent(line);
    const parsed = parseAcpLine(line, { ...session, label: session.agent });
    return { visits: parsed ? [parsed] : [], activity, prompt };
  }

  onLine(session, line, seen, live) {
    const { visits, activity, prompt } = this.interpretLine(session, line);
    if (activity) {
      this.busy.set(session.session_id, activity === "busy");
      if (live) this.emitActivity();
    }
    if (live && prompt) this.followPrompt(session);
    for (const parsed of visits) {
      if (parsed.toolCallId && seen.has(parsed.toolCallId)) continue;
      if (parsed.toolCallId) seen.add(parsed.toolCallId);
      const folder = parsed.visit.folderPath;
      const list = this.visits.get(session.session_id) || [];
      if (!list.includes(folder)) list.push(folder);
      this.visits.set(session.session_id, list);
      this.lastFolder.set(session.session_id, folder);
      if (!live) continue;
      const selected = this.roster.find((s) => s.session_id === this.selectedId);
      if (selected && session.cwd !== selected.cwd) continue;
      this.emit({
        type: "visit",
        agentId: session.session_id,
        agentLabel: session.agent || parsed.visit.agentLabel || "agent",
        folderPath: folder,
        filePath: parsed.visit.filePath,
        toolName: parsed.visit.toolName,
        cwd: session.cwd,
        ts: parsed.visit.ts,
      });
    }
  }
}

export function replaySession(session, home = grokHome()) {
  const file = updatesPath(session, home);
  const seen = new Set();
  const visits = [];
  if (!fs.existsSync(file)) return visits;
  const text = fs.readFileSync(file, "utf8");
  const interpret = (line) => {
    if (session.provider === "claude") return parseClaudeLine(line, session).visits;
    if (session.provider === "codex") return parseCodexLine(line, session).visits;
    const parsed = parseAcpLine(line, session);
    return parsed ? [parsed] : [];
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsedList = interpret(line);
    for (const parsed of parsedList) {
      if (!parsed) continue;
      if (parsed.toolCallId && seen.has(parsed.toolCallId)) continue;
      if (parsed.toolCallId) seen.add(parsed.toolCallId);
      visits.push(parsed.visit);
    }
  }
  return visits;
}
