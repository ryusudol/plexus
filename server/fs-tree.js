import fs from "node:fs";
import path from "node:path";

export const IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".cache",
  "vendor",
  ".pnpm-store",
]);

function isIgnored(name) {
  if (IGNORE.has(name)) return true;
  if (name === ".grok") return false;
  if (name.startsWith(".")) return true;
  return false;
}

function hasSubfolder(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (isIgnored(entry.name)) continue;
    return true;
  }
  return false;
}

export function listFolders(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (isIgnored(entry.name)) continue;
    const full = path.join(dir, entry.name);
    folders.push({
      name: entry.name,
      path: full,
      hasChildren: hasSubfolder(full),
    });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return folders;
}

export function folderName(dir, root) {
  if (dir === root) return path.basename(root) || root;
  return path.basename(dir);
}
