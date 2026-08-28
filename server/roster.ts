import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIVE_MS } from "../lib/config.ts";
import { newestById, pidAlive, readJsonFile } from "../lib/node.ts";
import { pathUnder } from "../lib/under.ts";
import type { OrcaFocus, OrcaPane, SessionRow } from "../lib/types.ts";
import { readClaudeSessions } from "./claude.ts";
import { readCodexSessions } from "./codex.ts";
import { readOrcaFocus, readOrcaLivePanes } from "./orca.ts";

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
  return readJsonFile<SessionSummary | null>(file, null);
}

function findSessionCwd(sessionId: string, home: string): string | null {
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
      out.push(
        rosterEntry(
          { session_id: id, cwd, pid: 0, provider: "grok", title: "", agent: "agent", mtime: 0, live: true },
          home,
          { live: true },
        ),
      );
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

export function pickFocusedSession(
  roster: SessionRow[] | null | undefined,
  hint: FocusHint = readOrcaFocus(),
): SessionRow | null {
  if (!roster?.length) return null;
  const focus = focusHint(hint);
  if (focus.sessionId) {
    const byId = roster.find((s) => s.session_id === focus.sessionId);
    if (byId) return byId;
  }
  const cwd = focus.cwd;
  if (cwd) {
    const exact = roster.filter((s) => s.cwd === cwd);
    const nested = roster.filter((s) => pathUnder(cwd, s.cwd));
    const pool = exact.length ? exact : nested;
    if (pool.length) {
      return pool.slice().sort((a, b) => Number(b.live) - Number(a.live) || (b.mtime || 0) - (a.mtime || 0))[0];
    }
  }
  return null;
}
