import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const cache = new Map<string, { mtime: number; body: string }>();

function rewriteTsSpecifiers(source: string): string {
  return source
    .replace(/from\s+(["'])([^"']+)\.ts\1/g, "from $1$2.js$1")
    .replace(/import\s*\(\s*(["'])([^"']+)\.ts\1\s*\)/g, "import($1$2.js$1)");
}

export function transpileBrowserTs(filePath: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  const hit = cache.get(filePath);
  if (hit && hit.mtime === st.mtimeMs) return hit.body;
  const source = fs.readFileSync(filePath, "utf8");
  const body = rewriteTsSpecifiers(stripTypeScriptTypes(source));
  cache.set(filePath, { mtime: st.mtimeMs, body });
  return body;
}

/** Map a requested .js path onto a sibling .ts source when the JS file is absent. */
export function resolveBrowserScript(resolved: string): string {
  if (resolved.endsWith(".js")) {
    const tsPath = `${resolved.slice(0, -3)}.ts`;
    if (!fs.existsSync(resolved) && fs.existsSync(tsPath)) return tsPath;
  }
  return resolved;
}
