package claude

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ryusudol/plexus/internal/config"
	"github.com/ryusudol/plexus/internal/extract"
	"github.com/ryusudol/plexus/internal/hooks"
	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/paths"
	"github.com/ryusudol/plexus/internal/types"
)

func Home() string {
	if env := os.Getenv("CLAUDE_CONFIG_DIR"); env != "" {
		return env
	}
	return filepath.Join(paths.Home(), ".claude")
}

func titleFromRecords(records []map[string]any, cwd string) string {
	for _, rec := range records {
		if jsonx.Str(rec["type"]) == "custom-title" {
			if t := strings.TrimSpace(jsonx.Str(rec["title"])); t != "" {
				return t
			}
		}
		if jsonx.Str(rec["type"]) == "summary" {
			if t := strings.TrimSpace(jsonx.Str(rec["summary"])); t != "" {
				return t
			}
		}
	}
	base := filepath.Base(cwd)
	if base == "" {
		return "claude"
	}
	return base
}

func cwdFromRecords(records []map[string]any) string {
	for _, rec := range records {
		if s := jsonx.Str(rec["cwd"]); s != "" {
			return s
		}
	}
	return ""
}

func ParseLine(line string, session extract.SessionHint) extract.LineParse {
	record := jsonx.Parse(line)
	if record == nil {
		return extract.LineParse{}
	}
	rec := jsonx.AsMap(record)
	typ := jsonx.Str(rec["type"])
	message := jsonx.AsMap(rec["message"])
	content := any(nil)
	if message != nil {
		content = message["content"]
	}
	isToolResult := typ == "user" && jsonx.Slice(content) != nil
	if isToolResult {
		isToolResult = false
		for _, block := range jsonx.Slice(content) {
			if bm := jsonx.AsMap(block); bm != nil && jsonx.Str(bm["type"]) == "tool_result" {
				isToolResult = true
				break
			}
		}
	}
	prompt := typ == "user" && !isToolResult
	activity := ""
	if typ == "assistant" || prompt {
		activity = "busy"
	}
	if jsonx.Str(rec["hook_event_name"]) == "Stop" || jsonx.Str(rec["type"]) == "stop" {
		activity = "idle"
	}
	visits := extract.VisitFromClaudeRecord(record, session)
	if visits == nil {
		visits = []extract.ParsedVisit{}
	}
	return extract.LineParse{Visits: visits, Activity: activity, Prompt: prompt}
}

func ReadSessions(home string, now time.Time) []types.SessionRow {
	if home == "" {
		home = Home()
	}
	if now.IsZero() {
		now = time.Now()
	}
	root := filepath.Join(home, "projects")
	if _, err := os.Stat(root); err != nil {
		return nil
	}
	projects, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	out := []types.SessionRow{}
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		dir := filepath.Join(root, project.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, name := range files {
			if !strings.HasSuffix(name.Name(), ".jsonl") {
				continue
			}
			file := filepath.Join(dir, name.Name())
			st, err := os.Stat(file)
			if err != nil {
				continue
			}
			if now.Sub(st.ModTime()) > config.Live {
				continue
			}
			records := paths.PeekJSONL(file, 40)
			cwd := cwdFromRecords(records)
			if cwd == "" {
				continue
			}
			id := strings.TrimSuffix(name.Name(), ".jsonl")
			out = append(out, types.SessionRow{
				SessionID: "claude:" + id,
				NativeID:  id,
				PID:       0,
				Cwd:       cwd,
				Title:     titleFromRecords(records, cwd),
				Agent:     "claude",
				Provider:  "claude",
				Updates:   file,
				Mtime:     st.ModTime().UnixMilli(),
				Live:      true,
			})
		}
	}
	return types.NewestByID(out)
}

func Install(bin string) error {
	file := filepath.Join(Home(), "settings.json")
	settings := hooks.LoadFile(file)
	hm := jsonx.AsMap(settings["hooks"])
	if hm == nil {
		hm = map[string]any{}
		settings["hooks"] = hm
	}
	hooks.MigrateLauncherCommands(hm, bin)
	hooks.MigratePlexusHTTP(hm, bin, "claude")
	blob, _ := jsonMarshal(hm)
	if !hooks.HasPlexusLauncher(string(blob)) {
		hooks.PushGroup(hm, "SessionStart", hooks.CommandGroup(quote(bin)+" --ensure", 8))
	}
	sourceHook := hooks.CommandGroup(quote(bin)+" --hook --source claude", 2)
	for _, event := range []string{"PreToolUse", "UserPromptSubmit", "Stop"} {
		hooks.EnsureEventHook(hm, event, sourceHook)
	}
	settings["hooks"] = hm
	return hooks.SaveFile(file, settings)
}

func quote(s string) string { return `"` + s + `"` }

func jsonMarshal(v any) ([]byte, error) {
	return marshal(v)
}
