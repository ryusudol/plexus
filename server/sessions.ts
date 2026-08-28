import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIVE_MS } from "../lib/config.ts";
import { inferProvider, visitFromAcpRecord } from "../lib/extract.ts";
import { newestById, pidAlive, readJsonFile, tryParseJson } from "../lib/node.ts";
import type {
  FollowMode,
  HubEvent,
  LineParse,
  OrcaFocus,
  OrcaPane,
  ParsedVisit,
  SessionRow,
  Snapshot,
  Visit,
} from "../lib/types.ts";
import { parseClaudeLine, readClaudeSessions } from "./claude.ts";
import { parseCodexLine, readCodexSessions } from "./codex.ts";
import { orcaDataFiles, readOrcaFocus, readOrcaLivePanes } from "./orca.ts";
import { listAgentPids } from "./procs.ts";
import { FileTail } from "./tail.ts";

export { orcaDataFiles, readOrcaActiveCwd, readOrcaFocus, readOrcaLivePanes } from "./orca.ts";

export function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

export function encodeCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

export function sessionDir(cwd: string, sessionId: string, home = grokHome()): string {
  const direct = path.join(home, "sessions", encodeCwd(cwd), sessionId);
  if (fs.existsSync(direct)) return direct;
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return direct;
  let groups: fs.Dirent[];
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

export function updatesPath(session: SessionRow, home = grokHome()): string {
  if (session?.updates) return session.updates;
  const id = session.nativeId || session.session_id;
  return path.join(sessionDir(session.cwd, id, home), "updates.jsonl");
}

type SessionSummary = {
  generated_title?: string;
  agent_name?: string;
};

export function readSummary(session: SessionRow, home = grokHome()): SessionSummary | null {
  const file = path.join(sessionDir(session.cwd, session.session_id, home), "summary.json");
  const summary = readJsonFile<SessionSummary | null>(file, null);
  return summary;
}

function findSessionCwd(sessionId: string, home = grokHome()): string | null {
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return null;
  let groups: fs.Dirent[];
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

function rosterEntry(row: SessionRow, home: string, { live = false } = {}): SessionRow {
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
    updates,
    mtime,
    live,
  };
}

function readActiveSessionRows(home: string): SessionRow[] {
  const rows = readJsonFile<unknown>(path.join(home, "active_sessions.json"), []);
  return Array.isArray(rows)
    ? rows.filter((row): row is SessionRow => Boolean(row?.session_id && row.cwd))
    : [];
}

export function readActiveSessions(home = grokHome(), panes?: Map<string, OrcaPane> | null): SessionRow[] {
  const rows = readActiveSessionRows(home);
  const byId = new Map<string, SessionRow>();
  for (const row of rows) {
    const hostLive = pidAlive(row.pid);
    let mtime = 0;
    try {
      mtime = fs.statSync(updatesPath(row, home)).mtimeMs;
    } catch {
      mtime = 0;
    }
    const recent = Date.now() - mtime < LIVE_MS;
    byId.set(row.session_id, rosterEntry(row, home, { live: hostLive || recent }));
  }

  const livePanes = panes === undefined && home === grokHome() ? readOrcaLivePanes() : panes;
  const out: SessionRow[] = [];
  const seen = new Set<string>();
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
      out.push(rosterEntry({ session_id: id, cwd, pid: 0, provider: "grok", title: "", agent: "agent", mtime: 0, live: true }, home, { live: true }));
      seen.add(id);
    }
  }
  for (const session of byId.values()) {
    if (seen.has(session.session_id)) continue;
    if (!session.live) continue;
    out.push(session);
    seen.add(session.session_id);
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

export function readAllSessions(home = grokHome()): SessionRow[] {
  return newestById([...readActiveSessions(home), ...readClaudeSessions(), ...readCodexSessions()]);
}

export function rosterFingerprint(roster: SessionRow[] | null | undefined): string {
  return (roster || [])
    .map((s) => `${s.session_id}:${s.pid || 0}:${s.cwd}:${s.title}:${s.live ? 1 : 0}`)
    .join("|");
}

export type FocusHint = OrcaFocus | string | null | undefined;

function focusHint(hint: FocusHint): OrcaFocus {
  if (hint && typeof hint === "object") return hint;
  if (typeof hint === "string" && hint) return { cwd: hint, sessionId: null };
  return readOrcaFocus() || { cwd: null, sessionId: null };
}

export function pickFocusedSession(roster: SessionRow[] | null | undefined, hint: FocusHint = readOrcaFocus()): SessionRow | null {
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
      return pool.slice().sort((a, b) => Number(b.live) - Number(a.live) || (b.mtime || 0) - (a.mtime || 0))[0];
    }
  }
  return null;
}

export function parseAcpLine(line: string, session: SessionRow | { session_id?: string; cwd?: string; label?: string }): ParsedVisit | null {
  const record = tryParseJson(line);
  if (record == null) return null;
  return visitFromAcpRecord(record, session);
}

function sessionUpdateOf(line: string): Record<string, unknown> | null {
  const record = tryParseJson<Record<string, unknown>>(line);
  if (!record) return null;
  const params = record.params && typeof record.params === "object" ? (record.params as Record<string, unknown>) : null;
  const update = params?.update || record.update || null;
  return update && typeof update === "object" ? (update as Record<string, unknown>) : null;
}

export function isUserPromptEvent(line: string): boolean {
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

export function parseSessionEvent(line: string): "busy" | "idle" | null {
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

export class SessionHub {
  home: string;
  emit: (event: HubEvent) => void;
  selectedId: string | null = null;
  tails = new Map<string, FileTail>();
  seen = new Map<string, Set<string>>();
  visits = new Map<string, string[]>();
  files = new Map<string, string[]>();
  lastFolder = new Map<string, string>();
  lastFile = new Map<string, string>();
  busy = new Map<string, boolean>();
  roster: SessionRow[] = [];
  rosterWatcher: fs.FSWatcher | null = null;
  orcaWatchers: fs.FSWatcher[] = [];
  poll: ReturnType<typeof setInterval> | null = null;
  refreshTimer: ReturnType<typeof setTimeout> | null = null;
  fingerprint = "";
  followMode: FollowMode = "focus";
  lastFocusedId: string | null = null;
  hooked = new Map<string, SessionRow>();

  constructor({ home = grokHome(), emit }: { home?: string; emit?: (event: HubEvent) => void } = {}) {
    this.home = home;
    this.emit = emit || (() => {});
  }

  snapshot(): Snapshot {
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
        files: [],
        busy: false,
        pids: [],
      };
    }
    if (!this.selectedId || !roster.some((s) => s.session_id === this.selectedId)) {
      this.selectedId = roster[0].session_id;
    }
    const selected = roster.find((s) => s.session_id === this.selectedId) || roster[0];
    const underRoot = (folder: string) =>
      folder === selected.cwd || String(folder).startsWith(`${selected.cwd}/`);
    const visited: string[] = [];
    const seenFolders = new Set<string>();
    const files: string[] = [];
    const seenFiles = new Set<string>();
    for (const session of roster) {
      const list = this.visits.get(session.session_id) || [];
      for (const folder of list) {
        if (!underRoot(folder) || seenFolders.has(folder)) continue;
        seenFolders.add(folder);
        visited.push(folder);
      }
      for (const file of this.files.get(session.session_id) || []) {
        if (!underRoot(file) || seenFiles.has(file)) continue;
        seenFiles.add(file);
        files.push(file);
      }
    }
    const last = this.lastFolder.get(selected.session_id);
    const lastFile = this.lastFile.get(selected.session_id);
    const folderPath = last && underRoot(last) ? last : selected.cwd;
    const filePath = lastFile && underRoot(lastFile) ? lastFile : null;
    const agents = [
      {
        id: selected.session_id,
        label: selected.agent === "grok-build-plan" ? "plan" : selected.agent || "agent",
        title: selected.title || "",
        folderPath,
        filePath,
      },
    ];
    return {
      sessions: roster.map((s) => ({
        id: s.session_id,
        title: s.title || "",
        cwd: s.cwd,
        live: Boolean(s.live),
        provider: s.provider || "grok",
        selected: s.session_id === selected.session_id,
      })),
      sessionId: selected.session_id,
      sessionTitle: selected.title || null,
      root: selected.cwd,
      agents,
      visited,
      files,
      busy: roster.some(
        (s) =>
          this.busy.get(s.session_id) &&
          (s.cwd === selected.cwd ||
            String(s.cwd).startsWith(`${selected.cwd}/`) ||
            selected.cwd.startsWith(`${s.cwd}/`)),
      ),
      pids: [...new Set([...roster.map((s) => s.pid).filter((pid): pid is number => Boolean(pid)), ...listAgentPids()])],
      followMode: this.followMode === "project" ? "project" : "focus",
    };
  }

  select(sessionId: string): void {
    this.selectedId = sessionId;
    this.syncTails();
    this.emit({ type: "snapshot", ...this.snapshot() });
    this.emitActivity();
  }

  sessionStillLive(id = this.selectedId): boolean {
    return Boolean(id && this.roster.some((s) => s.session_id === id));
  }

  /**
   * Jump to a session that just received a user prompt.
   * Picker / project follow stay put until that happens.
   */
  noteHook(event: Record<string, unknown>): void {
    const provider = inferProvider(event);
    const native = (typeof event.session_id === "string" && event.session_id) ||
      (typeof event.sessionId === "string" && event.sessionId) ||
      "";
    if (!native) return;
    const id = provider === "grok" ? native : `${provider}:${native}`;
    const cwd =
      (typeof event.cwd === "string" && event.cwd) ||
      (typeof event.workspace_root === "string" && event.workspace_root) ||
      (typeof event.workspaceRoot === "string" && event.workspaceRoot) ||
      "";
    const updates =
      (typeof event.transcript_path === "string" && event.transcript_path) ||
      (typeof event.transcriptPath === "string" && event.transcriptPath) ||
      "";
    const prev = this.hooked.get(id) || ({} as Partial<SessionRow>);
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
    if (/UserPromptSubmit|user_prompt_submit|user_message/i.test(String(hook))) {
      this.busy.set(id, true);
      const row = this.hooked.get(id) || this.roster.find((s) => s.session_id === id);
      if (row) this.followPrompt(row);
    } else if (/PreToolUse|pre_tool_use|tool_call/i.test(String(hook))) {
      this.busy.set(id, true);
    } else if (/^(Stop|StopFailure|stop)/i.test(String(hook))) {
      this.busy.set(id, false);
    }
  }

  followPrompt(session: { session_id?: string; cwd?: string } | null | undefined): boolean {
    if (this.followMode === "project") return false;
    const id = session?.session_id;
    if (!id || id === this.selectedId) return false;
    this.selectedId = id;
    this.emit({ type: "snapshot", ...this.snapshot() });
    this.emitActivity();
    return true;
  }

  start(): void {
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

  stop(): void {
    this.rosterWatcher?.close();
    for (const watcher of this.orcaWatchers) watcher.close();
    this.orcaWatchers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.poll) clearInterval(this.poll);
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 120);
  }

  scanRoster(): void {
    const listed = readAllSessions(this.home);
    const byId = new Map(listed.map((row) => [row.session_id, row]));
    const now = Date.now();
    for (const [id, row] of this.hooked) {
      if (now - (row.mtime || 0) > LIVE_MS) {
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
    this.roster = [...byId.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }

  followFocus(hint: FocusHint = readOrcaFocus()): boolean {
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

  refresh({ force = false } = {}): void {
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

  syncTails(): void {
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
      const seen = new Set<string>();
      this.seen.set(session.session_id, seen);
      this.visits.set(session.session_id, []);
      this.files.set(session.session_id, []);
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

  emitActivity(): void {
    const selected = this.roster.find((s) => s.session_id === this.selectedId) || this.roster[0];
    if (!selected) {
      this.emit({ type: "activity", active: false, sessionId: null });
      return;
    }
    const active = this.roster.some(
      (s) =>
        this.busy.get(s.session_id) &&
        (s.cwd === selected.cwd ||
          String(s.cwd).startsWith(`${selected.cwd}/`) ||
          selected.cwd.startsWith(`${s.cwd}/`)),
    );
    this.emit({
      type: "activity",
      active,
      sessionId: selected.session_id,
      cwd: selected.cwd,
    });
  }

  interpretLine(session: SessionRow, line: string): LineParse {
    if (session.provider === "claude") return parseClaudeLine(line, session);
    if (session.provider === "codex") return parseCodexLine(line, session);
    const activity = parseSessionEvent(line);
    const prompt = isUserPromptEvent(line);
    const parsed = parseAcpLine(line, { ...session, label: session.agent });
    return { visits: parsed ? [parsed] : [], activity, prompt };
  }

  onLine(session: SessionRow, line: string, seen: Set<string>, live: boolean): void {
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
      if (!folder) continue;
      const list = this.visits.get(session.session_id) || [];
      if (!list.includes(folder)) list.push(folder);
      this.visits.set(session.session_id, list);
      this.lastFolder.set(session.session_id, folder);
      const file = parsed.visit.filePath;
      if (file) {
        const fileList = this.files.get(session.session_id) || [];
        if (!fileList.includes(file)) fileList.push(file);
        this.files.set(session.session_id, fileList);
        this.lastFile.set(session.session_id, file);
      } else {
        this.lastFile.delete(session.session_id);
      }
      if (!live) continue;
      const selected = this.roster.find((s) => s.session_id === this.selectedId);
      const loc = file || folder;
      if (selected && loc !== selected.cwd && !String(loc).startsWith(`${selected.cwd}/`)) {
        continue;
      }
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

export function replaySession(session: SessionRow, home = grokHome()): Visit[] {
  const file = updatesPath(session, home);
  const seen = new Set<string>();
  const visits: Visit[] = [];
  if (!fs.existsSync(file)) return visits;
  const text = fs.readFileSync(file, "utf8");
  const interpret = (line: string): ParsedVisit[] => {
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
