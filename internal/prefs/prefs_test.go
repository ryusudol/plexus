package prefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

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
	slow := Sanitize(map[string]any{"agentSpeed": "slow"})
	if slow.AgentSpeed == nil || *slow.AgentSpeed != 0.72 {
		t.Fatalf("slow %v", slow.AgentSpeed)
	}
	medium := Sanitize(map[string]any{"agentSpeed": "medium"})
	if medium.AgentSpeed == nil || *medium.AgentSpeed != 1.4 {
		t.Fatalf("medium %v", medium.AgentSpeed)
	}
}

func TestSanitizeFields(t *testing.T) {
	ok := Sanitize(map[string]any{
		"accent":         "#ff4fcb",
		"shape":          "tree",
		"theme":          "dark",
		"opacity":        0.8,
		"graphFollow":    "project",
		"settingsHidden": true,
		"sessionId":      "abc",
		"agentSymbol":    "data:image/png;base64,abc",
	})
	if ok.Accent != "#ff4fcb" || ok.Shape != "tree" || ok.Theme != "dark" {
		t.Fatalf("%+v", ok)
	}
	if ok.Opacity == nil || *ok.Opacity != 0.8 {
		t.Fatal("opacity")
	}
	if ok.GraphFollow != "project" || ok.SessionID != "abc" {
		t.Fatal("follow")
	}
	if ok.SettingsHidden == nil || !*ok.SettingsHidden {
		t.Fatal("hidden")
	}
	if ok.AgentSymbol == nil || *ok.AgentSymbol != "data:image/png;base64,abc" {
		t.Fatal("symbol")
	}

	bad := Sanitize(map[string]any{
		"accent":      "#fff",
		"shape":       "hex",
		"theme":       "solarized",
		"opacity":     0.1,
		"graphFollow": "camera",
		"sessionId":   strings.Repeat("x", 200),
		"agentSymbol": "http://example.com/x.png",
	})
	if bad.Accent != "" || bad.Shape != "" || bad.Theme != "" || bad.GraphFollow != "" || bad.SessionID != "" {
		t.Fatalf("rejected %+v", bad)
	}
	if bad.Opacity == nil || *bad.Opacity != 0.4 {
		t.Fatalf("opacity clamp %v", bad.Opacity)
	}
	if bad.AgentSymbol != nil {
		t.Fatal("bad symbol")
	}

	clear := Sanitize(map[string]any{"agentSymbol": ""})
	if clear.AgentSymbol == nil || *clear.AgentSymbol != "" {
		t.Fatal("clear symbol")
	}
	highOp := Sanitize(map[string]any{"opacity": 2.0})
	if highOp.Opacity == nil || *highOp.Opacity != 1 {
		t.Fatal("opacity high")
	}
	if Sanitize("nope").Accent != "" {
		t.Fatal("non-map")
	}
}

func TestReadWrite(t *testing.T) {
	isolateHome(t)
	def := Read()
	if def.Accent != "#ff4fcb" || def.Shape != "neurons" {
		t.Fatalf("%+v", def)
	}
	speed := 2.0
	hidden := true
	empty := ""
	got := Write(Prefs{
		Accent:         "#112233",
		Shape:          "circle",
		Theme:          "light",
		AgentSpeed:     &speed,
		GraphFollow:    "project",
		SettingsHidden: &hidden,
		SessionID:      "s1",
		AgentSymbol:    &empty,
	})
	if got.Accent != "#112233" || got.GraphFollow != "project" || got.SessionID != "s1" {
		t.Fatalf("%+v", got)
	}
	if got.AgentSymbol != nil {
		t.Fatal("cleared symbol")
	}
	round := Read()
	if round.Accent != "#112233" || round.Shape != "circle" || round.Theme != "light" {
		t.Fatalf("round %+v", round)
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".plexus", "prefs.json")); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(os.Getenv("HOME"), ".plexus", "prefs.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	broken := Read()
	if broken.Accent != "#ff4fcb" || broken.Shape != "neurons" {
		t.Fatalf("broken %+v", broken)
	}
}
