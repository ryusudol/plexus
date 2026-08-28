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

function firstString(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseMaybeJson(value) {
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

function isGlobbishPart(part) {
  return part === "**" || /[*?{\[]/.test(part);
}

function isGlobbish(value) {
  return String(value)
    .replace(/\\/g, "/")
    .split("/")
    .some((part) => part && isGlobbishPart(part));
}

export function dropGlobSegments(value) {
  if (!value) return null;
  const normalized = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return null;
  const isAbs = normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized);
  const parts = normalized.split("/");
  const kept = [];
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

function looksLikeFile(value) {
  if (isGlobbish(value)) return false;
  const base = String(value).replace(/\\/g, "/").split("/").pop() || "";
  if (!base || base === "." || base === "..") return false;
  return base.includes(".") && !base.startsWith(".");
}

function lookLikePath(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.includes("\n") || v.length >= 512) return false;
  if (isGlobbish(v)) return false;
  if (/[;&|<>`$]/.test(v) || v.includes(" && ")) return false;
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return true;
  if (v.startsWith("./") || v.startsWith("../")) return true;
  return v.includes("/") && !v.includes(" ");
}

function pushPath(into, value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const stem = dropGlobSegments(trimmed);
  if (stem) into.push(stem);
}

function collectPathStrings(input, into, depth = 0) {
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
  if (typeof input !== "object") return;
  for (const key of PATH_KEYS) pushPath(into, input[key]);
  pushPath(into, input.glob);
  pushPath(into, input.glob_pattern);
  if (typeof input.patch === "string") collectApplyPatchPaths(input.patch, into);
  if (typeof input.command === "string") collectApplyPatchPaths(input.command, into);
}

export function isShellTool(name) {
  return SHELL_TOOLS.test(String(name || "").trim());
}

export function collectApplyPatchPaths(text, into = []) {
  if (typeof text !== "string" || !text.includes("***")) return into;
  const re = /^\*\*\* (?:Add|Update|Delete|Move) File: (.+)$/gm;
  let match;
  while ((match = re.exec(text))) {
    const value = match[1].trim();
    if (value) pushPath(into, value.split(/\s+/)[0]);
  }
  return into;
}

export function inferProvider(event) {
  if (!event || typeof event !== "object") return "grok";
  if (event.provider === "claude" || event.provider === "codex" || event.provider === "grok") {
    return event.provider;
  }
  const src = `${event.transcript_path || ""} ${event.transcriptPath || ""} ${event.source || ""}`;
  if (src.includes(".claude")) return "claude";
  if (src.includes(".codex")) return "codex";
  const name = event.tool_name || event.toolName || event.name || "";
  if (/^(Read|Write|Edit|Glob|NotebookEdit|Task|WebFetch|WebSearch)$/.test(name)) return "claude";
  if (/^(apply_patch|local_shell)$/i.test(name)) return "codex";
  return "grok";
}

export function parentFolder(filePath, sep = "/") {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return sep === "\\" ? filePath : "/";
  return normalized.slice(0, idx);
}

export function folderOf(pathValue, isFile, sep = "/") {
  if (!pathValue) return null;
  const normalized = pathValue.replace(/\\/g, "/");
  if (isFile) return parentFolder(normalized, sep);
  return normalized.replace(/\/+$/, "") || "/";
}

/**
 * Pull the workspace folder the agent actually touched from a hook
 * payload or a replayed tool call.
 */
export function extractVisit(event, { sep = "/", assumeFile = null } = {}) {
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

  const candidates = [];
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
  const globRaw = [toolInput.glob, toolInput.glob_pattern, event.path, event.folderPath].filter(
    (value) => typeof value === "string" && isGlobbish(value),
  );
  if (!unique.length && !hookEvent && !globRaw.length) return null;

  const dirHint = dropGlobSegments(firstString(toolInput, DIR_KEYS));
  const fileHint = firstString(toolInput, FILE_KEYS);

  let filePath = fileHint && !isGlobbish(fileHint) ? fileHint : null;
  let folderPath = dirHint;

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
export function visitFromAcpRecord(record, session = {}) {
  const update = record?.params?.update || record?.update || record;
  if (!update || typeof update !== "object") return null;
  const kind = update.sessionUpdate;
  if (kind !== "tool_call" && kind !== "tool_call_update") return null;
  const toolNameGuess = ((update._meta && update._meta["x.ai/tool"]) || {}).name || update.title || "";
  if (isShellTool(toolNameGuess)) return null;

  const tool = (update._meta && update._meta["x.ai/tool"]) || {};
  const locations = Array.isArray(update.locations) ? update.locations : [];
  let titlePath = null;
  if (typeof update.title === "string") {
    const match = update.title.match(/`([^`]+)`/);
    if (match) titlePath = match[1];
  }

  const visit = extractVisit({
    toolName: tool.name || update.title || "",
    toolInput: update.rawInput || tool.input || {},
    path: locations[0]?.path || titlePath || null,
    locations,
    sessionId: session.session_id || session.sessionId,
    workspaceRoot: session.cwd,
    timestamp: record.timestamp || record.ts,
    subagentType: session.label || session.agentLabel,
  });
  if (!visit?.folderPath) return null;
  return {
    toolCallId: update.toolCallId || null,
    kind,
    visit,
  };
}

function claudeBlocks(record) {
  const content = record?.message?.content ?? record?.content;
  if (Array.isArray(content)) return content;
  return [];
}

export function visitFromClaudeRecord(record, session = {}) {
  if (!record || typeof record !== "object") return [];
  if (record.type && record.type !== "assistant") return [];
  const out = [];
  for (const block of claudeBlocks(record)) {
    if (!block || block.type !== "tool_use") continue;
    if (isShellTool(block.name)) continue;
    const visit = extractVisit({
      toolName: block.name || "",
      toolInput: block.input || {},
      sessionId: session.session_id || session.sessionId || record.sessionId,
      workspaceRoot: session.cwd || record.cwd,
      timestamp: record.timestamp,
      subagentType: session.label || "claude",
    });
    if (!visit?.folderPath) continue;
    out.push({ toolCallId: block.id || null, kind: "tool_use", visit });
  }
  return out;
}

export function visitFromCodexRecord(record, session = {}) {
  if (!record || typeof record !== "object") return null;
  const payload = record.payload && typeof record.payload === "object" ? record.payload : record;
  const kind = payload.type || record.type;
  if (kind === "local_shell_call") return null;
  if (kind !== "function_call" && kind !== "custom_tool_call") return null;
  const name = payload.name || "";
  if (isShellTool(name)) return null;
  const visit = extractVisit({
    toolName: name,
    toolInput: payload.arguments || payload.input || {},
    arguments: payload.arguments,
    sessionId: session.session_id || session.sessionId,
    workspaceRoot: session.cwd,
    timestamp: record.timestamp,
    subagentType: session.label || "codex",
  });
  if (!visit?.folderPath) return null;
  return {
    toolCallId: payload.call_id || payload.id || null,
    kind,
    visit,
  };
}

export function segmentsFrom(root, folderPath) {
  if (!folderPath) return [];
  const normRoot = (root || "/").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const normPath = folderPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normPath === normRoot) return [];
  if (!normPath.startsWith(`${normRoot}/`) && normPath !== normRoot) {
    return [];
  }
  const rest = normPath.slice(normRoot.length).replace(/^\//, "");
  if (!rest) return [];
  const parts = rest.split("/").filter(Boolean);
  const out = [];
  let cursor = normRoot;
  for (const part of parts) {
    if (isGlobbishPart(part)) break;
    cursor = `${cursor}/${part}`;
    out.push({ name: part, path: cursor });
  }
  return out;
}
