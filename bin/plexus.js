#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plexusDir } from "../lib/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 7733);
const HOST = "127.0.0.1";
const STATE = plexusDir();
const HUD_BIN = path.join(ROOT, "macos", ".build", "release", "PlexusHUD");
const HUD_APP = path.join(ROOT, "macos", "dist", "Plexus.app");
const SERVER = path.join(ROOT, "server", "index.js");

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("-")) || "open";
const flags = new Set(args.filter((a) => a.startsWith("-")));

function sendHud(command) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, "hud-cmd"), command);
}

function get(pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: pathname, timeout: 400 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(null);
          }
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

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(name) {
  try {
    return Number(fs.readFileSync(path.join(STATE, name), "utf8").trim());
  } catch {
    return 0;
  }
}

function spawnDetached(bin, spawnArgs, extra = {}) {
  const child = spawn(bin, spawnArgs, {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    ...extra,
  });
  child.unref();
  return child;
}

async function waitForHealth(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const health = await get("/api/health");
    if (health?.ok) return health;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function ensureBackend() {
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

function hudRunning() {
  const pid = readPid("hud.pid");
  return pidAlive(pid);
}

async function ensureHud({ hide = false } = {}) {
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
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function quitAll() {
  sendHud("quit");
  const backendPid = readPid("backend.pid");
  if (pidAlive(backendPid)) {
    try {
      process.kill(backendPid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const hudPid = readPid("hud.pid");
  if (pidAlive(hudPid)) {
    try {
      process.kill(hudPid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 300));
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
