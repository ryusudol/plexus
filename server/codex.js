import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visitFromCodexRecord } from "../lib/extract.js";

const LIVE_MS = 15 * 60 * 1000;
const ROLLOUT = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/;

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function peekRecords(file, limit = 20) {
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

function cwdFromRecords(records) {
  for (const record of records) {
    const payload = record?.payload;
    if (record?.type === "session_meta" && payload && typeof payload.cwd === "string") {
      return payload.cwd;
    }
    if (typeof payload?.cwd === "string") return payload.cwd;
  }
  return null;
}

export function parseCodexLine(line, session) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { visits: [], activity: null, prompt: false };
  }
  const payload = record.payload && typeof record.payload === "object" ? record.payload : record;
  const kind = payload.type || record.type;
  const event = payload.type || record.type;
  let prompt = false;
  let activity = null;
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

function walkRollouts(root, now, into, depth = 0) {
  if (depth > 5) return;
  let entries;
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
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > LIVE_MS) continue;
    const records = peekRecords(full);
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

function recentDayDirs(home, now) {
  const root = path.join(home, "sessions");
  const dirs = [];
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

export function readCodexSessions(home = codexHome(), now = Date.now()) {
  const out = [];
  const dirs = recentDayDirs(home, now);
  if (!dirs.length) walkRollouts(path.join(home, "sessions"), now, out);
  for (const dir of dirs) walkRollouts(dir, now, out);
  const byId = new Map();
  for (const row of out) byId.set(row.session_id, row);
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime);
}

export function installCodexHooks({ nodePath, launcher, hookBin }) {
  const file = path.join(codexHome(), "hooks.json");
  let spec = {};
  try {
    spec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    spec = {};
  }
  if (!spec || typeof spec !== "object") spec = {};
  if (!spec.hooks || typeof spec.hooks !== "object") spec.hooks = {};
  const blob = JSON.stringify(spec.hooks);
  if (!blob.includes("bin/plexus.js")) {
    if (!Array.isArray(spec.hooks.SessionStart)) spec.hooks.SessionStart = [];
    spec.hooks.SessionStart.push({
      hooks: [
        {
          type: "command",
          command: `${nodePath} "${launcher}" --ensure`,
          timeout: 8,
        },
      ],
    });
  }
  if (!blob.includes("plexus-hook")) {
    const command = {
      hooks: [
        {
          type: "command",
          command: `${nodePath} "${hookBin}" --source codex`,
          timeout: 2,
        },
      ],
    };
    for (const event of ["PreToolUse", "UserPromptSubmit", "Stop"]) {
      if (!Array.isArray(spec.hooks[event])) spec.hooks[event] = [];
      spec.hooks[event].push(command);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
}
