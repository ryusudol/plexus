package acp

import (
	"testing"

	"github.com/ryusudol/plexus/internal/extract"
)

func TestParseSessionEvent(t *testing.T) {
	cases := []struct {
		line string
		want string
	}{
		{`{"params":{"update":{"sessionUpdate":"user_message_chunk"}}}`, "busy"},
		{`{"params":{"update":{"sessionUpdate":"user_message"}}}`, "busy"},
		{`{"params":{"update":{"sessionUpdate":"tool_call"}}}`, "busy"},
		{`{"params":{"update":{"sessionUpdate":"agent_thought_chunk"}}}`, "busy"},
		{`{"params":{"update":{"event_name":"user_prompt_submit"}}}`, "busy"},
		{`{"params":{"update":{"event_name":"pre_tool_use"}}}`, "busy"},
		{`{"update":{"sessionUpdate":"turn_completed"}}`, "idle"},
		{`{"params":{"update":{"event_name":"stop"}}}`, "idle"},
		{`{"params":{"update":{"event_name":"Stop"}}}`, "idle"},
		{`{"params":{"update":{"event_name":"stop_cancelled"}}}`, "idle"},
		{`{"params":{"update":{"event_name":"StopCancelled"}}}`, "idle"},
		{`{"params":{"update":{"sessionUpdate":"unknown"}}}`, ""},
		{`{`, ""},
		{``, ""},
	}
	for _, tc := range cases {
		if got := ParseSessionEvent(tc.line); got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.line, got, tc.want)
		}
	}
}

func TestIsUserPromptEvent(t *testing.T) {
	if !IsUserPromptEvent(`{"params":{"update":{"sessionUpdate":"user_message_chunk"}}}`) {
		t.Fatal("chunk")
	}
	if !IsUserPromptEvent(`{"params":{"update":{"sessionUpdate":"user_message"}}}`) {
		t.Fatal("message")
	}
	if !IsUserPromptEvent(`{"update":{"event_name":"user_prompt_submit"}}`) {
		t.Fatal("submit")
	}
	if IsUserPromptEvent(`{"params":{"update":{"sessionUpdate":"tool_call"}}}`) {
		t.Fatal("tool")
	}
	if IsUserPromptEvent(`not json`) {
		t.Fatal("junk")
	}
}

func TestParseLine(t *testing.T) {
	line := `{"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","rawInput":{"target_file":"/repo/src/a.ts"},"_meta":{"x.ai/tool":{"name":"read_file"}}}}}`
	got := ParseLine(line, extract.SessionHint{SessionID: "s1", Cwd: "/repo"})
	if got == nil || extract.FolderPath(&got.Visit) != "/repo/src" {
		t.Fatalf("%v", got)
	}
	if ParseLine(`{"params":{"update":{"sessionUpdate":"agent_thought_chunk"}}}`, extract.SessionHint{}) != nil {
		t.Fatal("thought")
	}
	if ParseLine("nope", extract.SessionHint{}) != nil {
		t.Fatal("junk")
	}
}
