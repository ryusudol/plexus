import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIVE_MS } from "../lib/config.ts";
import { peekJsonl, tryParseJson } from "../lib/node.ts";
import { visitFromClaudeRecord } from "../lib/extract.ts";
import type { LineParse, SessionHint, SessionRow } from "../lib/types.ts";
import {
  commandGroup,
  ensureHookList,
  hasPlexusLauncher,
  loadHooksFile,
  migrateLauncherCommands,
  saveHooksFile,
} from "./hooks.ts";

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function titleFromRecords(records: Record<string, unknown>[], cwd: string | null): string {
  for (const record of records) {
    if (record?.type === "custom-title" && typeof record.title === "string" && record.title.trim()) {
      return record.title.trim();
    }
    if (record?.type === "summary" && typeof record.summary === "string" && record.summary.trim()) {
      return record.summary.trim();
    }
  }
  return path.basename(cwd || "") || "claude";
}

function cwdFromRecords(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    if (typeof record?.cwd === "string" && record.cwd) return record.cwd;
  }
  return null;
}

export function parseClaudeLine(line: string, session: SessionHint): LineParse {
  const record = tryParseJson<Record<string, unknown>>(line);
  if (!record) return { visits: [], activity: null, prompt: false };
  const type = record.type;
  const message = record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>) : null;
  const content = message?.content;
  const isToolResult =
    type === "user" &&
    Array.isArray(content) &&
    content.some((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result");
  const prompt = type === "user" && !isToolResult;
  let activity: LineParse["activity"] = null;
  if (type === "assistant" || prompt) activity = "busy";
  if (record.hook_event_name === "Stop" || record.type === "stop") activity = "idle";
  const visits = visitFromClaudeRecord(record, session);
  return { visits, activity, prompt };
}

export function readClaudeSessions(home = claudeHome(), now = Date.now()): SessionRow[] {
  const root = path.join(home, "projects");
  if (!fs.existsSync(root)) return [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionRow[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > LIVE_MS) continue;
      const records = peekJsonl(file);
      const cwd = cwdFromRecords(records);
      if (!cwd) continue;
      const id = name.replace(/\.jsonl$/, "");
      out.push({
        session_id: `claude:${id}`,
        nativeId: id,
        pid: 0,
        cwd,
        title: titleFromRecords(records, cwd),
        agent: "claude",
        provider: "claude",
        updates: file,
        mtime: st.mtimeMs,
        live: true,
      });
    }
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

export function installClaudeHooks({
  nodePath,
  launcher,
  hookBin,
  url,
}: {
  nodePath: string;
  launcher: string;
  hookBin: string;
  url: string;
}): void {
  const file = path.join(claudeHome(), "settings.json");
  const settings = loadHooksFile(file);
  migrateLauncherCommands(settings.hooks);
  const blob = JSON.stringify(settings.hooks);
  if (!hasPlexusLauncher(blob)) {
    ensureHookList(settings.hooks, "SessionStart").push(
      commandGroup(`${nodePath} "${launcher}" --ensure`, 8),
    );
  }
  if (!blob.includes("127.0.0.1:7733/hook") && !blob.includes("plexus-hook")) {
    ensureHookList(settings.hooks, "PreToolUse").push({
      matcher: "Read|Write|Edit|Glob|Grep|NotebookEdit",
      hooks: [{ type: "http", url, timeout: 2 }],
    });
    const sourceHook = commandGroup(`${nodePath} "${hookBin}" --source claude`, 2);
    ensureHookList(settings.hooks, "UserPromptSubmit").push(sourceHook);
    ensureHookList(settings.hooks, "Stop").push(sourceHook);
  }
  saveHooksFile(file, settings);
}
