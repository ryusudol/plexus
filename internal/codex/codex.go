package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/ryusudol/plexus/internal/config"
	"github.com/ryusudol/plexus/internal/extract"
	"github.com/ryusudol/plexus/internal/hooks"
	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/paths"
	"github.com/ryusudol/plexus/internal/types"
)

var rollout = regexp.MustCompile(`^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$`)

func Home() string {
	if env := os.Getenv("CODEX_HOME"); env != "" {
		return env
	}
	return filepath.Join(paths.Home(), ".codex")
}

func cwdFromRecords(records []map[string]any) string {
	for _, rec := range records {
		payload := jsonx.AsMap(rec["payload"])
		if jsonx.Str(rec["type"]) == "session_meta" && payload != nil {
			if s := jsonx.Str(payload["cwd"]); s != "" {
				return s
			}
		}
		if payload != nil {
			if s := jsonx.Str(payload["cwd"]); s != "" {
				return s
			}
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
	payload := jsonx.AsMap(rec["payload"])
	if payload == nil {
		payload = rec
	}
	kind := jsonx.Str(payload["type"])
	if kind == "" {
		kind = jsonx.Str(rec["type"])
	}
	event := kind
	prompt := false
	activity := ""
	if kind == "message" && jsonx.Str(payload["role"]) == "user" {
		prompt = true
		activity = "busy"
	}
	if kind == "function_call" || kind == "custom_tool_call" || kind == "local_shell_call" {
		activity = "busy"
	}
	if jsonx.Str(rec["type"]) == "event_msg" && (event == "task_complete" || jsonx.Str(payload["type"]) == "task_complete") {
		activity = "idle"
	}
	parsed := extract.VisitFromCodexRecord(record, session)
	visits := []extract.ParsedVisit{}
	if parsed != nil {
		visits = []extract.ParsedVisit{*parsed}
	}
	return extract.LineParse{Visits: visits, Activity: activity, Prompt: prompt}
}

func walkRollouts(root string, now time.Time, into *[]types.SessionRow, depth int) {
	if depth > 5 {
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		full := filepath.Join(root, entry.Name())
		if entry.IsDir() {
			walkRollouts(full, now, into, depth+1)
			continue
		}
		match := rollout.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		st, err := os.Stat(full)
		if err != nil {
			continue
		}
		if now.Sub(st.ModTime()) > config.Live {
			continue
		}
		records := paths.PeekJSONL(full, 20)
		cwd := cwdFromRecords(records)
		if cwd == "" {
			continue
		}
		nativeID := match[1]
		*into = append(*into, types.SessionRow{
			SessionID: "codex:" + nativeID,
			NativeID:  nativeID,
			PID:       0,
			Cwd:       cwd,
			Title:     orBase(cwd, "codex"),
			Agent:     "codex",
			Provider:  "codex",
			Updates:   full,
			Mtime:     st.ModTime().UnixMilli(),
			Live:      true,
		})
	}
}

func orBase(cwd, fallback string) string {
	if b := filepath.Base(cwd); b != "" {
		return b
	}
	return fallback
}

func recentDayDirs(home string, now time.Time) []string {
	root := filepath.Join(home, "sessions")
	dirs := []string{}
	seen := map[string]bool{}
	add := func(t time.Time, utc bool) {
		var y int
		var m time.Month
		var d int
		if utc {
			y, m, d = t.UTC().Date()
		} else {
			y, m, d = t.Date()
		}
		p := filepath.Join(root, fmt.Sprintf("%d", y), fmt.Sprintf("%02d", int(m)), fmt.Sprintf("%02d", d))
		if !seen[p] {
			seen[p] = true
			dirs = append(dirs, p)
		}
	}
	for _, delta := range []int{0, 1, 2} {
		t := now.Add(-time.Duration(delta) * 24 * time.Hour)
		add(t, false)
		add(t, true)
	}
	return dirs
}

func ReadSessions(home string, now time.Time) []types.SessionRow {
	if home == "" {
		home = Home()
	}
	if now.IsZero() {
		now = time.Now()
	}
	out := []types.SessionRow{}
	dirs := recentDayDirs(home, now)
	if len(dirs) == 0 {
		walkRollouts(filepath.Join(home, "sessions"), now, &out, 0)
	}
	for _, dir := range dirs {
		walkRollouts(dir, now, &out, 0)
	}
	return types.NewestByID(out)
}

func Install(bin string) error {
	file := filepath.Join(Home(), "hooks.json")
	spec := hooks.LoadFile(file)
	hm := jsonx.AsMap(spec["hooks"])
	if hm == nil {
		hm = map[string]any{}
		spec["hooks"] = hm
	}
	hooks.MigrateLauncherCommands(hm, bin)
	blob, _ := json.Marshal(hm)
	if !hooks.HasPlexusLauncher(string(blob)) {
		hooks.PushGroup(hm, "SessionStart", hooks.CommandGroup(quote(bin)+" --ensure", 8))
	}
	if !hooks.HasPlexusHook(string(blob)) {
		command := hooks.CommandGroup(quote(bin)+" --hook --source codex", 2)
		for _, event := range []string{"PreToolUse", "UserPromptSubmit", "Stop"} {
			hooks.PushGroup(hm, event, command)
		}
	}
	spec["hooks"] = hm
	return hooks.SaveFile(file, spec)
}

func quote(s string) string { return `"` + s + `"` }
