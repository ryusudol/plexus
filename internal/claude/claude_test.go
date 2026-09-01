package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ryusudol/plexus/internal/extract"
	"github.com/ryusudol/plexus/internal/hooks"
	"github.com/ryusudol/plexus/internal/jsonx"
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

func TestParseLine(t *testing.T) {
	hint := extract.SessionHint{SessionID: "s1", Cwd: "/repo"}
	user := ParseLine(`{"type":"user","cwd":"/repo","message":{"content":"fix it"}}`, hint)
	if !user.Prompt || user.Activity != "busy" {
		t.Fatalf("user %+v", user)
	}
	result := ParseLine(`{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}`, hint)
	if result.Prompt || result.Activity != "" {
		t.Fatalf("result %+v", result)
	}
	asst := ParseLine(`{"type":"assistant","cwd":"/repo","sessionId":"s1","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/repo/src/a.ts"}}]}}`, hint)
	if asst.Activity != "busy" || len(asst.Visits) != 1 || extract.FolderPath(&asst.Visits[0].Visit) != "/repo/src" {
		t.Fatalf("asst %+v", asst)
	}
	stop := ParseLine(`{"hook_event_name":"Stop"}`, hint)
	if stop.Activity != "idle" {
		t.Fatalf("stop %+v", stop)
	}
	if ParseLine("nope", hint).Activity != "" {
		t.Fatal("junk")
	}
}

func TestReadSessions(t *testing.T) {
	home := t.TempDir()
	cwd := "/Users/me/proj"
	id := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	dir := filepath.Join(home, "projects", "-Users-me-proj")
	file := filepath.Join(dir, id+".jsonl")
	write(t, file,
		`{"type":"custom-title","title":"Fix login"}`+"\n"+
			`{"type":"user","cwd":"`+cwd+`","message":{"content":"hi"}}`+"\n")
	now := time.Now()
	_ = os.Chtimes(file, now, now)
	list := ReadSessions(home, now)
	if len(list) != 1 || list[0].SessionID != "claude:"+id || list[0].Cwd != cwd || list[0].Title != "Fix login" {
		t.Fatalf("%v", list)
	}

	stale := filepath.Join(dir, "old.jsonl")
	write(t, stale, `{"type":"user","cwd":"`+cwd+`"}`+"\n")
	old := now.Add(-time.Hour)
	_ = os.Chtimes(stale, old, old)
	list = ReadSessions(home, now)
	if len(list) != 1 {
		t.Fatalf("stale %v", list)
	}

	write(t, filepath.Join(dir, "nocwd.jsonl"), `{"type":"assistant","message":{}}`+"\n")
	_ = os.Chtimes(filepath.Join(dir, "nocwd.jsonl"), now, now)
	write(t, filepath.Join(dir, "notes.txt"), "ignore\n")
	list = ReadSessions(home, now)
	if len(list) != 1 {
		t.Fatalf("filters %v", list)
	}
	if ReadSessions(filepath.Join(home, "missing"), now) != nil {
		t.Fatal("missing")
	}
}

func TestTitleFromRecords(t *testing.T) {
	if titleFromRecords([]map[string]any{{"type": "summary", "summary": "  hello  "}}, "/x") != "hello" {
		t.Fatal("summary")
	}
	if titleFromRecords(nil, "/Users/me/proj") != "proj" {
		t.Fatal("base")
	}
}

func TestInstallIdempotent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	bin := filepath.Join(t.TempDir(), "bin", "plexus")
	if err := Install(bin); err != nil {
		t.Fatal(err)
	}
	if err := Install(bin); err != nil {
		t.Fatal(err)
	}
	spec := hooks.LoadFile(filepath.Join(home, "settings.json"))
	hm := jsonx.AsMap(spec["hooks"])
	if len(jsonx.Slice(hm["SessionStart"])) != 1 {
		t.Fatalf("dup start %v", hm["SessionStart"])
	}
	for _, event := range []string{"PreToolUse", "UserPromptSubmit", "Stop"} {
		if len(jsonx.Slice(hm[event])) != 1 {
			t.Fatalf("dup %s %v", event, hm[event])
		}
	}
	blob, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	if !hooks.HasPlexusLauncher(string(blob)) || !hooks.HasPlexusHook(string(blob)) {
		t.Fatalf("%s", blob)
	}
	if strings.Contains(string(blob), "127.0.0.1:7733/hook") || strings.Contains(string(blob), `"type": "http"`) {
		t.Fatalf("http leftover %s", blob)
	}
}

func TestInstallMigratesHTTPHook(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	bin := filepath.Join(t.TempDir(), "bin", "plexus")
	file := filepath.Join(home, "settings.json")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	old := `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Write|Edit|Glob|Grep|NotebookEdit",
        "hooks": [{"type": "http", "url": "http://127.0.0.1:7733/hook", "timeout": 2}]
      }
    ]
  }
}
`
	if err := os.WriteFile(file, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Install(bin); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(blob), "127.0.0.1:7733/hook") {
		t.Fatalf("still http %s", blob)
	}
	spec := hooks.LoadFile(file)
	hm := jsonx.AsMap(spec["hooks"])
	if len(jsonx.Slice(hm["PreToolUse"])) != 1 {
		t.Fatalf("dup pre %v", hm["PreToolUse"])
	}
	for _, event := range []string{"PreToolUse", "UserPromptSubmit", "Stop"} {
		if !hooks.EventHasPlexusHook(hm, event) {
			t.Fatalf("missing %s %v", event, hm[event])
		}
	}
}

func TestHomeEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if Home() != dir {
		t.Fatal(Home())
	}
}
