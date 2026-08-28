import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** App state lives in ~/.plexus. Copy ~/.grok/explore once if that's all that exists. */
export function plexusDir() {
  const next = path.join(os.homedir(), ".plexus");
  const prev = path.join(os.homedir(), ".grok", "explore");
  if (!fs.existsSync(next) && fs.existsSync(prev)) {
    try {
      fs.cpSync(prev, next, { recursive: true });
    } catch {
      // start empty
    }
  }
  fs.mkdirSync(next, { recursive: true });
  return next;
}
