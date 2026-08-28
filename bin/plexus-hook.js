#!/usr/bin/env node
import http from "node:http";

const PORT = Number(process.env.PORT || 7733);
const HOST = "127.0.0.1";
const sourceFlag = process.argv.includes("--source")
  ? process.argv[process.argv.indexOf("--source") + 1]
  : "";
const provider = sourceFlag === "claude" || sourceFlag === "codex" ? sourceFlag : null;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function post(body) {
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
        res.on("end", resolve);
      },
    );
    req.on("error", resolve);
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

const raw = await readStdin();
let event = {};
try {
  event = raw.trim() ? JSON.parse(raw) : {};
} catch {
  event = {};
}
if (provider) event.provider = provider;
if (!event.pid && process.ppid) event.pid = process.ppid;
await post(JSON.stringify(event));
process.stdout.write(`${JSON.stringify({ ok: true, decision: "allow" })}\n`);
