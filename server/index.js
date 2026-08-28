import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVisit, inferProvider } from "../lib/extract.js";
import { plexusDir } from "../lib/paths.js";
import { installClaudeHooks } from "./claude.js";
import { installCodexHooks } from "./codex.js";
import { listFolders, folderName } from "./fs-tree.js";
import { SessionHub } from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const LIB = path.join(ROOT, "lib");
const PORT = Number(process.env.PORT || 7733);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const clients = new Set();
let workspaceRoot = process.env.PLEXUS_ROOT || process.env.GROK_EXPLORE_ROOT || process.cwd();
const recentVisit = new Map();

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(event) {
  if (event.type === "visit") {
    const key = `${event.agentId}|${event.folderPath}|${event.toolName || ""}`;
    const now = Date.now();
    if ((recentVisit.get(key) || 0) > now - 400) return;
    recentVisit.set(key, now);
  }
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

function safeResolve(input) {
  if (!input) return null;
  const resolved = path.resolve(input);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return path.dirname(resolved);
    return resolved;
  } catch {
    return null;
  }
}

function setRoot(next, { emit = true } = {}) {
  const resolved = safeResolve(next);
  if (!resolved) return null;
  if (resolved !== workspaceRoot) {
    workspaceRoot = resolved;
    if (emit) {
      broadcast({ type: "root", path: workspaceRoot, name: folderName(workspaceRoot, workspaceRoot) });
    }
  }
  return resolved;
}

function installHook() {
  const hooksDir = path.join(os.homedir(), ".grok", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const launcher = path.join(ROOT, "bin", "plexus.js");
  const url = `http://${HOST}:${PORT}/hook`;
  const spec = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `${process.execPath} "${launcher}" --ensure`,
              timeout: 8,
            },
          ],
        },
      ],
      PreToolUse: [
        { hooks: [{ type: "http", url, timeout: 2 }] },
      ],
    },
  };
  const payload = `${JSON.stringify(spec, null, 2)}\n`;
  fs.writeFileSync(path.join(hooksDir, "plexus.json"), payload);
  fs.mkdirSync(path.join(ROOT, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "hooks", "plexus.json"), payload);
  for (const stale of ["grok-explore.json"]) {
    for (const dir of [hooksDir, path.join(ROOT, "hooks")]) {
      try {
        fs.unlinkSync(path.join(dir, stale));
      } catch {
        // none
      }
    }
  }
  const hookBin = path.join(ROOT, "bin", "plexus-hook.js");
  try {
    installClaudeHooks({
      nodePath: process.execPath,
      launcher,
      hookBin,
      url,
    });
  } catch (err) {
    console.error("Could not install Claude Code hook:", err.message);
  }
  try {
    installCodexHooks({
      nodePath: process.execPath,
      launcher,
      hookBin,
    });
  } catch (err) {
    console.error("Could not install Codex hook:", err.message);
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const trimmed = rel.replace(/^\/+/, "");
  const filePath = rel.startsWith("/lib/")
    ? path.join(ROOT, trimmed)
    : path.join(PUBLIC, trimmed);
  const resolved = path.resolve(filePath);
  const allowed = rel.startsWith("/lib/") ? LIB : PUBLIC;
  if (resolved !== allowed && !resolved.startsWith(allowed + path.sep)) {
    send(res, 403, { error: "forbidden" });
    return true;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const ext = path.extname(resolved);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

function handleHookPayload(payload) {
  let event;
  try {
    event = typeof payload === "string" ? JSON.parse(payload || "{}") : payload;
  } catch {
    return { ok: false };
  }
  const provider = inferProvider(event);
  if (provider !== "grok") event.provider = provider;
  hub.noteHook(event);
  const visit = extractVisit(event);
  const nativeId = event.session_id || event.sessionId || visit?.agentId;
  const agentId = provider === "grok" || !nativeId ? nativeId : `${provider}:${nativeId}`;
  if (visit?.workspaceRoot) setRoot(visit.workspaceRoot);
  if (visit?.folderPath) {
    broadcast({
      type: "visit",
      agentId: agentId || visit.agentId,
      agentLabel: visit.agentLabel || provider || "agent",
      folderPath: visit.folderPath,
      filePath: visit.filePath,
      toolName: visit.toolName,
      ts: visit.ts,
    });
  }
  return {
    ok: true,
    decision: "allow",
    hookSpecificOutput: {
      hookEventName: event.hook_event_name || event.hookEventName || "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

function writePid() {
  const dir = plexusDir();
  fs.writeFileSync(path.join(dir, "backend.pid"), String(process.pid));
  fs.writeFileSync(path.join(dir, "backend.port"), String(PORT));
}

const PREFS_FILE = path.join(plexusDir(), "prefs.json");

function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
  } catch {
    return { accent: "#ff4fcb" };
  }
}

function writePrefs(next) {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const prefs = { ...readPrefs(), ...next };
  if (prefs.agentSymbol === null) delete prefs.agentSymbol;
  fs.writeFileSync(PREFS_FILE, `${JSON.stringify(prefs)}\n`);
  return prefs;
}

const hub = new SessionHub({
  emit: (event) => {
    if (event.type === "snapshot" && event.root) {
      setRoot(event.root, { emit: false });
    }
    broadcast(event);
  },
});
{
  const prefs = readPrefs();
  hub.followMode = prefs.graphFollow === "project" ? "project" : "focus";
  if (typeof prefs.sessionId === "string" && prefs.sessionId) {
    hub.selectedId = prefs.sessionId;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true, root: workspaceRoot, clients: clients.size, hud: "macos" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const snap = hub.snapshot();
    const root = snap.root || workspaceRoot;
    send(res, 200, {
      root,
      name: folderName(root, root),
      sep: path.sep,
      ...snap,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/prefs") {
    send(res, 200, readPrefs());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prefs") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const patch = {};
    if (typeof body.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(body.accent)) {
      patch.accent = body.accent;
    }
    if (body.shape === "tree" || body.shape === "circle") {
      patch.shape = body.shape;
    }
    if (body.theme === "light" || body.theme === "dark" || body.theme === "system") {
      patch.theme = body.theme;
    }
    if (typeof body.opacity === "number" && Number.isFinite(body.opacity)) {
      patch.opacity = Math.min(1, Math.max(0.4, body.opacity));
    }
    if (body.graphFollow === "focus" || body.graphFollow === "project") {
      patch.graphFollow = body.graphFollow;
    }
    if (typeof body.settingsHidden === "boolean") {
      patch.settingsHidden = body.settingsHidden;
    }
    if (typeof body.sessionId === "string" && body.sessionId.length < 200) {
      patch.sessionId = body.sessionId;
    }
    if (Object.prototype.hasOwnProperty.call(body, "agentSymbol")) {
      if (body.agentSymbol === null || body.agentSymbol === "") {
        patch.agentSymbol = null;
      } else if (
        typeof body.agentSymbol === "string" &&
        body.agentSymbol.startsWith("data:image/") &&
        body.agentSymbol.length < 180000
      ) {
        patch.agentSymbol = body.agentSymbol;
      }
    }
    const prefs = writePrefs(patch);
    if (prefs.agentSymbol === null) delete prefs.agentSymbol;
    if (patch.graphFollow) {
      const changed = hub.followMode !== patch.graphFollow;
      hub.followMode = patch.graphFollow;
      if (changed && patch.graphFollow === "focus") hub.refresh({ force: true });
    }
    send(res, 200, prefs);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/attach") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.sessionId) {
      hub.select(body.sessionId);
      writePrefs({ sessionId: body.sessionId });
    }
    send(res, 200, hub.snapshot());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root") {
    const body = await readBody(req);
    let next = workspaceRoot;
    try {
      next = JSON.parse(body).path || next;
    } catch {
      next = body.trim() || next;
    }
    const resolved = setRoot(next);
    if (!resolved) {
      send(res, 400, { error: "directory not found" });
      return;
    }
    send(res, 200, { root: workspaceRoot, name: folderName(workspaceRoot, workspaceRoot) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/children") {
    const dir = url.searchParams.get("path") || workspaceRoot;
    const resolved = safeResolve(dir);
    if (!resolved) {
      send(res, 404, { error: "not found" });
      return;
    }
    send(res, 200, {
      path: resolved,
      name: folderName(resolved, workspaceRoot),
      children: listFolders(resolved),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":\n\n");
    clients.add(res);
    const snap = hub.snapshot();
    res.write(`data: ${JSON.stringify({ type: "snapshot", ...snap, name: snap.root ? folderName(snap.root, snap.root) : folderName(workspaceRoot, workspaceRoot) })}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/hook" || url.pathname === "/api/visit")) {
    const body = await readBody(req);
    send(res, 200, handleHookPayload(body));
    return;
  }

  if (req.method === "GET" && serveStatic(req, res, url)) return;

  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  writePid();
  try {
    installHook();
  } catch (err) {
    console.error("Could not install Plexus hook:", err.message);
  }
  hub.start();
  const snap = hub.snapshot();
  if (snap.root) workspaceRoot = snap.root;
  console.log(`Plexus hud http://${HOST}:${PORT}`);
  if (snap.sessionTitle) console.log(`Attached ${snap.sessionTitle} · ${snap.root}`);
  else console.log(`Watching ${workspaceRoot}`);
});

setInterval(() => {
  for (const client of clients) {
    try {
      client.write(":\n\n");
    } catch {
      clients.delete(client);
    }
  }
}, 15000).unref();
