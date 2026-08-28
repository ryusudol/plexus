import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST, PORT } from "../lib/config.ts";
import { readJsonFile } from "../lib/node.ts";

export type HookCommand = {
  type: string;
  command?: string;
  url?: string;
  timeout?: number;
};

export type HookGroup = {
  matcher?: string;
  hooks: HookCommand[];
};

export type HooksFile = {
  hooks: Record<string, HookGroup[]>;
};

export function hasPlexusLauncher(blob: string): boolean {
  return blob.includes("bin/plexus.ts");
}

/** Point leftover .js launcher commands at the TypeScript entrypoints. */
export function migrateLauncherCommands(hooks: Record<string, HookGroup[]>): boolean {
  let changed = false;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (typeof hook.command !== "string") continue;
        const next = hook.command
          .replaceAll("bin/plexus.js", "bin/plexus.ts")
          .replaceAll("plexus-hook.js", "plexus-hook.ts");
        if (next === hook.command) continue;
        hook.command = next;
        changed = true;
      }
    }
  }
  return changed;
}

export function ensureHookList(hooks: Record<string, HookGroup[]>, event: string): HookGroup[] {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  return hooks[event];
}

export function commandGroup(command: string, timeout: number): HookGroup {
  return { hooks: [{ type: "command", command, timeout }] };
}

export function loadHooksFile(file: string): HooksFile {
  const rec = readJsonFile<Record<string, unknown>>(file, {});
  const hooksRaw = rec.hooks;
  const hooks =
    hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, HookGroup[]>)
      : {};
  return { ...rec, hooks };
}

export function saveHooksFile(file: string, spec: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
}

export function installGrokHooks(root: string, nodePath: string, launcher: string): string {
  const hooksDir = path.join(os.homedir(), ".grok", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const url = `http://${HOST}:${PORT}/hook`;
  const spec = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `${nodePath} "${launcher}" --ensure`,
              timeout: 8,
            },
          ],
        },
      ],
      PreToolUse: [{ hooks: [{ type: "http", url, timeout: 2 }] }],
    },
  };
  const payload = `${JSON.stringify(spec, null, 2)}\n`;
  fs.writeFileSync(path.join(hooksDir, "plexus.json"), payload);
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "hooks", "plexus.json"), payload);
  for (const stale of ["grok-explore.json"]) {
    for (const dir of [hooksDir, path.join(root, "hooks")]) {
      try {
        fs.unlinkSync(path.join(dir, stale));
      } catch {
        // none
      }
    }
  }
  return url;
}
