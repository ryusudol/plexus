package roster

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryusudol/plexus/internal/orca"
	"github.com/ryusudol/plexus/internal/types"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEncodeCwdAndSessionDir(t *testing.T) {
	home := t.TempDir()
	cwd := "/Users/me/proj"
	id := "sess-1"
	direct := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
	if err := os.MkdirAll(direct, 0o755); err != nil {
		t.Fatal(err)
	}
	if SessionDir(cwd, id, home) != direct {
		t.Fatal("direct")
	}
	if SessionDir("/missing", id, home) != direct {
		t.Fatalf("lookup %s", SessionDir("/missing", id, home))
	}
	missing := SessionDir("/nope", "no-such", home)
	if missing != filepath.Join(home, "sessions", EncodeCwd("/nope"), "no-such") {
		t.Fatal(missing)
	}
}

func TestUpdatesPath(t *testing.T) {
	if UpdatesPath(types.SessionRow{Updates: "/tmp/x.jsonl"}, "") != "/tmp/x.jsonl" {
		t.Fatal("explicit")
	}
	home := t.TempDir()
	cwd := "/repo"
	id := "abc"
	dir := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	got := UpdatesPath(types.SessionRow{SessionID: id, Cwd: cwd}, home)
	if got != filepath.Join(dir, "updates.jsonl") {
		t.Fatal(got)
	}
}

func TestPickFocusedSession(t *testing.T) {
	if PickFocusedSession(nil, orca.Focus{Cwd: "/a"}) != nil {
		t.Fatal("empty")
	}
	list := []types.SessionRow{
		{SessionID: "a", Cwd: "/repo", Live: false, Mtime: 9},
		{SessionID: "b", Cwd: "/repo", Live: true, Mtime: 1},
		{SessionID: "c", Cwd: "/repo/src", Live: true, Mtime: 5},
	}
	if got := PickFocusedSession(list, orca.Focus{SessionID: "c"}); got == nil || got.SessionID != "c" {
		t.Fatal("id")
	}
	if got := PickFocusedSession(list, orca.Focus{Cwd: "/repo"}); got == nil || got.SessionID != "b" {
		t.Fatal("live exact")
	}
	if got := PickFocusedSession(list, orca.Focus{Cwd: "/repo/src"}); got == nil || got.SessionID != "c" {
		t.Fatal("nested")
	}
	if PickFocusedSession(list, orca.Focus{Cwd: "/other"}) != nil {
		t.Fatal("miss")
	}
}

func TestFingerprint(t *testing.T) {
	a := []types.SessionRow{{SessionID: "a", PID: 1, Cwd: "/x", Title: "A", Live: true}}
	b := []types.SessionRow{{SessionID: "a", PID: 1, Cwd: "/x", Title: "A", Live: false}}
	if Fingerprint(a) == Fingerprint(b) {
		t.Fatal("live bit")
	}
}

func TestReadActiveSessionsDropsDead(t *testing.T) {
	home := t.TempDir()
	cwd := "/Users/me/proj"
	id := "live-1"
	dir := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
	write(t, filepath.Join(dir, "summary.json"), `{"generated_title":"Hi","agent_name":"grok-build"}`)
	write(t, filepath.Join(dir, "updates.jsonl"), "")
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+id+`","pid":`+itoa(os.Getpid())+`,"cwd":"`+cwd+`"},{"session_id":"dead","pid":-1,"cwd":"`+cwd+`"}]`)
	list := ReadActiveSessions(home, nil, true)
	if len(list) != 1 || list[0].SessionID != id || list[0].Title != "Hi" {
		t.Fatalf("%v", list)
	}
}

func TestReadActiveSessionsOrcaFallback(t *testing.T) {
	home := t.TempDir()
	id := "pane-1"
	cwd := "/Users/me/proj"
	dir := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
	write(t, filepath.Join(dir, "summary.json"), `{"generated_title":"Pane"}`)
	write(t, filepath.Join(dir, "updates.jsonl"), "")
	panes := map[string]orca.Pane{id: {SessionID: id, Cwd: cwd}}
	list := ReadActiveSessions(home, panes, true)
	if len(list) != 1 || list[0].SessionID != id {
		t.Fatalf("no active file %v", list)
	}
	write(t, filepath.Join(home, "active_sessions.json"), `[]`)
	list = ReadActiveSessions(home, panes, true)
	if len(list) != 0 {
		t.Fatalf("active file wins %v", list)
	}
}

func TestGrokHomeEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GROK_HOME", dir)
	if GrokHome() != dir {
		t.Fatal(GrokHome())
	}
	t.Setenv("GROK_HOME", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if GrokHome() != filepath.Join(home, ".grok") {
		t.Fatal(GrokHome())
	}
}

func TestSessionDirEmptyHomeAndSkips(t *testing.T) {
	home := t.TempDir()
	t.Setenv("GROK_HOME", home)
	cwd := "/repo"
	id := "s1"
	direct := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
	if err := os.MkdirAll(direct, 0o755); err != nil {
		t.Fatal(err)
	}
	if SessionDir(cwd, id, "") != direct {
		t.Fatal("empty home")
	}
	write(t, filepath.Join(home, "sessions", "not-a-dir"), "x")
	if SessionDir("/missing", id, home) != direct {
		t.Fatal("skip file")
	}
	if UpdatesPath(types.SessionRow{NativeID: id, Cwd: cwd}, "") != filepath.Join(direct, "updates.jsonl") {
		t.Fatal("native")
	}
}

func TestReadSummaryAndActiveRows(t *testing.T) {
	home := t.TempDir()
	if readSummary(types.SessionRow{SessionID: "x", Cwd: "/r"}, home) != nil {
		t.Fatal("missing")
	}
	dir := filepath.Join(home, "sessions", EncodeCwd("/r"), "x")
	write(t, filepath.Join(dir, "summary.json"), "{")
	if readSummary(types.SessionRow{SessionID: "x", Cwd: "/r"}, home) != nil {
		t.Fatal("bad json")
	}
	write(t, filepath.Join(home, "active_sessions.json"), "{")
	if readActiveSessionRows(home) != nil {
		t.Fatal("active json")
	}
	write(t, filepath.Join(home, "active_sessions.json"), `[{"session_id":"","cwd":"/r"},{"session_id":"a","cwd":""}]`)
	if len(readActiveSessionRows(home)) != 0 {
		t.Fatal("skip empty")
	}
}

func TestFindSessionCwd(t *testing.T) {
	home := t.TempDir()
	if findSessionCwd("x", home) != "" {
		t.Fatal("missing root")
	}
	id := "pane-cwd"
	cwd := "/Users/me/proj"
	if err := os.MkdirAll(filepath.Join(home, "sessions", EncodeCwd(cwd), id), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(home, "sessions", "file"), "x")
	if findSessionCwd(id, home) != cwd {
		t.Fatal(findSessionCwd(id, home))
	}
	bad := filepath.Join(home, "sessions", "%", "other")
	if err := os.MkdirAll(bad, 0o755); err != nil {
		t.Fatal(err)
	}
	if findSessionCwd("other", home) != "%" {
		t.Fatal(findSessionCwd("other", home))
	}
	if findSessionCwd("nope", home) != "" {
		t.Fatal("miss")
	}
}

func TestSiblingOnPaneAndMerge(t *testing.T) {
	home := t.TempDir()
	cwd := "/proj"
	pid := os.Getpid()
	for _, id := range []string{"keep", "drop"} {
		dir := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
		write(t, filepath.Join(dir, "summary.json"), `{"generated_title":"`+id+`"}`)
		write(t, filepath.Join(dir, "updates.jsonl"), "")
	}
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"keep","pid":`+itoa(pid)+`,"cwd":"`+cwd+`"},{"session_id":"drop","pid":`+itoa(pid)+`,"cwd":"`+cwd+`"}]`)
	panes := map[string]orca.Pane{"keep": {SessionID: "keep", Cwd: cwd}}
	list := ReadActiveSessions(home, panes, true)
	if len(list) != 1 || list[0].SessionID != "keep" {
		t.Fatalf("%v", list)
	}
	if paneListed(nil, "keep") {
		t.Fatal("nil panes")
	}
	if siblingOnPane(nil, nil, false, types.SessionRow{PID: 1}) {
		t.Fatal("no panes")
	}
}

func TestOrcaFallbackFindsCwd(t *testing.T) {
	home := t.TempDir()
	id := "orphan"
	cwd := "/Users/me/proj"
	dir := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
	write(t, filepath.Join(dir, "summary.json"), `{"generated_title":"Orphan"}`)
	write(t, filepath.Join(dir, "updates.jsonl"), "")
	panes := map[string]orca.Pane{id: {SessionID: id}}
	list := ReadActiveSessions(home, panes, true)
	if len(list) != 1 || list[0].Cwd != cwd || list[0].Title != "Orphan" {
		t.Fatalf("%v", list)
	}
	empty := ReadActiveSessions(home, map[string]orca.Pane{"ghost": {SessionID: "ghost"}}, true)
	if len(empty) != 0 {
		t.Fatalf("ghost %v", empty)
	}
}

func TestReadAllSessions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("GROK_HOME", home)
	claudeHome := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", claudeHome)
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("ORCA_DATA_FILE", filepath.Join(home, "missing-orca.json"))

	cwd := "/Users/me/proj"
	pid := os.Getpid()
	id := "g1"
	dir := filepath.Join(home, "sessions", EncodeCwd(cwd), id)
	write(t, filepath.Join(dir, "summary.json"), `{"generated_title":"Grok"}`)
	write(t, filepath.Join(dir, "updates.jsonl"), "")
	write(t, filepath.Join(home, "active_sessions.json"),
		`[{"session_id":"`+id+`","pid":`+itoa(pid)+`,"cwd":"`+cwd+`"}]`)

	cid := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	cfile := filepath.Join(claudeHome, "projects", "-Users-me-proj", cid+".jsonl")
	write(t, cfile, `{"type":"user","cwd":"`+cwd+`","message":{"content":"hi"}}`+"\n")

	now := time.Now()
	_ = os.Chtimes(cfile, now, now)

	list := ReadAllSessions("")
	found := map[string]bool{}
	for _, row := range list {
		found[row.SessionID] = true
	}
	if !found[id] || !found["claude:"+cid] {
		t.Fatalf("%v", list)
	}
}

func TestPickFocusedUnknownID(t *testing.T) {
	list := []types.SessionRow{{SessionID: "a", Cwd: "/repo", Live: true}}
	if PickFocusedSession(list, orca.Focus{SessionID: "missing"}) != nil {
		t.Fatal("id without cwd")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
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
