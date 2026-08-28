import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrcaFocus, OrcaPane } from "../lib/types.ts";

type OrcaPaneRecord = {
  providerSession?: { id?: string };
  tabId?: string;
  worktreeId?: string;
};

type OrcaWorkspace = {
  tabsByWorktree?: Record<string, Array<{ id?: string }>>;
  sleepingAgentSessionsByPaneKey?: Record<string, OrcaPaneRecord>;
  activeWorktreeId?: string;
  activeTabId?: string;
  activeTabIdByWorktree?: Record<string, string>;
  terminalLayoutsByTabId?: Record<string, { activeLeafId?: string }>;
};

type OrcaFile = {
  workspaceSession?: OrcaWorkspace;
  ui?: { lastActiveWorktreeId?: string };
};

export function orcaDataFiles(): string[] {
  if (process.env.ORCA_DATA_FILE) return [process.env.ORCA_DATA_FILE];
  const root = path.join(os.homedir(), "Library/Application Support/orca/profiles");
  const files: string[] = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const candidate = path.join(root, name, "orca-data.json");
      if (fs.existsSync(candidate)) files.push(candidate);
    }
  } catch {
    // none
  }
  return files;
}

function cwdFromWorktreeId(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const idx = key.indexOf("::");
  if (idx < 0) return null;
  return key.slice(idx + 2) || null;
}

function sessionIdFromOrcaWorkspace(ws: OrcaWorkspace = {}): string | null {
  const worktreeId = ws.activeWorktreeId || "";
  const tabId =
    ws.activeTabId ||
    (worktreeId && ws.activeTabIdByWorktree && ws.activeTabIdByWorktree[worktreeId]) ||
    null;
  if (!tabId) return null;
  const panes = ws.sleepingAgentSessionsByPaneKey || {};
  const layout = (ws.terminalLayoutsByTabId || {})[tabId] || {};
  const leafId = layout.activeLeafId;
  if (leafId) {
    const pane = panes[`${tabId}:${leafId}`];
    const id = pane?.providerSession?.id;
    if (typeof id === "string" && id) return id;
  }
  for (const pane of Object.values(panes)) {
    if (pane?.tabId === tabId && typeof pane?.providerSession?.id === "string") {
      return pane.providerSession.id;
    }
  }
  return null;
}

/**
 * Grok sessions currently attached to an open Orca tab.
 * Returns null when Orca state is missing so callers can fall back.
 */
export function readOrcaLivePanes(file?: string): Map<string, OrcaPane> | null {
  const files = file ? [file] : orcaDataFiles();
  if (!files.length) return null;
  const panes = new Map<string, OrcaPane>();
  let saw = false;
  for (const item of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(item, "utf8")) as OrcaFile;
      const ws = obj?.workspaceSession || {};
      saw = true;
      const openTabs = new Set<string>();
      for (const tabs of Object.values(ws.tabsByWorktree || {})) {
        if (!Array.isArray(tabs)) continue;
        for (const tab of tabs) {
          if (tab?.id) openTabs.add(tab.id);
        }
      }
      for (const pane of Object.values(ws.sleepingAgentSessionsByPaneKey || {})) {
        const id = pane?.providerSession?.id;
        if (typeof id !== "string" || !id) continue;
        if (pane?.tabId && openTabs.size && !openTabs.has(pane.tabId)) continue;
        const cwd = cwdFromWorktreeId(pane?.worktreeId);
        const prev = panes.get(id);
        if (!prev || (cwd && !prev.cwd)) panes.set(id, { sessionId: id, cwd, tabId: pane?.tabId || null });
      }
    } catch {
      // skip unreadable profiles
    }
  }
  return saw ? panes : null;
}

export function readOrcaFocus(file?: string): OrcaFocus | null {
  const files = file ? [file] : orcaDataFiles();
  let best: OrcaFocus | null = null;
  let bestM = 0;
  for (const item of files) {
    try {
      const m = fs.statSync(item).mtimeMs;
      const obj = JSON.parse(fs.readFileSync(item, "utf8")) as OrcaFile;
      const ws = obj?.workspaceSession || {};
      const worktreeId = ws.activeWorktreeId || obj?.ui?.lastActiveWorktreeId || "";
      const cwd = cwdFromWorktreeId(worktreeId);
      const sessionId = sessionIdFromOrcaWorkspace(ws);
      if ((cwd || sessionId) && m >= bestM) {
        best = { cwd, sessionId };
        bestM = m;
      }
    } catch {
      // skip
    }
  }
  return best;
}

export function readOrcaActiveCwd(file?: string): string | null {
  return readOrcaFocus(file)?.cwd || null;
}
