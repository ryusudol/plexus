import { pathUnder } from "./under.ts";

function isGlobbishPart(part: string): boolean {
  return part === "**" || /[*?{\[]/.test(part);
}

export function parentFolder(filePath: string, sep = "/"): string {
  if (!filePath) return sep === "\\" ? filePath : "/";
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return sep === "\\" ? filePath : "/";
  return normalized.slice(0, idx);
}

export function segmentsFrom(root: string | null | undefined, folderPath: string | null | undefined): Array<{ name: string; path: string }> {
  if (!folderPath) return [];
  const normRoot = (root || "/").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const normPath = folderPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normPath === normRoot) return [];
  if (!pathUnder(normRoot, normPath)) return [];
  const rest = normPath.slice(normRoot.length).replace(/^\//, "");
  if (!rest) return [];
  const parts = rest.split("/").filter(Boolean);
  const out: Array<{ name: string; path: string }> = [];
  let cursor = normRoot;
  for (const part of parts) {
    if (isGlobbishPart(part)) break;
    cursor = `${cursor}/${part}`;
    out.push({ name: part, path: cursor });
  }
  return out;
}
