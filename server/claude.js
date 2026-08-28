import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visitFromClaudeRecord } from "../lib/extract.js";

const LIVE_MS = 15 * 60 * 1000;

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function slugifyCwd(cwd) {
  return String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");
}

function peekRecords(file, limit = 40) {
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.slice(0, n).toString("utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip
    }
    if (rows.length >= limit) break;
  }
  return rows;
}

function titleFromRecords(records, cwd) {
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

function cwdFromRecords(records) {
  for (const record of records) {
    if (typeof record?.cwd === "string" && record.cwd) return record.cwd;
  }
  return null;
}

export function parseClaudeLine(line, session) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { visits: [], activity: null, prompt: false };
  }
  const type = record.type;
  const content = record.message?.content;
  const isToolResult =
    type === "user" &&
    Array.isArray(content) &&
    content.some((block) => block && block.type === "tool_result");
  const prompt = type === "user" && !isToolResult;
  let activity = null;
  if (type === "assistant" || prompt) activity = "busy";
  if (record.hook_event_name === "Stop" || record.type === "stop") activity = "idle";
  const visits = visitFromClaudeRecord(record, session);
  return { visits, activity, prompt };
}

export function readClaudeSessions(home = claudeHome(), now = Date.now()) {
  const root = path.join(home, "projects");
  if (!fs.existsSync(root)) return [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > LIVE_MS) continue;
      const records = peekRecords(file);
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
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function installClaudeHooks({ nodePath, launcher, hookBin, url }) {
  const file = path.join(claudeHome(), "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    settings = {};
  }
  if (!settings || typeof settings !== "object") settings = {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  const blob = JSON.stringify(settings.hooks);
  if (!blob.includes("bin/plexus.js")) {
    if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: "command",
          command: `${nodePath} "${launcher}" --ensure`,
          timeout: 8,
        },
      ],
    });
  }
  if (!blob.includes("127.0.0.1:7733/hook") && !blob.includes("plexus-hook")) {
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
    settings.hooks.PreToolUse.push({
      matcher: "Read|Write|Edit|Glob|Grep|NotebookEdit",
      hooks: [{ type: "http", url, timeout: 2 }],
    });
    if (!Array.isArray(settings.hooks.UserPromptSubmit)) settings.hooks.UserPromptSubmit = [];
    settings.hooks.UserPromptSubmit.push({
      hooks: [
        {
          type: "command",
          command: `${nodePath} "${hookBin}" --source claude`,
          timeout: 2,
        },
      ],
    });
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    settings.hooks.Stop.push({
      hooks: [
        {
          type: "command",
          command: `${nodePath} "${hookBin}" --source claude`,
          timeout: 2,
        },
      ],
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}
