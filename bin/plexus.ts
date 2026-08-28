#!/usr/bin/env node
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { HOST, PORT } from "../lib/config.ts";
import { pidAlive, repoRoot, sleep, tryParseJson } from "../lib/node.ts";
import { plexusDir } from "../lib/paths.ts";

const ROOT = repoRoot(import.meta.url);
const STATE = plexusDir();
const HUD_BIN = path.join(ROOT, "macos", ".build", "release", "PlexusHUD");
const HUD_APP = path.join(ROOT, "macos", "dist", "Plexus.app");
const SERVER = path.join(ROOT, "server", "index.ts");

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("-")) || "open";
const flags = new Set(args.filter((a) => a.startsWith("-")));

function sendHud(command: string): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, "hud-cmd"), command);
}

function get(pathname: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: pathname, timeout: 400 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(tryParseJson<Record<string, unknown>>(Buffer.concat(chunks).toString("utf8")));
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function readPid(name: string): number {
  try {
    return Number(fs.readFileSync(path.join(STATE, name), "utf8").trim());
  } catch {
    return 0;
  }
}

function spawnDetached(bin: string, spawnArgs: string[], extra: SpawnOptions = {}) {
  const child = spawn(bin, spawnArgs, {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    ...extra,
  });
  child.unref();
  return child;
}

async function waitForHealth(tries = 40): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < tries; i += 1) {
    const health = await get("/api/health");
    if (health?.ok) return health;
    await sleep(100);
  }
  return null;
}

async function ensureBackend(): Promise<Record<string, unknown> | null> {
  const health = await get("/api/health");
  if (health?.ok) return health;
  fs.mkdirSync(STATE, { recursive: true });
  spawnDetached(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
  });
  const ready = await waitForHealth();
  if (!ready) {
    console.error("Plexus backend failed to start");
    process.exit(1);
  }
  return ready;
}

function hudRunning(): boolean {
  return pidAlive(readPid("hud.pid"));
}

async function ensureHud({ hide = false } = {}): Promise<void> {
  try {
    const pending = fs.readFileSync(path.join(STATE, "hud-cmd"), "utf8").trim();
    if (pending === "quit") fs.unlinkSync(path.join(STATE, "hud-cmd"));
  } catch {
    // none
  }
  if (hudRunning()) {
    if (!hide) sendHud("show");
    return;
  }
  const appExists = fs.existsSync(path.join(HUD_APP, "Contents", "MacOS", "PlexusHUD"));
  if (!appExists && !fs.existsSync(HUD_BIN)) {
    console.error("HUD missing. Build it with: npm run build:hud");
    console.error(`Backend is up at http://${HOST}:${PORT}`);
    return;
  }
  fs.mkdirSync(STATE, { recursive: true });
  const url = `http://${HOST}:${PORT}${flags.has("--demo") ? "?demo=1" : ""}`;
  const launchArgs = ["--url", url];
  if (hide) launchArgs.push("--hide");
  if (appExists) {
    spawnDetached("open", ["-n", "-a", HUD_APP, "--args", ...launchArgs]);
  } else {
    spawnDetached(HUD_BIN, launchArgs);
  }
  for (let i = 0; i < 25; i += 1) {
    if (hudRunning()) return;
    await sleep(120);
  }
}

function killPid(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function quitAll(): Promise<void> {
  sendHud("quit");
  killPid(readPid("backend.pid"));
  killPid(readPid("hud.pid"));
  await sleep(300);
  try {
    fs.unlinkSync(path.join(STATE, "hud-cmd"));
  } catch {
    // none
  }
}

if (cmd === "ensure" || flags.has("--ensure")) {
  await ensureBackend();
  await ensureHud({ hide: true });
  process.exit(0);
}

if (cmd === "hide" || flags.has("--hide")) {
  sendHud("toggle");
  process.exit(0);
}

if (cmd === "toggle") {
  await ensureBackend();
  if (hudRunning()) sendHud("toggle");
  else await ensureHud();
  process.exit(0);
}

if (cmd === "quit" || cmd === "stop") {
  await quitAll();
  process.exit(0);
}

if (cmd === "demo") {
  flags.add("--demo");
  await ensureBackend();
  await ensureHud();
  process.exit(0);
}

await ensureBackend();
await ensureHud({ hide: !flags.has("--demo") });
