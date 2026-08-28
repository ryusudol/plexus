package prefs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"

	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/paths"
)

type Prefs struct {
	Accent         string   `json:"accent,omitempty"`
	Shape          string   `json:"shape,omitempty"`
	Theme          string   `json:"theme,omitempty"`
	Opacity        *float64 `json:"opacity,omitempty"`
	GraphFollow    string   `json:"graphFollow,omitempty"`
	SettingsHidden *bool    `json:"settingsHidden,omitempty"`
	SessionID      string   `json:"sessionId,omitempty"`
	AgentSymbol    *string  `json:"agentSymbol,omitempty"`
}

func file() string {
	return filepath.Join(paths.PlexusDir(), "prefs.json")
}

func Read() Prefs {
	b, err := os.ReadFile(file())
	if err != nil {
		return Prefs{Accent: "#ff4fcb", Shape: "neurons"}
	}
	var p Prefs
	if json.Unmarshal(b, &p) != nil {
		return Prefs{Accent: "#ff4fcb", Shape: "neurons"}
	}
	if p.Accent == "" {
		p.Accent = "#ff4fcb"
	}
	if p.Shape == "" {
		p.Shape = "neurons"
	}
	return p
}

func Write(next Prefs) Prefs {
	cur := Read()
	if next.Accent != "" {
		cur.Accent = next.Accent
	}
	if next.Shape != "" {
		cur.Shape = next.Shape
	}
	if next.Theme != "" {
		cur.Theme = next.Theme
	}
	if next.Opacity != nil {
		cur.Opacity = next.Opacity
	}
	if next.GraphFollow != "" {
		cur.GraphFollow = next.GraphFollow
	}
	if next.SettingsHidden != nil {
		cur.SettingsHidden = next.SettingsHidden
	}
	if next.SessionID != "" {
		cur.SessionID = next.SessionID
	}
	if next.AgentSymbol != nil {
		if *next.AgentSymbol == "" {
			cur.AgentSymbol = nil
		} else {
			cur.AgentSymbol = next.AgentSymbol
		}
	}
	_ = os.MkdirAll(filepath.Dir(file()), 0o755)
	b, _ := json.Marshal(cur)
	_ = os.WriteFile(file(), append(b, '\n'), 0o644)
	return cur
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func Sanitize(body any) Prefs {
	patch := Prefs{}
	m := jsonx.AsMap(body)
	if m == nil {
		return patch
	}
	if accent := jsonx.Str(m["accent"]); hexColor.MatchString(accent) {
		patch.Accent = accent
	}
	if s := jsonx.Str(m["shape"]); s == "tree" || s == "circle" || s == "neurons" {
		patch.Shape = s
	}
	if s := jsonx.Str(m["theme"]); s == "light" || s == "dark" || s == "system" {
		patch.Theme = s
	}
	if m["opacity"] != nil {
		n := jsonx.Int(m["opacity"])
		// opacity may be float
		var f float64
		switch v := m["opacity"].(type) {
		case float64:
			f = v
		case int:
			f = float64(v)
		default:
			_ = n
			f = -1
		}
		if f >= 0 {
			if f < 0.4 {
				f = 0.4
			}
			if f > 1 {
				f = 1
			}
			patch.Opacity = &f
		}
	}
	if s := jsonx.Str(m["graphFollow"]); s == "focus" || s == "project" {
		patch.GraphFollow = s
	}
	if v, ok := m["settingsHidden"].(bool); ok {
		patch.SettingsHidden = &v
	}
	if s := jsonx.Str(m["sessionId"]); s != "" && len(s) < 200 {
		patch.SessionID = s
	}
	if _, ok := m["agentSymbol"]; ok {
		if m["agentSymbol"] == nil || jsonx.Str(m["agentSymbol"]) == "" {
			empty := ""
			patch.AgentSymbol = &empty
		} else if s := jsonx.Str(m["agentSymbol"]); stringsHasPrefix(s, "data:image/") && len(s) < 180000 {
			patch.AgentSymbol = &s
		}
	}
	return patch
}

func stringsHasPrefix(s, p string) bool {
	return len(s) >= len(p) && s[:len(p)] == p
}
