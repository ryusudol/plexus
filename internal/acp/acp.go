package acp

import (
	"github.com/ryusudol/plexus/internal/extract"
	"github.com/ryusudol/plexus/internal/jsonx"
)

func ParseLine(line string, session extract.SessionHint) *extract.ParsedVisit {
	record := jsonx.Parse(line)
	if record == nil {
		return nil
	}
	return extract.VisitFromAcpRecord(record, session)
}

func sessionUpdateOf(line string) map[string]any {
	record := jsonx.AsMap(jsonx.Parse(line))
	if record == nil {
		return nil
	}
	params := jsonx.AsMap(record["params"])
	var update any
	if params != nil && params["update"] != nil {
		update = params["update"]
	} else {
		update = record["update"]
	}
	return jsonx.AsMap(update)
}

func IsUserPromptEvent(line string) bool {
	update := sessionUpdateOf(line)
	if update == nil {
		return false
	}
	kind := jsonx.Str(update["sessionUpdate"])
	hook := jsonx.Str(update["event_name"])
	return kind == "user_message_chunk" || kind == "user_message" || hook == "user_prompt_submit"
}

func ParseSessionEvent(line string) string {
	update := sessionUpdateOf(line)
	if update == nil {
		return ""
	}
	kind := jsonx.Str(update["sessionUpdate"])
	hook := jsonx.Str(update["event_name"])
	if kind == "tool_call" || kind == "user_message_chunk" || kind == "user_message" ||
		kind == "agent_thought_chunk" || hook == "user_prompt_submit" || hook == "pre_tool_use" {
		return "busy"
	}
	if kind == "turn_completed" || hook == "stop" || hook == "Stop" ||
		hook == "stop_cancelled" || hook == "StopCancelled" {
		return "idle"
	}
	return ""
}
