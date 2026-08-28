package hooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/ryusudol/plexus/internal/config"
	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/paths"
)

type Command struct {
	Type    string `json:"type"`
	Command string `json:"command,omitempty"`
	URL     string `json:"url,omitempty"`
	Timeout int    `json:"timeout,omitempty"`
	Matcher string `json:"matcher,omitempty"`
}

type Group struct {
	Matcher string    `json:"matcher,omitempty"`
	Hooks   []Command `json:"hooks"`
}

func HasPlexusLauncher(blob string) bool {
	return strings.Contains(blob, "bin/plexus")
}

func HasPlexusHook(blob string) bool {
	return strings.Contains(blob, "plexus-hook") || strings.Contains(blob, "--hook")
}

func HasHTTPHook(blob string) bool {
	return strings.Contains(blob, "127.0.0.1:7733/hook") || HasPlexusHook(blob)
}

func MigrateLauncherCommands(hooks map[string]any, bin string) {
	for _, raw := range hooks {
		groups, ok := raw.([]any)
		if !ok {
			continue
		}
		for _, g := range groups {
			gm := jsonx.AsMap(g)
			if gm == nil {
				continue
			}
			list := jsonx.Slice(gm["hooks"])
			for _, h := range list {
				hm := jsonx.AsMap(h)
				if hm == nil {
					continue
				}
				cmd := jsonx.Str(hm["command"])
				if cmd == "" {
					continue
				}
				next := cmd
				if strings.Contains(cmd, "plexus.ts") && strings.Contains(cmd, "--ensure") {
					next = quote(bin) + " --ensure"
				} else if strings.Contains(cmd, "plexus-hook") {
					src := "claude"
					if strings.Contains(cmd, "codex") {
						src = "codex"
					}
					next = quote(bin) + " --hook --source " + src
				}
				if next != cmd {
					hm["command"] = next
				}
			}
		}
	}
}

func quote(s string) string {
	return `"` + s + `"`
}

func EnsureList(hooks map[string]any, event string) *[]any {
	raw, ok := hooks[event]
	if !ok {
		list := []any{}
		hooks[event] = list
		raw = list
	}
	list, ok := raw.([]any)
	if !ok {
		list = []any{}
		hooks[event] = list
	}
	return &list
}

func PushGroup(hooks map[string]any, event string, group any) {
	list, _ := hooks[event].([]any)
	list = append(list, group)
	hooks[event] = list
}

func CommandGroup(command string, timeout int) map[string]any {
	return map[string]any{
		"hooks": []any{
			map[string]any{"type": "command", "command": command, "timeout": timeout},
		},
	}
}

func LoadFile(file string) map[string]any {
	b, err := os.ReadFile(file)
	rec := map[string]any{}
	if err == nil {
		_ = json.Unmarshal(b, &rec)
	}
	if rec["hooks"] == nil || jsonx.AsMap(rec["hooks"]) == nil {
		rec["hooks"] = map[string]any{}
	} else {
		// keep as map[string]any
		if m := jsonx.AsMap(rec["hooks"]); m != nil {
			rec["hooks"] = m
		}
	}
	return rec
}

func SaveFile(file string, spec any) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(file, append(b, '\n'), 0o644)
}

func InstallGrok(root, bin string) string {
	hooksDir := filepath.Join(paths.Home(), ".grok", "hooks")
	_ = os.MkdirAll(hooksDir, 0o755)
	url := config.Origin() + "/hook"
	spec := map[string]any{
		"hooks": map[string]any{
			"SessionStart": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{"type": "command", "command": quote(bin) + " --ensure", "timeout": 8},
					},
				},
			},
			"PreToolUse": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{"type": "http", "url": url, "timeout": 2},
					},
				},
			},
		},
	}
	payload, _ := json.MarshalIndent(spec, "", "  ")
	payload = append(payload, '\n')
	_ = os.WriteFile(filepath.Join(hooksDir, "plexus.json"), payload, 0o644)
	_ = os.MkdirAll(filepath.Join(root, "hooks"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "hooks", "plexus.json"), payload, 0o644)
	for _, stale := range []string{"grok-explore.json"} {
		for _, dir := range []string{hooksDir, filepath.Join(root, "hooks")} {
			_ = os.Remove(filepath.Join(dir, stale))
		}
	}
	return url
}
