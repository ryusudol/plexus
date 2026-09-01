package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func isolate(t *testing.T) (home, workspace, root string) {
	t.Helper()
	home = t.TempDir()
	workspace = t.TempDir()
	root = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("GROK_HOME", filepath.Join(home, ".grok"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("PLEXUS_ROOT", workspace)
	t.Setenv("ORCA_DATA_FILE", filepath.Join(home, "orca-data.json"))
	if err := os.Mkdir(filepath.Join(workspace, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	return home, workspace, root
}

func do(s *Server, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	s.ServeHTTP(rec, req)
	return rec
}

func assertHookSilent(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("hook body %q", rec.Body.Bytes())
	}
}

func TestHealthAndUnknown(t *testing.T) {
	_, _, root := isolate(t)
	s := New(root)
	rec := do(s, http.MethodGet, "/api/health", "")
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	var body map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &body) != nil || body["ok"] != true {
		t.Fatalf("%s", rec.Body.Bytes())
	}
	rec = do(s, http.MethodGet, "/api/nope", "")
	if rec.Code != 404 {
		t.Fatal(rec.Code)
	}
}

func TestHookAllowAndVisit(t *testing.T) {
	_, ws, root := isolate(t)
	s := New(root)
	rec := do(s, http.MethodPost, "/hook", `{`)
	assertHookSilent(t, rec)

	rec = do(s, http.MethodPost, "/hook", "")
	assertHookSilent(t, rec)

	payload := `{
		"hook_event_name": "PreToolUse",
		"session_id": "uuid-1",
		"tool_name": "Read",
		"tool_input": {"file_path": "` + ws + `/src/app.ts"},
		"cwd": "` + ws + `"
	}`
	rec = do(s, http.MethodPost, "/hook", payload)
	assertHookSilent(t, rec)

	state := do(s, http.MethodGet, "/api/state", "")
	var snap map[string]any
	if json.Unmarshal(state.Body.Bytes(), &snap) != nil {
		t.Fatal(state.Body.String())
	}
	sessions, _ := snap["sessions"].([]any)
	found := false
	for _, raw := range sessions {
		row := raw.(map[string]any)
		if row["id"] == "claude:uuid-1" && row["provider"] == "claude" {
			found = true
		}
	}
	if !found {
		t.Fatalf("%v", snap["sessions"])
	}

	rec = do(s, http.MethodPost, "/api/visit", `{
		"hook_event_name": "PreToolUse",
		"session_id": "uuid-1",
		"tool_name": "Bash",
		"tool_input": {"command": "ls"},
		"cwd": "`+ws+`"
	}`)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
}

func TestPrefsAttachRootChildren(t *testing.T) {
	_, ws, root := isolate(t)
	s := New(root)

	rec := do(s, http.MethodGet, "/api/prefs", "")
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}

	rec = do(s, http.MethodPost, "/api/prefs", `{"graphFollow":"project","sessionId":"keep","accent":"#fff","agentSpeed":"fast"}`)
	var p map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &p) != nil {
		t.Fatal(rec.Body.String())
	}
	if p["graphFollow"] != "project" || p["sessionId"] != "keep" {
		t.Fatalf("%v", p)
	}
	if p["accent"] == "#fff" {
		t.Fatal("invalid accent")
	}
	if s.hub.GetFollowMode() != "project" {
		t.Fatal(s.hub.GetFollowMode())
	}

	rec = do(s, http.MethodPost, "/api/root", `{"path":"`+ws+`/src"}`)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var rooted map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &rooted) != nil || rooted["name"] != "src" {
		t.Fatalf("%v", rooted)
	}
	rec = do(s, http.MethodPost, "/api/root", `{"path":"/no-such-plexus-dir"}`)
	if rec.Code != 400 {
		t.Fatal(rec.Code)
	}

	rec = do(s, http.MethodGet, "/api/children?path="+ws, "")
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var kids map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &kids) != nil {
		t.Fatal(rec.Body.String())
	}
	list := kids["children"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["name"] != "src" {
		t.Fatalf("%v", kids)
	}
	rec = do(s, http.MethodGet, "/api/children?path=/no-such-plexus-dir", "")
	if rec.Code != 404 {
		t.Fatal(rec.Code)
	}

	s.hub.NoteHook(map[string]any{
		"provider": "claude", "session_id": "uuid-1", "cwd": ws,
		"hook_event_name": "PreToolUse", "tool_name": "Read",
		"tool_input": map[string]any{"file_path": ws + "/src/a.ts"},
	})
	s.hub.ScanRoster()
	rec = do(s, http.MethodPost, "/api/attach", `{"sessionId":"claude:uuid-1"}`)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if s.hub.Selected() != "claude:uuid-1" {
		t.Fatal(s.hub.Selected())
	}
}

func TestSafeResolve(t *testing.T) {
	_, ws, root := isolate(t)
	s := New(root)
	if s.safeResolve("") != "" {
		t.Fatal("empty")
	}
	if s.safeResolve(ws) == "" {
		t.Fatal("dir")
	}
	file := filepath.Join(ws, "src", "a.ts")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if s.safeResolve(file) != filepath.Join(ws, "src") {
		t.Fatal(s.safeResolve(file))
	}
	if s.safeResolve(filepath.Join(ws, "missing")) != "" {
		t.Fatal("missing")
	}
}

func TestOrLabel(t *testing.T) {
	if orLabel("main", "claude") != "main" {
		t.Fatal("keep")
	}
	if orLabel("", "claude") != "claude" {
		t.Fatal("provider")
	}
	if orLabel("", "") != "agent" {
		t.Fatal("default")
	}
}

func TestNewFromPrefsAndEnv(t *testing.T) {
	home, ws, root := isolate(t)
	t.Setenv("PLEXUS_ROOT", "")
	t.Setenv("GROK_EXPLORE_ROOT", ws)
	dir := filepath.Join(home, ".plexus")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "prefs.json"), []byte(`{"graphFollow":"project","sessionId":"sess-1"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(root)
	if s.hub.GetFollowMode() != "project" {
		t.Fatal(s.hub.GetFollowMode())
	}
	if s.hub.SelectedID != "sess-1" {
		t.Fatal(s.hub.SelectedID)
	}
	if s.workspace != ws {
		t.Fatal(s.workspace)
	}
}

func TestHookNonObjectAndVisitAgentID(t *testing.T) {
	_, ws, root := isolate(t)
	s := New(root)
	rec := do(s, http.MethodPost, "/hook", `[]`)
	assertHookSilent(t, rec)
	rec = do(s, http.MethodPost, "/hook", `{
		"tool_name": "Read",
		"tool_input": {"file_path": "`+ws+`/src/a.ts"},
		"cwd": "`+ws+`"
	}`)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
}

func TestRootPlainBodyChildrenDefaultAndFocusRefresh(t *testing.T) {
	_, ws, root := isolate(t)
	s := New(root)
	rec := do(s, http.MethodPost, "/api/root", ws+"/src")
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	rec = do(s, http.MethodGet, "/api/children", "")
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	do(s, http.MethodPost, "/api/prefs", `{"graphFollow":"project"}`)
	rec = do(s, http.MethodPost, "/api/prefs", `{"graphFollow":"focus"}`)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	if s.hub.GetFollowMode() != "focus" {
		t.Fatal(s.hub.GetFollowMode())
	}
}

func TestInstallHooks(t *testing.T) {
	home, _, root := isolate(t)
	s := New(root)
	bin := filepath.Join(root, "bin", "plexus")
	s.installHooks(bin)
	if _, err := os.Stat(filepath.Join(home, ".grok", "hooks", "plexus.json")); err != nil {
		t.Fatal("grok hooks")
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); err != nil {
		t.Fatal("claude")
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "hooks.json")); err != nil {
		t.Fatal("codex")
	}
}

func TestServeStaticAndForbidden(t *testing.T) {
	_, _, root := isolate(t)
	if err := os.MkdirAll(filepath.Join(root, "public"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "public", "index.html"), []byte("<html>ok</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "public", "app.css"), []byte("body{}"+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "public", "notes.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "lib", "under.ts"), []byte("export const n: number = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(root)
	rec := do(s, http.MethodGet, "/", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "ok") {
		t.Fatalf("index %d %s", rec.Code, rec.Body.String())
	}
	rec = do(s, http.MethodGet, "/app.css", "")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/css; charset=utf-8" {
		t.Fatalf("css %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	rec = do(s, http.MethodGet, "/notes.txt", "")
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	rec = do(s, http.MethodGet, "/lib/under.ts", "")
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("ts %d %s %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "export") {
		t.Fatalf("transpile %s", rec.Body.String())
	}
	rec = do(s, http.MethodGet, "/../go.mod", "")
	if rec.Code != 403 && rec.Code != 404 {
		t.Fatal(rec.Code)
	}
	rec = do(s, http.MethodGet, "/missing.js", "")
	if rec.Code != 404 {
		t.Fatal(rec.Code)
	}
}

func TestStreamAndVisitDedup(t *testing.T) {
	_, ws, root := isolate(t)
	s := New(root)
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })

	payload := `{
		"hook_event_name": "PreToolUse",
		"session_id": "s1",
		"tool_name": "read_file",
		"tool_input": {"target_file": "` + ws + `/src/a.ts"},
		"cwd": "` + ws + `"
	}`
	for i := 0; i < 2; i++ {
		post, err := http.Post(ts.URL+"/hook", "application/json", strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, post.Body)
		post.Body.Close()
	}
	time.Sleep(50 * time.Millisecond)
	cancel()
	body, _ := io.ReadAll(res.Body)
	text := string(body)
	if !strings.Contains(text, "snapshot") {
		t.Fatalf("%s", text)
	}
	if strings.Count(text, `"type":"visit"`) > 1 {
		t.Fatalf("dedup %s", text)
	}
}

func TestDeref(t *testing.T) {
	if deref(nil) != "" {
		t.Fatal("nil")
	}
	s := "x"
	if deref(&s) != "x" {
		t.Fatal("val")
	}
}
