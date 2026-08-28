import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "../lib/node.ts";
import { plexusDir } from "../lib/paths.ts";
import type { Prefs } from "../lib/types.ts";

const PREFS_FILE = path.join(plexusDir(), "prefs.json");

export function readPrefs(): Prefs {
  return readJsonFile<Prefs>(PREFS_FILE, { accent: "#ff4fcb" });
}

export function writePrefs(next: Prefs): Prefs {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const prefs: Prefs = { ...readPrefs(), ...next };
  if (prefs.agentSymbol === null) delete prefs.agentSymbol;
  fs.writeFileSync(PREFS_FILE, `${JSON.stringify(prefs)}\n`);
  return prefs;
}
