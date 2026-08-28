import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIVE_MS } from "../lib/config.ts";
import { newestById, peekJsonl, tryParseJson } from "../lib/node.ts";
import { visitFromCodexRecord } from "../lib/extract.ts";
import type { LineParse, SessionHint, SessionRow } from "../lib/types.ts";
import {
  commandGroup,
  ensureHookList,
  hasPlexusLauncher,
  loadHooksFile,
  migrateLauncherCommands,
  saveHooksFile,
} from "./hooks.ts";

const ROLLOUT = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/;

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function cwdFromRecords(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    const payload = record?.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>) : null;
    if (record?.type === "session_meta" && payload && typeof payload.cwd === "string") {
      return payload.cwd;
    }
    if (typeof payload?.cwd === "string") return payload.cwd;
  }
  return null;
}

export function parseCodexLine(line: string, session: SessionHint): LineParse {
  const record = tryParseJson<Record<string, unknown>>(line);
  if (!record) return { visits: [], activity: null, prompt: false };
  const payload = record.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>) : record;
  const kind = payload.type || record.type;
  const event = payload.type || record.type;
  let prompt = false;
  let activity: LineParse["activity"] = null;
  if (kind === "message" && payload.role === "user") {
    prompt = true;
    activity = "busy";
  }
  if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
    activity = "busy";
  }
  if (record.type === "event_msg" && (event === "task_complete" || payload.type === "task_complete")) {
    activity = "idle";
  }
  const parsed = visitFromCodexRecord(record, session);
  return { visits: parsed ? [parsed] : [], activity, prompt };
}

function walkRollouts(root: string, now: number, into: SessionRow[], depth = 0): void {
  if (depth > 5) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkRollouts(full, now, into, depth + 1);
      continue;
    }
    const match = ROLLOUT.exec(entry.name);
    if (!match) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > LIVE_MS) continue;
    const records = peekJsonl(full, 20);
    const cwd = cwdFromRecords(records);
    if (!cwd) continue;
    const nativeId = match[1];
    into.push({
      session_id: `codex:${nativeId}`,
      nativeId,
      pid: 0,
      cwd,
      title: path.basename(cwd) || "codex",
      agent: "codex",
      provider: "codex",
      updates: full,
      mtime: st.mtimeMs,
      live: true,
    });
  }
}

function recentDayDirs(home: string, now: number): string[] {
  const root = path.join(home, "sessions");
  const dirs: string[] = [];
  for (const delta of [0, 1, 2]) {
    const local = new Date(now - delta * 86400000);
    const utc = new Date(now - delta * 86400000);
    dirs.push(
      path.join(
        root,
        String(local.getFullYear()),
        String(local.getMonth() + 1).padStart(2, "0"),
        String(local.getDate()).padStart(2, "0"),
      ),
      path.join(
        root,
        String(utc.getUTCFullYear()),
        String(utc.getUTCMonth() + 1).padStart(2, "0"),
        String(utc.getUTCDate()).padStart(2, "0"),
      ),
    );
  }
  return [...new Set(dirs)];
}

export function readCodexSessions(home = codexHome(), now = Date.now()): SessionRow[] {
  const out: SessionRow[] = [];
  const dirs = recentDayDirs(home, now);
  if (!dirs.length) walkRollouts(path.join(home, "sessions"), now, out);
  for (const dir of dirs) walkRollouts(dir, now, out);
  return newestById(out);
}

export function installCodexHooks({
  nodePath,
  launcher,
  hookBin,
}: {
  nodePath: string;
  launcher: string;
  hookBin: string;
}): void {
  const file = path.join(codexHome(), "hooks.json");
  const spec = loadHooksFile(file);
  migrateLauncherCommands(spec.hooks);
  const blob = JSON.stringify(spec.hooks);
  if (!hasPlexusLauncher(blob)) {
    ensureHookList(spec.hooks, "SessionStart").push(
      commandGroup(`${nodePath} "${launcher}" --ensure`, 8),
    );
  }
  if (!blob.includes("plexus-hook")) {
    const command = commandGroup(`${nodePath} "${hookBin}" --source codex`, 2);
    for (const event of ["PreToolUse", "UserPromptSubmit", "Stop"]) {
      ensureHookList(spec.hooks, event).push(command);
    }
  }
  saveHooksFile(file, spec);
}
