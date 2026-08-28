package prefs

import "testing"

func TestSanitizeAgentSpeed(t *testing.T) {
	got := Sanitize(map[string]any{"agentSpeed": 1.5})
	if got.AgentSpeed == nil || *got.AgentSpeed != 1.5 {
		t.Fatalf("%v", got.AgentSpeed)
	}
	low := Sanitize(map[string]any{"agentSpeed": 0.1})
	if low.AgentSpeed == nil || *low.AgentSpeed != 0.5 {
		t.Fatalf("low %v", low.AgentSpeed)
	}
	high := Sanitize(map[string]any{"agentSpeed": 9.0})
	if high.AgentSpeed == nil || *high.AgentSpeed != 4 {
		t.Fatalf("high %v", high.AgentSpeed)
	}
	named := Sanitize(map[string]any{"agentSpeed": "fast"})
	if named.AgentSpeed == nil || *named.AgentSpeed != 3.4 {
		t.Fatalf("named %v", named.AgentSpeed)
	}
}
