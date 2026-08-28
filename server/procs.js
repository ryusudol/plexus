import { execFileSync } from "node:child_process";

const AGENT_BIN = /^(claude|codex|codex-cli)$/;

export function listAgentPids() {
  let text = "";
  try {
    text = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 400,
    });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!pid || command.includes("plexus")) continue;
    const base = command.split(/\s+/)[0].split("/").pop();
    if (AGENT_BIN.test(base)) pids.push(pid);
  }
  return pids;
}
