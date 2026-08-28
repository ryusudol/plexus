import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "../lib/node.ts";
import { plexusDir } from "../lib/paths.ts";
import { isRecord } from "../lib/record.ts";
import type { Prefs } from "../lib/types.ts";

const PREFS_FILE = path.join(plexusDir(), "prefs.json");

export function readPrefs(): Prefs {
  return readJsonFile<Prefs>(PREFS_FILE, { accent: "#ff4fcb", shape: "neurons" });
}

export function writePrefs(next: Prefs): Prefs {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const prefs: Prefs = { ...readPrefs(), ...next };
  if (prefs.agentSymbol === null) delete prefs.agentSymbol;
  fs.writeFileSync(PREFS_FILE, `${JSON.stringify(prefs)}\n`);
  return prefs;
}

export function sanitizePrefs(body: unknown): Prefs {
  const patch: Prefs = {};
  if (!isRecord(body)) return patch;
  if (typeof body.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(body.accent)) {
    patch.accent = body.accent;
  }
  if (body.shape === "tree" || body.shape === "circle" || body.shape === "neurons") {
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
  return patch;
}
