import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOCUS_MS, LIVE_MS, REFRESH_DEBOUNCE_MS, ROSTER_MS } from "../lib/config.ts";
import { inferProvider } from "../lib/extract.ts";
import { pathUnder, uniquePush, uniqueUnder } from "../lib/under.ts";
import {
  emptySnapshot,
  type FollowMode,
  type HubEvent,
  type LineParse,
  type ParsedVisit,
  type SessionRow,
  type Snapshot,
  type Visit,
} from "../lib/types.ts";
import { isUserPromptEvent, parseAcpLine, parseSessionEvent } from "./acp.ts";
import { parseClaudeLine } from "./claude.ts";
import { parseCodexLine } from "./codex.ts";
import { orcaDataFiles, readOrcaFocus } from "./orca.ts";
import { listAgentPids } from "./procs.ts";
import {
  grokHome,
  pickFocusedSession,
  readAllSessions,
  rosterFingerprint,
  updatesPath,
  type FocusHint,
} from "./roster.ts";
import { FileTail } from "./tail.ts";

export { orcaDataFiles, readOrcaActiveCwd, readOrcaFocus, readOrcaLivePanes } from "./orca.ts";
export { isUserPromptEvent, parseAcpLine, parseSessionEvent } from "./acp.ts";
export {
  encodeCwd,
  grokHome,
  pickFocusedSession,
  readActiveSessions,
  readAllSessions,
  readSummary,
  rosterFingerprint,
  sessionDir,
  updatesPath,
  type FocusHint,
} from "./roster.ts";

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
  focusPoll: ReturnType<typeof setInterval> | null = null;
  refreshTimer: ReturnType<typeof setTimeout> | null = null;
  fingerprint = "";
  followMode: FollowMode = "focus";
  lastFocusedId: string | null = null;
  focusKey = "";
  knownIds = new Set<string>();
  hooked = new Map<string, SessionRow>();

  constructor({ home = grokHome(), emit }: { home?: string; emit?: (event: HubEvent) => void } = {}) {
    this.home = home;
    this.emit = emit || (() => {});
  }

  snapshot(): Snapshot {
    this.scanRoster();
    const roster = this.roster;
    if (!roster.length) return emptySnapshot();
    if (!this.selectedId || !roster.some((s) => s.session_id === this.selectedId)) {
      this.selectedId = roster[0].session_id;
    }
    const selected = roster.find((s) => s.session_id === this.selectedId) || roster[0];
    const visited = uniqueUnder(selected.cwd, [this.visits.get(selected.session_id)]);
    const files = uniqueUnder(selected.cwd, [this.files.get(selected.session_id)]);
    const last = this.lastFolder.get(selected.session_id);
    const lastFile = this.lastFile.get(selected.session_id);
    const folderPath = last && pathUnder(selected.cwd, last) ? last : selected.cwd;
    const filePath = lastFile && pathUnder(selected.cwd, lastFile) ? lastFile : null;
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
      agents: [
        {
          id: selected.session_id,
          label: selected.agent === "grok-build-plan" ? "plan" : selected.agent || "agent",
          title: selected.title || "",
          folderPath,
          filePath,
        },
      ],
      visited,
      files,
      busy: Boolean(this.busy.get(selected.session_id)),
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

  noteHook(event: Record<string, unknown>): void {
    const provider = inferProvider(event);
    const native =
      (typeof event.session_id === "string" && event.session_id) ||
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
    const onChange = () => this.scheduleRefresh();
    try {
      this.rosterWatcher = fs.watch(path.join(this.home, "active_sessions.json"), onChange);
    } catch {
      this.rosterWatcher = null;
    }
    const watched = new Set<string>();
    for (const file of orcaDataFiles()) {
      for (const target of [file, path.dirname(file)]) {
        if (watched.has(target)) continue;
        watched.add(target);
        try {
          this.orcaWatchers.push(fs.watch(target, onChange));
        } catch {
          // skip
        }
      }
    }
    for (const dir of [
      path.join(os.homedir(), ".claude", "projects"),
      path.join(os.homedir(), ".codex", "sessions"),
    ]) {
      try {
        this.orcaWatchers.push(fs.watch(dir, { recursive: true }, onChange));
      } catch {
        // skip
      }
    }
    this.focusPoll = setInterval(() => this.pollFocus(), FOCUS_MS);
    this.focusPoll.unref?.();
    this.poll = setInterval(() => {
      for (const tail of this.tails.values()) tail.readNew();
      this.refresh();
    }, ROSTER_MS);
    this.poll.unref?.();
  }

  stop(): void {
    this.rosterWatcher?.close();
    for (const watcher of this.orcaWatchers) watcher.close();
    this.orcaWatchers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.focusPoll) clearInterval(this.focusPoll);
    if (this.poll) clearInterval(this.poll);
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
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
    if (focusedId === this.lastFocusedId) return false;
    this.lastFocusedId = focusedId;
    if (focusedId === this.selectedId) return false;
    this.selectedId = focusedId;
    return true;
  }

  pollFocus(): boolean {
    if (this.followMode === "project") return false;
    const hint = readOrcaFocus();
    const key = `${hint?.sessionId || ""}|${hint?.cwd || ""}`;
    if (key === this.focusKey) return false;
    if (hint?.sessionId && !this.roster.some((session) => session.session_id === hint.sessionId)) {
      this.scanRoster();
    }
    this.focusKey = key;
    if (!this.followFocus(hint)) return false;
    this.syncTails();
    this.emit({ type: "snapshot", ...this.snapshot() });
    this.emitActivity();
    return true;
  }

  followNewSession(): boolean {
    const live = new Set(this.roster.map((session) => session.session_id));
    const added = this.knownIds.size
      ? this.roster.filter((session) => !this.knownIds.has(session.session_id))
      : [];
    this.knownIds = live;
    if (this.followMode === "project" || !added.length) return false;
    const newest = added[0];
    if (!newest || newest.session_id === this.selectedId) return false;
    this.selectedId = newest.session_id;
    return true;
  }

  refresh({ force = false } = {}): void {
    this.scanRoster();
    const fingerprint = rosterFingerprint(this.roster);
    const rosterChanged = fingerprint !== this.fingerprint;
    this.fingerprint = fingerprint;
    const focusedChanged = this.followFocus();
    const spawned = this.followNewSession();
    this.syncTails();
    if (force || rosterChanged || focusedChanged || spawned) {
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
    const active = Boolean(this.busy.get(selected.session_id));
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
      uniquePush(list, folder);
      this.visits.set(session.session_id, list);
      this.lastFolder.set(session.session_id, folder);
      const file = parsed.visit.filePath;
      if (file) {
        const fileList = this.files.get(session.session_id) || [];
        uniquePush(fileList, file);
        this.files.set(session.session_id, fileList);
        this.lastFile.set(session.session_id, file);
      } else {
        this.lastFile.delete(session.session_id);
      }
      if (!live) continue;
      const selected = this.roster.find((s) => s.session_id === this.selectedId);
      if (!selected || selected.session_id !== session.session_id) continue;
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
