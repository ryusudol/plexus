import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRow } from "./types.ts";

export function repoRoot(metaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function tryParseJson<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Read the first `limit` JSONL records from the start of a file. */
export function peekJsonl(file: string, limit = 40): Record<string, unknown>[] {
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.slice(0, n).toString("utf8");
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip
    }
    if (rows.length >= limit) break;
  }
  return rows;
}

export function newestById(rows: SessionRow[]): SessionRow[] {
  const byId = new Map<string, SessionRow>();
  for (const row of rows) {
    const prev = byId.get(row.session_id);
    if (!prev || (row.mtime || 0) >= (prev.mtime || 0)) byId.set(row.session_id, row);
  }
  return [...byId.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

export function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
