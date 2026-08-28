import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { HOST, PORT } from "../lib/config.ts";
import { extractVisit, inferProvider, type VisitEvent } from "../lib/extract.ts";
import { collectStream, errMessage, repoRoot } from "../lib/node.ts";
import { plexusDir } from "../lib/paths.ts";
import type { HubEvent } from "../lib/types.ts";
import { installClaudeHooks } from "./claude.ts";
import { installCodexHooks } from "./codex.ts";
import { folderName, listFolders } from "./fs-tree.ts";
import { installGrokHooks } from "./hooks.ts";
import { readPrefs, sanitizePrefs, writePrefs } from "./prefs.ts";
import { SessionHub } from "./sessions.ts";
import { send, serveStatic } from "./static.ts";

const ROOT = repoRoot(import.meta.url);
const PUBLIC = path.join(ROOT, "public");
const LIB = path.join(ROOT, "lib");

const clients = new Set<http.ServerResponse>();
let workspaceRoot = process.env.PLEXUS_ROOT || process.env.GROK_EXPLORE_ROOT || process.cwd();
const recentVisit = new Map<string, number>();

function readBody(req: http.IncomingMessage): Promise<string> {
  return collectStream(req).then((buf) => buf.toString("utf8"));
}

function broadcast(event: HubEvent): void {
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

function safeResolve(input: string | null | undefined): string | null {
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

function setRoot(next: string | null | undefined, { emit = true } = {}): string | null {
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

function installHook(): void {
  const launcher = path.join(ROOT, "bin", "plexus.ts");
  const url = installGrokHooks(ROOT, process.execPath, launcher);
  const hookBin = path.join(ROOT, "bin", "plexus-hook.ts");
  try {
    installClaudeHooks({
      nodePath: process.execPath,
      launcher,
      hookBin,
      url,
    });
  } catch (err) {
    console.error("Could not install Claude Code hook:", errMessage(err));
  }
  try {
    installCodexHooks({
      nodePath: process.execPath,
      launcher,
      hookBin,
    });
  } catch (err) {
    console.error("Could not install Codex hook:", errMessage(err));
  }
}

function handleHookPayload(payload: string | VisitEvent): {
  ok: boolean;
  decision?: string;
  hookSpecificOutput?: Record<string, string>;
} {
  let event: VisitEvent;
  try {
    event = (typeof payload === "string" ? JSON.parse(payload || "{}") : payload) as VisitEvent;
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

function writePid(): void {
  const dir = plexusDir();
  fs.writeFileSync(path.join(dir, "backend.pid"), String(process.pid));
  fs.writeFileSync(path.join(dir, "backend.port"), String(PORT));
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

const staticDirs = { root: ROOT, publicDir: PUBLIC, libDir: LIB };

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
      ...snap,
      root,
      name: folderName(root, root),
      sep: path.sep,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/prefs") {
    send(res, 200, readPrefs());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prefs") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const patch = sanitizePrefs(body);
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
    const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string };
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
      next = (JSON.parse(body) as { path?: string }).path || next;
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
    const name = snap.root ? folderName(snap.root, snap.root) : folderName(workspaceRoot, workspaceRoot);
    res.write(`data: ${JSON.stringify({ type: "snapshot", ...snap, name })}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/hook" || url.pathname === "/api/visit")) {
    const body = await readBody(req);
    send(res, 200, handleHookPayload(body));
    return;
  }

  if (req.method === "GET" && serveStatic(req, res, url, staticDirs)) return;

  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  writePid();
  try {
    installHook();
  } catch (err) {
    console.error("Could not install Plexus hook:", errMessage(err));
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
