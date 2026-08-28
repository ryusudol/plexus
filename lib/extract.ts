import { isRecord } from "./record.ts";
import type { ParsedVisit, Provider, SessionHint, Visit } from "./types.ts";
import { pathUnder } from "./under.ts";

const FILE_KEYS = [
  "target_file",
  "targetFile",
  "file_path",
  "filePath",
];

const SHELL_TOOLS =
  /^(run_terminal_command|Bash|bash|Shell|shell|exec|local_shell)$/i;

const DIR_KEYS = [
  "target_directory",
  "targetDirectory",
];

const PATH_KEYS = [...FILE_KEYS, ...DIR_KEYS, "path", "cwd"];

export type VisitEvent = {
  provider?: string;
  transcript_path?: string;
  transcriptPath?: string;
  source?: string;
  toolName?: string;
  tool_name?: string;
  name?: string;
  toolInput?: unknown;
  tool_input?: unknown;
  arguments?: unknown;
  toolArgs?: unknown;
  workspaceRoot?: string | null;
  workspace_root?: string;
  cwd?: string;
  sessionId?: string;
  session_id?: string;
  agentId?: string;
  subagentType?: string;
  subagent_type?: string;
  session_relationship?: string;
  hookEventName?: string;
  hook_event_name?: string;
  type?: string;
  path?: string;
  folderPath?: string;
  locations?: Array<{ path?: string } | null | undefined>;
  timestamp?: string;
  ts?: string;
  pid?: number;
};

export type ExtractVisitOptions = {
  sep?: string;
  assumeFile?: boolean | null;
};

function firstString(obj: unknown, keys: string[]): string | null {
  if (!isRecord(obj)) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isGlobbishPart(part: string): boolean {
  return part === "**" || /[*?{\[]/.test(part);
}

function isGlobbish(value: unknown): boolean {
  return String(value)
    .replace(/\\/g, "/")
    .split("/")
    .some((part) => part && isGlobbishPart(part));
}

export function dropGlobSegments(value: unknown): string | null {
  if (!value) return null;
  const normalized = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return null;
  const isAbs = normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized);
  const parts = normalized.split("/");
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === "" && i === 0 && isAbs) {
      kept.push("");
      continue;
    }
    if (!part || part === ".") continue;
    if (isGlobbishPart(part)) break;
    kept.push(part);
  }
  if (kept.length === 0) return null;
  if (kept.length === 1 && kept[0] === "") return "/";
  return kept.join("/") || null;
}

function looksLikeFile(value: unknown): boolean {
  if (isGlobbish(value)) return false;
  const base = String(value).replace(/\\/g, "/").split("/").pop() || "";
  if (!base || base === "." || base === "..") return false;
  return base.includes(".") && !base.startsWith(".");
}

function pushPath(into: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const stem = dropGlobSegments(trimmed);
  if (stem) into.push(stem);
}

function collectPathStrings(input: unknown, into: string[], depth = 0): void {
  if (depth > 4 || input == null) return;
  if (typeof input === "string") {
    const parsed = parseMaybeJson(input);
    if (parsed) {
      collectPathStrings(parsed, into, depth + 1);
      return;
    }
    pushPath(into, input);
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) collectPathStrings(item, into, depth + 1);
    return;
  }
  if (!isRecord(input)) return;
  for (const key of PATH_KEYS) pushPath(into, input[key]);
  pushPath(into, input.glob);
  pushPath(into, input.glob_pattern);
  if (typeof input.patch === "string") collectApplyPatchPaths(input.patch, into);
  if (typeof input.command === "string") collectApplyPatchPaths(input.command, into);
}

export function isShellTool(name: unknown): boolean {
  return SHELL_TOOLS.test(String(name || "").trim());
}

export function collectApplyPatchPaths(text: unknown, into: string[] = []): string[] {
  if (typeof text !== "string" || !text.includes("***")) return into;
  const re = /^\*\*\* (?:Add|Update|Delete|Move) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const value = match[1].trim();
    if (value) pushPath(into, value.split(/\s+/)[0]);
  }
  return into;
}

export function inferProvider(event: unknown): Provider {
  if (!isRecord(event)) return "grok";
  if (event.provider === "claude" || event.provider === "codex" || event.provider === "grok") {
    return event.provider;
  }
  const src = `${event.transcript_path || ""} ${event.transcriptPath || ""} ${event.source || ""}`;
  if (src.includes(".claude")) return "claude";
  if (src.includes(".codex")) return "codex";
  const name = event.tool_name || event.toolName || event.name || "";
  if (/^(Read|Write|Edit|Glob|NotebookEdit|Task|WebFetch|WebSearch)$/.test(String(name))) return "claude";
  if (/^(apply_patch|local_shell)$/i.test(String(name))) return "codex";
  return "grok";
}

export function parentFolder(filePath: string, sep = "/"): string {
  if (!filePath) return sep === "\\" ? filePath : "/";
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return sep === "\\" ? filePath : "/";
  return normalized.slice(0, idx);
}

export function folderOf(pathValue: string | null | undefined, isFile: boolean, sep = "/"): string | null {
  if (!pathValue) return null;
  const normalized = pathValue.replace(/\\/g, "/");
  if (isFile) return parentFolder(normalized, sep);
  return normalized.replace(/\/+$/, "") || "/";
}

/**
 * Pull the workspace folder the agent actually touched from a hook
 * payload or a replayed tool call.
 */
export function extractVisit(
  event: VisitEvent | null | undefined,
  { sep = "/", assumeFile = null }: ExtractVisitOptions = {},
): Visit | null {
  if (!event || typeof event !== "object") return null;

  const toolName =
    event.toolName ||
    event.tool_name ||
    event.name ||
    "";
  if (isShellTool(toolName)) return null;
  const toolInput =
    parseMaybeJson(event.toolInput) ||
    parseMaybeJson(event.tool_input) ||
    parseMaybeJson(event.arguments) ||
    parseMaybeJson(event.toolArgs) ||
    {};

  const workspaceRoot =
    event.workspaceRoot ||
    event.workspace_root ||
    event.cwd ||
    null;

  const agentId =
    event.sessionId ||
    event.session_id ||
    event.agentId ||
    "main";

  const agentLabel =
    event.subagentType ||
    event.subagent_type ||
    (event.session_relationship === "primary" ? "main" : null) ||
    (typeof toolName === "string" && toolName ? "agent" : "main");

  const hookEvent =
    event.hookEventName ||
    event.hook_event_name ||
    event.type ||
    "";

  const candidates: string[] = [];
  collectPathStrings(toolInput, candidates);
  pushPath(candidates, event.path);
  pushPath(candidates, event.folderPath);
  if (typeof event.arguments === "string") collectApplyPatchPaths(event.arguments, candidates);
  if (Array.isArray(event.locations)) {
    for (const loc of event.locations) {
      if (loc && typeof loc.path === "string") pushPath(candidates, loc.path);
    }
  }

  const unique = [...new Set(candidates.filter(Boolean))];
  const toolInputRec = isRecord(toolInput) ? toolInput : {};
  const globRaw = [toolInputRec.glob, toolInputRec.glob_pattern, event.path, event.folderPath].filter(
    (value) => typeof value === "string" && isGlobbish(value),
  );
  if (!unique.length && !hookEvent && !globRaw.length) return null;

  const dirHint = dropGlobSegments(firstString(toolInput, DIR_KEYS));
  const fileHint = firstString(toolInput, FILE_KEYS);

  let filePath: string | null = fileHint && !isGlobbish(fileHint) ? fileHint : null;
  let folderPath: string | null = dirHint;

  const listLike = /list_dir|ListDir|Glob/i.test(toolName);
  const fileLike = /read_file|search_replace|write|Read|Edit|Write|apply_patch/i.test(toolName);

  if (!folderPath && unique.length) {
    const chosen = unique[0];
    const treatAsFile =
      !listLike &&
      (assumeFile === true ||
        fileLike ||
        Boolean(fileHint) ||
        looksLikeFile(chosen));
    if (treatAsFile) {
      filePath = filePath || chosen;
      folderPath = folderOf(chosen, true, sep);
    } else {
      folderPath = folderOf(chosen, false, sep);
    }
  }

  folderPath = dropGlobSegments(folderPath);
  if (filePath && isGlobbish(filePath)) filePath = null;

  if (
    !folderPath &&
    workspaceRoot &&
    (globRaw.length || hookEvent === "session_start" || hookEvent === "SessionStart")
  ) {
    folderPath = workspaceRoot.replace(/\\/g, "/");
  }

  if (!folderPath) {
    return {
      kind: hookEvent || "event",
      toolName: toolName || null,
      agentId,
      agentLabel,
      workspaceRoot,
      folderPath: null,
      filePath: filePath || null,
      ts: event.timestamp || event.ts || null,
    };
  }

  if (workspaceRoot && folderPath && !folderPath.startsWith("/") && !/^[A-Za-z]:/.test(folderPath)) {
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    folderPath = `${root}/${folderPath.replace(/^\.\//, "")}`;
    if (filePath && !filePath.startsWith("/")) {
      filePath = `${root}/${filePath.replace(/^\.\//, "")}`;
    }
  }

  return {
    kind: hookEvent || "visit",
    toolName: toolName || null,
    agentId,
    agentLabel,
    workspaceRoot: workspaceRoot ? workspaceRoot.replace(/\\/g, "/") : null,
    folderPath: folderPath.replace(/\\/g, "/"),
    filePath: filePath ? filePath.replace(/\\/g, "/") : null,
    ts: event.timestamp || event.ts || new Date().toISOString(),
  };
}

/**
 * Map one ACP `updates.jsonl` record onto a folder visit.
 */
export function visitFromAcpRecord(record: unknown, session: SessionHint = {}): ParsedVisit | null {
  const rec = isRecord(record) ? record : null;
  const params = isRecord(rec?.params) ? rec.params : null;
  const updateRaw = params?.update || rec?.update || record;
  const update = isRecord(updateRaw) ? updateRaw : null;
  if (!update) return null;
  const kind = update.sessionUpdate;
  if (kind !== "tool_call" && kind !== "tool_call_update") return null;
  const meta = isRecord(update._meta) ? update._meta : null;
  const toolMeta = isRecord(meta?.["x.ai/tool"]) ? meta["x.ai/tool"] : {};
  const toolNameGuess = (isRecord(toolMeta) && typeof toolMeta.name === "string" && toolMeta.name) ||
    (typeof update.title === "string" ? update.title : "") ||
    "";
  if (isShellTool(toolNameGuess)) return null;

  const tool = isRecord(toolMeta) ? toolMeta : {};
  const locations = Array.isArray(update.locations) ? update.locations : [];
  let titlePath: string | null = null;
  if (typeof update.title === "string") {
    const match = update.title.match(/`([^`]+)`/);
    if (match) titlePath = match[1];
  }

  const firstLoc = isRecord(locations[0]) ? locations[0] : null;
  const locPath = typeof firstLoc?.path === "string" ? firstLoc.path : null;
  const visit = extractVisit({
    toolName: (typeof tool.name === "string" && tool.name) || (typeof update.title === "string" ? update.title : "") || "",
    toolInput: update.rawInput || tool.input || {},
    path: locPath || titlePath || undefined,
    locations: locations.filter(isRecord).map((loc) => ({
      path: typeof loc.path === "string" ? loc.path : undefined,
    })),
    sessionId: session.session_id || session.sessionId,
    workspaceRoot: session.cwd,
    timestamp: typeof rec?.timestamp === "string" ? rec.timestamp : typeof rec?.ts === "string" ? rec.ts : undefined,
    subagentType: session.label || session.agentLabel,
  });
  if (!visit?.folderPath) return null;
  return {
    toolCallId: typeof update.toolCallId === "string" ? update.toolCallId : null,
    kind: String(kind),
    visit,
  };
}

function claudeBlocks(record: unknown): unknown[] {
  const rec = isRecord(record) ? record : null;
  const message = isRecord(rec?.message) ? rec.message : null;
  const content = message?.content ?? rec?.content;
  if (Array.isArray(content)) return content;
  return [];
}

export function visitFromClaudeRecord(record: unknown, session: SessionHint = {}): ParsedVisit[] {
  if (!isRecord(record)) return [];
  if (record.type && record.type !== "assistant") return [];
  const out: ParsedVisit[] = [];
  for (const block of claudeBlocks(record)) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    if (isShellTool(block.name)) continue;
    const visit = extractVisit({
      toolName: typeof block.name === "string" ? block.name : "",
      toolInput: block.input || {},
      sessionId: session.session_id || session.sessionId || (typeof record.sessionId === "string" ? record.sessionId : undefined),
      workspaceRoot: session.cwd || (typeof record.cwd === "string" ? record.cwd : undefined),
      timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
      subagentType: session.label || "claude",
    });
    if (!visit?.folderPath) continue;
    out.push({
      toolCallId: typeof block.id === "string" ? block.id : null,
      kind: "tool_use",
      visit,
    });
  }
  return out;
}

export function visitFromCodexRecord(record: unknown, session: SessionHint = {}): ParsedVisit | null {
  if (!isRecord(record)) return null;
  const payload = isRecord(record.payload) ? record.payload : record;
  const kind = payload.type || record.type;
  if (kind === "local_shell_call") return null;
  if (kind !== "function_call" && kind !== "custom_tool_call") return null;
  const name = typeof payload.name === "string" ? payload.name : "";
  if (isShellTool(name)) return null;
  const visit = extractVisit({
    toolName: name,
    toolInput: payload.arguments || payload.input || {},
    arguments: payload.arguments,
    sessionId: session.session_id || session.sessionId,
    workspaceRoot: session.cwd,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    subagentType: session.label || "codex",
  });
  if (!visit?.folderPath) return null;
  return {
    toolCallId:
      (typeof payload.call_id === "string" && payload.call_id) ||
      (typeof payload.id === "string" && payload.id) ||
      null,
    kind: String(kind),
    visit,
  };
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
