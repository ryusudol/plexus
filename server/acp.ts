import { visitFromAcpRecord } from "../lib/extract.ts";
import { tryParseJson } from "../lib/node.ts";
import type { ParsedVisit, SessionRow } from "../lib/types.ts";

export function parseAcpLine(
  line: string,
  session: SessionRow | { session_id?: string; cwd?: string; label?: string },
): ParsedVisit | null {
  const record = tryParseJson(line);
  if (record == null) return null;
  return visitFromAcpRecord(record, session);
}

function sessionUpdateOf(line: string): Record<string, unknown> | null {
  const record = tryParseJson<Record<string, unknown>>(line);
  if (!record) return null;
  const params = record.params && typeof record.params === "object" ? (record.params as Record<string, unknown>) : null;
  const update = params?.update || record.update || null;
  return update && typeof update === "object" ? (update as Record<string, unknown>) : null;
}

export function isUserPromptEvent(line: string): boolean {
  const update = sessionUpdateOf(line);
  if (!update) return false;
  const kind = update.sessionUpdate;
  const hook = update.event_name;
  return kind === "user_message_chunk" || kind === "user_message" || hook === "user_prompt_submit";
}

export function parseSessionEvent(line: string): "busy" | "idle" | null {
  const update = sessionUpdateOf(line);
  if (!update) return null;
  const kind = update.sessionUpdate;
  const hook = update.event_name;
  if (
    kind === "tool_call" ||
    kind === "user_message_chunk" ||
    kind === "user_message" ||
    kind === "agent_thought_chunk" ||
    hook === "user_prompt_submit" ||
    hook === "pre_tool_use"
  ) {
    return "busy";
  }
  if (
    kind === "turn_completed" ||
    hook === "stop" ||
    hook === "Stop" ||
    hook === "stop_cancelled" ||
    hook === "StopCancelled"
  ) {
    return "idle";
  }
  return null;
}
