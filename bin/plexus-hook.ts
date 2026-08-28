#!/usr/bin/env node
import http from "node:http";
import { HOST, PORT } from "../lib/config.ts";
import { tryParseJson } from "../lib/node.ts";

const sourceFlag = process.argv.includes("--source")
  ? process.argv[process.argv.indexOf("--source") + 1]
  : "";
const provider = sourceFlag === "claude" || sourceFlag === "codex" ? sourceFlag : null;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function post(body: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/hook",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 800,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

const raw = await readStdin();
const parsed = raw.trim() ? tryParseJson<Record<string, unknown>>(raw) : {};
const event = parsed && typeof parsed === "object" ? parsed : {};
if (provider) event.provider = provider;
if (!event.pid && process.ppid) event.pid = process.ppid;
await post(JSON.stringify(event));
process.stdout.write(`${JSON.stringify({ ok: true, decision: "allow" })}\n`);
