import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveBrowserScript, transpileBrowserTs } from "./transpile.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | number> = {},
): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  { root, publicDir, libDir }: { root: string; publicDir: string; libDir: string },
): boolean {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const trimmed = rel.replace(/^\/+/, "");
  const filePath = rel.startsWith("/lib/") ? path.join(root, trimmed) : path.join(publicDir, trimmed);
  let resolved = path.resolve(filePath);
  const allowed = rel.startsWith("/lib/") ? libDir : publicDir;
  if (resolved !== allowed && !resolved.startsWith(allowed + path.sep)) {
    send(res, 403, { error: "forbidden" });
    return true;
  }
  resolved = resolveBrowserScript(resolved);
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const ext = path.extname(resolved);
  if (ext === ".ts") {
    const body = transpileBrowserTs(resolved);
    if (body == null) return false;
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
    return true;
  }
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(resolved).pipe(res);
  return true;
}
