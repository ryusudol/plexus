package sessions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryusudol/plexus/internal/acp"
	"github.com/ryusudol/plexus/internal/claude"
	"github.com/ryusudol/plexus/internal/codex"
	"github.com/ryusudol/plexus/internal/extract"
	"github.com/ryusudol/plexus/internal/orca"
	"github.com/ryusudol/plexus/internal/roster"
	"github.com/ryusudol/plexus/internal/types"
)

func tmpHome(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func encodeCwd(cwd string) string { return roster.EncodeCwd(cwd) }

func sessionDir(home, cwd, id string) string {
	return filepath.Join(home, "sessions", encodeCwd(cwd), id)
}

func writeGrokSession(t *testing.T, home, id, cwd, title, updates string, pid int) {
	t.Helper()
	dir := sessionDir(home, cwd, id)
	write(t, filepath.Join(dir, "summary.json"), `{"generated_title":"`+title+`","agent_name":"grok-build"}`)
	write(t, filepath.Join(dir, "updates.jsonl"), updates)
}

func eventMap(v any) map[string]any {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func TestParseSessionEvent(t *testing.T) {
	if acp.ParseSessionEvent(`{"params":{"update":{"sessionUpdate":"user_message_chunk"}}}`) != "busy" {
		t.Fatal("prompt")
	}
	if acp.ParseSessionEvent(`{"params":{"update":{"sessionUpdate":"tool_call"}}}`) != "busy" {
		t.Fatal("tool")
	}
	if acp.ParseSessionEvent(`{"params":{"update":{"sessionUpdate":"turn_completed"}}}`) != "idle" {
		t.Fatal("idle")
	}
}

func TestIsUserPromptEvent(t *testing.T) {
	if !acp.IsUserPromptEvent(`{"params":{"update":{"sessionUpdate":"user_message_chunk"}}}`) {
		t.Fatal("message")
	}
	if !acp.IsUserPromptEvent(`{"params":{"update":{"event_name":"user_prompt_submit"}}}`) {
		t.Fatal("submit")
	}
	if acp.IsUserPromptEvent(`{"params":{"update":{"sessionUpdate":"tool_call"}}}`) {
		t.Fatal("tool")
	}
}

func TestReadActiveSessions(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	id := "01aaaaaaaaaaaaaaaaaaaaaaaaaa"
	tool := `{"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","rawInput":{"target_file":"/Users/me/proj/src/a.ts"},"_meta":{"x.ai/tool":{"name":"read_file"}}}}}` + "\n"
	writeGrokSession(t, home, id, cwd, "Fix login", tool, os.Getpid())
	write(t, filepath.Join(home, "active_sessions.json"), `[{"session_id":"`+id+`","pid":`+itoa(os.Getpid())+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	list := roster.ReadActiveSessions(home, nil, false)
	if len(list) != 1 || list[0].Title != "Fix login" {
		t.Fatalf("%v", list)
	}
	visits := Replay(list[0], home)
	if len(visits) == 0 || extract.FolderPath(&visits[0]) != "/Users/me/proj/src" {
		t.Fatalf("%v", visits)
	}
}

func itoa(n int) string {
	s := ""
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	if neg {
		return "-" + s
	}
	return s
}

func writeOrca(t *testing.T, file, body string) { write(t, file, body) }

func TestLiveCLIAlongsideOrca(t *testing.T) {
	home := tmpHome(t)
	orcaID := "01bbbbbbbbbbbbbbbbbbbbbbbbbb"
	cliID := "01ffffffffffffffffffffffffff"
	cwd := "/Users/me/proj"
	cliCwd := "/Users/me/other"
	pid := os.Getpid()
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+orcaID+`","pid":0,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"`+cliID+`","pid":`+itoa(pid)+`,"cwd":"`+cliCwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	writeGrokSession(t, home, orcaID, cwd, orcaID, "{}\n", pid)
	writeGrokSession(t, home, cliID, cliCwd, cliID, "{}\n", pid)
	orcaFile := filepath.Join(home, "orca-data.json")
	writeOrca(t, orcaFile, `{
		"workspaceSession": {
			"tabsByWorktree": {"abc::/Users/me/proj": [{"id": "tab-live"}]},
			"sleepingAgentSessionsByPaneKey": {
				"tab-live:leaf-1": {
					"tabId": "tab-live",
					"worktreeId": "abc::/Users/me/proj",
					"providerSession": {"key": "session_id", "id": "`+orcaID+`"}
				}
			}
		}
	}`)
	panes, ok := orca.ReadLivePanes(orcaFile)
	if !ok {
		t.Fatal("panes")
	}
	list := roster.ReadActiveSessions(home, panes, true)
	if len(list) != 2 {
		t.Fatalf("len %d", len(list))
	}
}

func TestDropStaleNotOnOrca(t *testing.T) {
	home := tmpHome(t)
	liveID := "01bbbbbbbbbbbbbbbbbbbbbbbbbb"
	staleID := "01cccccccccccccccccccccccccc"
	cwd := "/Users/me/proj"
	pid := os.Getpid()
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+liveID+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"`+staleID+`","pid":0,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	writeGrokSession(t, home, liveID, cwd, liveID, "{}\n", pid)
	writeGrokSession(t, home, staleID, cwd, staleID, "{}\n", 0)
	old := time.Now().Add(-20 * time.Minute)
	_ = os.Chtimes(filepath.Join(sessionDir(home, cwd, staleID), "updates.jsonl"), old, old)
	orcaFile := filepath.Join(home, "orca-data.json")
	writeOrca(t, orcaFile, `{
		"workspaceSession": {
			"tabsByWorktree": {"abc::/Users/me/proj": [{"id": "tab-live"}]},
			"sleepingAgentSessionsByPaneKey": {
				"tab-live:leaf-1": {
					"tabId": "tab-live",
					"worktreeId": "abc::/Users/me/proj",
					"providerSession": {"key": "session_id", "id": "`+liveID+`"}
				}
			}
		}
	}`)
	panes, _ := orca.ReadLivePanes(orcaFile)
	list := roster.ReadActiveSessions(home, panes, true)
	if len(list) != 1 || list[0].SessionID != liveID {
		t.Fatalf("%v", list)
	}
}

func TestOrcaMissingFromActive(t *testing.T) {
	home := tmpHome(t)
	liveID := "01dddddddddddddddddddddddddd"
	cwd := "/Users/me/other"
	writeGrokSession(t, home, liveID, cwd, "Live tab", "", 0)
	orcaFile := filepath.Join(home, "orca-data.json")
	writeOrca(t, orcaFile, `{
		"workspaceSession": {
			"tabsByWorktree": {"abc::/Users/me/other": [{"id": "tab-2"}]},
			"sleepingAgentSessionsByPaneKey": {
				"tab-2:leaf-2": {
					"tabId": "tab-2",
					"worktreeId": "abc::/Users/me/other",
					"providerSession": {"key": "session_id", "id": "`+liveID+`"}
				}
			}
		}
	}`)
	panes, _ := orca.ReadLivePanes(orcaFile)
	list := roster.ReadActiveSessions(home, panes, true)
	if len(list) != 1 || list[0].SessionID != liveID || list[0].Title != "Live tab" {
		t.Fatalf("%v", list)
	}
}

func TestEmptyActiveDropsOrcaLeftover(t *testing.T) {
	home := tmpHome(t)
	liveID := "01dddddddddddddddddddddddddd"
	cwd := "/Users/me/other"
	writeGrokSession(t, home, liveID, cwd, "Live tab", "", 0)
	write(t, filepath.Join(home, "active_sessions.json"), `[]`)
	orcaFile := filepath.Join(home, "orca-data.json")
	writeOrca(t, orcaFile, `{
		"workspaceSession": {
			"tabsByWorktree": {"abc::/Users/me/other": [{"id": "tab-2"}]},
			"sleepingAgentSessionsByPaneKey": {
				"tab-2:leaf-2": {
					"tabId": "tab-2",
					"worktreeId": "abc::/Users/me/other",
					"providerSession": {"key": "session_id", "id": "`+liveID+`"}
				}
			}
		}
	}`)
	panes, _ := orca.ReadLivePanes(orcaFile)
	list := roster.ReadActiveSessions(home, panes, true)
	if len(list) != 0 {
		t.Fatalf("%v", list)
	}
}

func TestDropDeadHostNotOnOrca(t *testing.T) {
	home := tmpHome(t)
	id := "01aaaaaaaaaaaaaaaaaaaaaaaaaa"
	cwd := "/Users/me/proj"
	writeGrokSession(t, home, id, cwd, "Dead", "{}\n", 0)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+id+`","pid":999999,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	list := roster.ReadActiveSessions(home, map[string]orca.Pane{}, true)
	if len(list) != 0 {
		t.Fatalf("%v", list)
	}
}

func TestDropSharedPidNotOnOrca(t *testing.T) {
	home := tmpHome(t)
	liveID := "01bbbbbbbbbbbbbbbbbbbbbbbbbb"
	staleID := "01cccccccccccccccccccccccccc"
	cwd := "/Users/me/proj"
	pid := os.Getpid()
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+liveID+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"`+staleID+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	writeGrokSession(t, home, liveID, cwd, "Live", "{}\n", pid)
	writeGrokSession(t, home, staleID, cwd, "Stale", "{}\n", pid)
	orcaFile := filepath.Join(home, "orca-data.json")
	writeOrca(t, orcaFile, `{
		"workspaceSession": {
			"tabsByWorktree": {"abc::/Users/me/proj": [{"id": "tab-live"}]},
			"sleepingAgentSessionsByPaneKey": {
				"tab-live:leaf-1": {
					"tabId": "tab-live",
					"worktreeId": "abc::/Users/me/proj",
					"providerSession": {"key": "session_id", "id": "`+liveID+`"}
				}
			}
		}
	}`)
	panes, _ := orca.ReadLivePanes(orcaFile)
	list := roster.ReadActiveSessions(home, panes, true)
	if len(list) != 1 || list[0].SessionID != liveID {
		t.Fatalf("%v", list)
	}
}

func TestDropTerminatedGrokFromRoster(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	id := "01aaaaaaaaaaaaaaaaaaaaaaaaaa"
	pid := os.Getpid()
	writeGrokSession(t, home, id, cwd, "Live", "{}\n", pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+id+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	hub := New(home, func(any) {})
	hub.NoteHook(map[string]any{
		"session_id":      id,
		"cwd":             cwd,
		"pid":             pid,
		"hook_event_name": "UserPromptSubmit",
	})
	hub.ScanRoster()
	if len(hub.Roster) != 1 {
		t.Fatalf("start %v", hub.Roster)
	}
	write(t, filepath.Join(home, "active_sessions.json"), `[]`)
	hub.ScanRoster()
	if len(hub.Roster) != 0 {
		t.Fatalf("still listed %v", hub.Roster)
	}
	hub.Stop()
}

func TestIgnoreClosedTab(t *testing.T) {
	home := tmpHome(t)
	closedID := "01eeeeeeeeeeeeeeeeeeeeeeeeee"
	cwd := "/Users/me/proj"
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+closedID+`","pid":0,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	writeGrokSession(t, home, closedID, cwd, "Closed", "{}\n", 0)
	old := time.Now().Add(-20 * time.Minute)
	_ = os.Chtimes(filepath.Join(sessionDir(home, cwd, closedID), "updates.jsonl"), old, old)
	orcaFile := filepath.Join(home, "orca-data.json")
	writeOrca(t, orcaFile, `{
		"workspaceSession": {
			"tabsByWorktree": {"abc::/Users/me/proj": [{"id": "tab-open"}]},
			"sleepingAgentSessionsByPaneKey": {
				"tab-closed:leaf-1": {
					"tabId": "tab-closed",
					"worktreeId": "abc::/Users/me/proj",
					"providerSession": {"key": "session_id", "id": "`+closedID+`"}
				}
			}
		}
	}`)
	panes, _ := orca.ReadLivePanes(orcaFile)
	list := roster.ReadActiveSessions(home, panes, true)
	if len(list) != 0 {
		t.Fatalf("%v", list)
	}
}

func TestOrcaFocus(t *testing.T) {
	file := filepath.Join(t.TempDir(), "orca-data.json")
	write(t, file, `{"workspaceSession":{"activeWorktreeId":"abc::/Users/me/proj"}}`)
	if orca.ReadActiveCwd(file) != "/Users/me/proj" {
		t.Fatal(orca.ReadActiveCwd(file))
	}
	write(t, file, `{
		"workspaceSession": {
			"activeWorktreeId": "abc::/Users/me/proj",
			"activeTabId": "tab-1",
			"terminalLayoutsByTabId": {"tab-1": {"activeLeafId": "leaf-1"}},
			"sleepingAgentSessionsByPaneKey": {
				"tab-1:leaf-1": {"tabId": "tab-1", "providerSession": {"key": "session_id", "id": "sess-now"}}
			}
		}
	}`)
	f := orca.ReadFocus(file)
	if f == nil || f.Cwd != "/Users/me/proj" || f.SessionID != "sess-now" {
		t.Fatalf("%v", f)
	}
}

func TestPickFocusedSession(t *testing.T) {
	list := []types.SessionRow{
		{SessionID: "old", Cwd: "/Users/me/proj", Live: false, Mtime: 9},
		{SessionID: "now", Cwd: "/Users/me/proj", Live: true, Mtime: 3},
		{SessionID: "other", Cwd: "/Users/me/other", Live: true, Mtime: 99},
	}
	got := roster.PickFocusedSession(list, orca.Focus{Cwd: "/Users/me/proj"})
	if got == nil || got.SessionID != "now" {
		t.Fatalf("%v", got)
	}
	got = roster.PickFocusedSession(list[:2], orca.Focus{Cwd: "/Users/me/proj", SessionID: "now"})
	if got == nil || got.SessionID != "now" {
		t.Fatalf("%v", got)
	}
}

func TestFollowModes(t *testing.T) {
	hub := New("", func(any) {})
	hub.FollowMode = "project"
	hub.SelectedID = "keep"
	hub.Roster = []types.SessionRow{
		{SessionID: "keep", Cwd: "/a", Live: true, Mtime: 1},
		{SessionID: "other", Cwd: "/b", Live: true, Mtime: 9},
	}
	if hub.FollowFocus(orca.Focus{Cwd: "/b"}) {
		t.Fatal("project")
	}
	if hub.SelectedID != "keep" {
		t.Fatal(hub.SelectedID)
	}

	hub = New("", func(any) {})
	hub.FollowMode = "focus"
	hub.SelectedID = "picked"
	hub.LastFocusedID = "keep"
	hub.Roster = []types.SessionRow{
		{SessionID: "keep", Cwd: "/a", Live: true, Mtime: 1},
		{SessionID: "picked", Cwd: "/b", Live: true, Mtime: 9},
	}
	if hub.FollowFocus(orca.Focus{Cwd: "/a"}) {
		t.Fatal("stay")
	}
	if hub.SelectedID != "picked" {
		t.Fatal(hub.SelectedID)
	}

	hub = New("", func(any) {})
	hub.FollowMode = "focus"
	hub.SelectedID = "keep"
	hub.LastFocusedID = "keep"
	hub.Roster = []types.SessionRow{
		{SessionID: "keep", Cwd: "/a", Live: true, Mtime: 1},
		{SessionID: "other", Cwd: "/b", Live: true, Mtime: 9},
	}
	if !hub.FollowFocus(orca.Focus{Cwd: "/b"}) || hub.SelectedID != "other" || hub.LastFocusedID != "other" {
		t.Fatal("follow")
	}

	hub = New("", func(any) {})
	hub.FollowMode = "focus"
	hub.SelectedID = "keep"
	hub.LastFocusedID = "keep"
	hub.Roster = []types.SessionRow{
		{SessionID: "keep", Cwd: "/a", Live: true, Mtime: 1},
		{SessionID: "other", Cwd: "/a", Live: true, Mtime: 9},
	}
	if hub.FollowFocus(orca.Focus{Cwd: "/a", SessionID: "keep"}) {
		t.Fatal("same")
	}
	if !hub.FollowFocus(orca.Focus{Cwd: "/a", SessionID: "other"}) || hub.SelectedID != "other" {
		t.Fatal("id switch")
	}

	hub = New("", func(any) {})
	hub.FollowMode = "focus"
	hub.SelectedID = "gone"
	hub.Roster = []types.SessionRow{
		{SessionID: "keep", Cwd: "/a", Live: true, Mtime: 1},
		{SessionID: "other", Cwd: "/b", Live: true, Mtime: 9},
	}
	if !hub.FollowFocus(orca.Focus{Cwd: "/b"}) || hub.SelectedID != "other" {
		t.Fatal("gone")
	}
}

func TestPollFocus(t *testing.T) {
	home := tmpHome(t)
	orcaFile := filepath.Join(home, "orca-data.json")
	t.Setenv("ORCA_DATA_FILE", orcaFile)
	writeFocus := func(id, cwd string) {
		write(t, orcaFile, `{
			"workspaceSession": {
				"activeWorktreeId": "wt::`+cwd+`",
				"activeTabId": "tab-1",
				"tabsByWorktree": {"wt::`+cwd+`": [{"id": "tab-1"}]},
				"terminalLayoutsByTabId": {"tab-1": {"activeLeafId": "leaf"}},
				"sleepingAgentSessionsByPaneKey": {
					"tab-1:leaf": {"tabId": "tab-1", "worktreeId": "wt::`+cwd+`", "providerSession": {"id": "`+id+`"}}
				}
			}
		}`)
	}
	writeFocus("keep", "/a")
	pid := os.Getpid()
	for _, row := range []struct{ id, cwd string }{{"keep", "/a"}, {"other", "/b"}} {
		dir := sessionDir(home, row.cwd, row.id)
		write(t, filepath.Join(dir, "summary.json"), `{"generated_title":"`+row.id+`"}`)
		write(t, filepath.Join(dir, "updates.jsonl"), "")
	}
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"keep","pid":`+itoa(pid)+`,"cwd":"/a","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"other","pid":`+itoa(pid)+`,"cwd":"/b","opened_at":"2026-01-01T00:01:00Z"}]`)
	var events []map[string]any
	hub := New(home, func(ev any) { events = append(events, eventMap(ev)) })
	hub.FollowMode = "focus"
	hub.ScanRoster()
	hub.SelectedID = "keep"
	hub.LastFocusedID = "keep"
	if hub.PollFocus() {
		t.Fatal("same focus")
	}
	writeFocus("other", "/b")
	if !hub.PollFocus() || hub.SelectedID != "other" {
		t.Fatalf("selected %s", hub.SelectedID)
	}
	found := false
	for _, ev := range events {
		if ev["type"] == "snapshot" && ev["sessionId"] == "other" {
			found = true
		}
	}
	if !found {
		t.Fatalf("%v", events)
	}
	hub.Stop()
}

func TestFollowPrompt(t *testing.T) {
	home := tmpHome(t)
	pid := os.Getpid()
	for _, row := range []struct{ id, cwd string }{{"keep", "/a"}, {"other", "/b"}} {
		writeGrokSession(t, home, row.id, row.cwd, row.id, "", pid)
	}
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"keep","pid":`+itoa(pid)+`,"cwd":"/a","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"other","pid":`+itoa(pid)+`,"cwd":"/b","opened_at":"2026-01-01T00:00:00Z"}]`)
	var events []map[string]any
	hub := New(home, func(ev any) { events = append(events, eventMap(ev)) })
	hub.FollowMode = "focus"
	hub.SelectedID = "keep"
	hub.ScanRoster()
	if !hub.FollowPrompt("other") || hub.SelectedID != "other" {
		t.Fatal("prompt")
	}
	found := false
	for _, ev := range events {
		if ev["type"] == "snapshot" && ev["sessionId"] == "other" {
			found = true
		}
	}
	if !found {
		t.Fatal(events)
	}

	hub = New("", func(any) {})
	hub.FollowMode = "project"
	hub.SelectedID = "keep"
	hub.Roster = []types.SessionRow{
		{SessionID: "keep", Cwd: "/a", Live: true, Mtime: 1},
		{SessionID: "other", Cwd: "/b", Live: true, Mtime: 9},
	}
	if hub.FollowPrompt("other") || hub.SelectedID != "keep" {
		t.Fatal("project prompt")
	}
}

func TestFingerprint(t *testing.T) {
	a := []types.SessionRow{{SessionID: "a", PID: 1, Cwd: "/x", Title: "A", Live: true}}
	b := []types.SessionRow{
		{SessionID: "a", PID: 1, Cwd: "/x", Title: "A", Live: true},
		{SessionID: "b", PID: 2, Cwd: "/y", Title: "B", Live: true},
	}
	if roster.Fingerprint(a) == roster.Fingerprint(b) {
		t.Fatal("equal")
	}
}

func acpTool(id, rawKey, rawVal, name string) string {
	return `{"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"` + id + `","rawInput":{"` + rawKey + `":"` + rawVal + `"},"_meta":{"x.ai/tool":{"name":"` + name + `"}}}}}`
}

func TestVisitTrailSnapshot(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	id := "01ffffffffffffffffffffffffff"
	pid := os.Getpid()
	lines := ""
	for i := 0; i < 55; i++ {
		file := cwd + "/pkg" + itoa(i) + "/src/a.ts"
		lines += acpTool("t"+itoa(i), "target_file", file, "read_file") + "\n"
	}
	writeGrokSession(t, home, id, cwd, "Trail", lines, pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+id+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	hub := New(home, func(any) {})
	hub.ScanRoster()
	hub.SyncTails()
	snap := hub.Snapshot()
	if len(snap.Visited) != 55 || snap.Visited[0] != cwd+"/pkg0/src" || snap.Visited[54] != cwd+"/pkg54/src" {
		t.Fatalf("visited %v", snap.Visited)
	}
	if len(snap.Files) != 55 || snap.Files[0] != cwd+"/pkg0/src/a.ts" || snap.Files[54] != cwd+"/pkg54/src/a.ts" {
		t.Fatalf("files %v", snap.Files)
	}
	if snap.Agents[0].FilePath == nil || *snap.Agents[0].FilePath != cwd+"/pkg54/src/a.ts" {
		t.Fatalf("agent %v", snap.Agents)
	}
	hub.Stop()
}

func TestUniqueFilesParkLastDir(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	id := "01eeeeeeeeeeeeeeeeeeeeeeeeee"
	pid := os.Getpid()
	body := acpTool("d1", "target_directory", cwd+"/src", "list_dir") + "\n" +
		acpTool("f1", "target_file", cwd+"/src/a.ts", "read_file") + "\n" +
		acpTool("f2", "target_file", cwd+"/src/b.ts", "read_file") + "\n" +
		acpTool("f3", "target_file", cwd+"/src/a.ts", "read_file") + "\n" +
		acpTool("d2", "target_directory", cwd+"/lib", "list_dir") + "\n"
	writeGrokSession(t, home, id, cwd, "Files", body, pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+id+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	hub := New(home, func(any) {})
	hub.ScanRoster()
	hub.SyncTails()
	snap := hub.Snapshot()
	if len(snap.Visited) != 2 || snap.Visited[0] != cwd+"/src" || snap.Visited[1] != cwd+"/lib" {
		t.Fatalf("visited %v", snap.Visited)
	}
	if len(snap.Files) != 2 || snap.Files[0] != cwd+"/src/a.ts" || snap.Files[1] != cwd+"/src/b.ts" {
		t.Fatalf("files %v", snap.Files)
	}
	if snap.Agents[0].FilePath != nil {
		t.Fatalf("filePath %v", snap.Agents[0].FilePath)
	}
	if snap.Agents[0].FolderPath != cwd+"/lib" {
		t.Fatalf("folder %s", snap.Agents[0].FolderPath)
	}
	hub.Stop()
}

func TestParkOnFile(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	id := "01dddddddddddddddddddddddddd"
	pid := os.Getpid()
	writeGrokSession(t, home, id, cwd, "Last", acpTool("f1", "target_file", cwd+"/src/app.ts", "read_file")+"\n", pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+id+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	hub := New(home, func(any) {})
	hub.ScanRoster()
	hub.SyncTails()
	snap := hub.Snapshot()
	if len(snap.Files) != 1 || snap.Files[0] != cwd+"/src/app.ts" {
		t.Fatalf("%v", snap.Files)
	}
	if snap.Agents[0].FilePath == nil || *snap.Agents[0].FilePath != cwd+"/src/app.ts" {
		t.Fatal(snap.Agents)
	}
	if snap.Agents[0].FolderPath != cwd+"/src" {
		t.Fatal(snap.Agents[0].FolderPath)
	}
	hub.Stop()
}

func TestPerSessionGraph(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	a := "01aaaaaaaaaaaaaaaaaaaaaaaaaa"
	b := "01bbbbbbbbbbbbbbbbbbbbbbbbbb"
	pid := os.Getpid()
	writeGrokSession(t, home, a, cwd, a, acpTool("t1", "target_file", cwd+"/src/a.ts", "read_file")+"\n", pid)
	writeGrokSession(t, home, b, cwd, b, acpTool("t1", "target_file", cwd+"/lib/b.ts", "read_file")+"\n", pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+a+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"`+b+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:01:00Z"}]`)
	hub := New(home, func(any) {})
	hub.ScanRoster()
	hub.SelectedID = a
	hub.SyncTails()
	snap := hub.Snapshot()
	if len(snap.Visited) != 1 || snap.Visited[0] != cwd+"/src" {
		t.Fatalf("%v", snap.Visited)
	}
	hub.Select(b)
	snap = hub.Snapshot()
	if snap.SessionID == nil || *snap.SessionID != b {
		t.Fatal(snap.SessionID)
	}
	if len(snap.Visited) != 1 || snap.Visited[0] != cwd+"/lib" {
		t.Fatalf("%v", snap.Visited)
	}
	hub.Stop()
}

func TestNewSessionEmptyGraph(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	a := "01cccccccccccccccccccccccccc"
	b := "01dddddddddddddddddddddddddd"
	pid := os.Getpid()
	writeGrokSession(t, home, a, cwd, "Old", acpTool("t1", "target_file", cwd+"/src/a.ts", "read_file")+"\n", pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+a+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	hub := New(home, func(any) {})
	hub.FollowMode = "focus"
	hub.Refresh(true)
	if hub.SelectedID != a {
		t.Fatal(hub.SelectedID)
	}
	if len(hub.Snapshot().Files) != 1 {
		t.Fatal(hub.Snapshot().Files)
	}
	writeGrokSession(t, home, b, cwd, "New", "", pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+a+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"`+b+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:02:00Z"}]`)
	hub.Refresh(false)
	if hub.SelectedID != b {
		t.Fatalf("selected %s", hub.SelectedID)
	}
	if len(hub.Snapshot().Visited) != 0 || len(hub.Snapshot().Files) != 0 {
		t.Fatal(hub.Snapshot())
	}
	hub.Stop()
}

func TestProjectFollowStays(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	a := "01eeeeeeeeeeeeeeeeeeeeeeeeee"
	b := "01ffffffffffffffffffffffffff"
	pid := os.Getpid()
	for _, id := range []string{a, b} {
		writeGrokSession(t, home, id, cwd, id, "", pid)
	}
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+a+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"}]`)
	hub := New(home, func(any) {})
	hub.FollowMode = "project"
	hub.Refresh(true)
	if hub.SelectedID != a {
		t.Fatal(hub.SelectedID)
	}
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+a+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:00:00Z"},`+
			`{"session_id":"`+b+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`","opened_at":"2026-01-01T00:03:00Z"}]`)
	hub.Refresh(false)
	if hub.SelectedID != a {
		t.Fatal(hub.SelectedID)
	}
	hub.Stop()
}

func TestProjectFollowKeepsSessionWhenRosterChanges(t *testing.T) {
	home := tmpHome(t)
	pid := os.Getpid()
	a := "01aaaaaaaaaaaaaaaaaaaaaaaaaa"
	b := "01bbbbbbbbbbbbbbbbbbbbbbbbbb"
	writeGrokSession(t, home, a, "/Users/me/proj", a, "", pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+a+`","pid":`+itoa(pid)+`,"cwd":"/Users/me/proj","opened_at":"2026-01-01T00:00:00Z"}]`)
	hub := New(home, func(any) {})
	hub.FollowMode = "project"
	hub.Refresh(true)
	if hub.SelectedID != a {
		t.Fatal(hub.SelectedID)
	}
	writeGrokSession(t, home, b, "/Users/me/other", b, "", pid)
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+b+`","pid":`+itoa(pid)+`,"cwd":"/Users/me/other","opened_at":"2026-01-01T00:04:00Z"}]`)
	hub.Refresh(false)
	if hub.SelectedID != a {
		t.Fatalf("jumped to %s", hub.SelectedID)
	}
	snap := hub.Snapshot()
	if snap.SessionID == nil || *snap.SessionID != a {
		t.Fatalf("snapshot %v", snap.SessionID)
	}
	hub.Stop()
}

func TestClaudeAndCodexLists(t *testing.T) {
	home := tmpHome(t)
	cwd := "/Users/me/proj"
	id := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	dir := filepath.Join(home, "projects", "-Users-me-proj")
	write(t, filepath.Join(dir, id+".jsonl"),
		`{"type":"user","cwd":"`+cwd+`","message":{"content":"fix login"}}`+"\n"+
			`{"type":"assistant","cwd":"`+cwd+`","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"`+cwd+`/src/a.ts"}}]}}`+"\n")
	list := claude.ReadSessions(home, time.Now())
	if len(list) != 1 || list[0].SessionID != "claude:"+id || list[0].Cwd != cwd || list[0].Provider != "claude" {
		t.Fatalf("%v", list)
	}

	codexHome := tmpHome(t)
	codexID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	codir := filepath.Join(codexHome, "sessions", "2026", "08", "25")
	file := filepath.Join(codir, "rollout-2026-08-25T10-00-00-"+codexID+".jsonl")
	write(t, file, `{"type":"session_meta","payload":{"cwd":"`+cwd+`","id":"`+codexID+`"}}`+"\n")
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	_ = os.Chtimes(file, now, now)
	cList := codex.ReadSessions(codexHome, now)
	if len(cList) != 1 || cList[0].SessionID != "codex:"+codexID || cList[0].Cwd != cwd {
		t.Fatalf("%v", cList)
	}

	hub := New("", func(any) {})
	hub.NoteHook(map[string]any{
		"provider":        "claude",
		"session_id":      "uuid-1",
		"cwd":             "/repo",
		"hook_event_name": "PreToolUse",
		"tool_name":       "Read",
		"tool_input":      map[string]any{"file_path": "/repo/src/a.ts"},
		"pid":             4242,
	})
	hub.ScanRoster()
	found := false
	for _, row := range hub.Roster {
		if row.SessionID == "claude:uuid-1" && row.PID == 4242 {
			found = true
		}
	}
	if !found {
		t.Fatalf("%v", hub.Roster)
	}
}
