package codex

import (
	"os"
	"path/filepath"
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
	user := ParseLine(`{"payload":{"type":"message","role":"user"}}`, hint)
	if !user.Prompt || user.Activity != "busy" {
		t.Fatalf("user %+v", user)
	}
	call := ParseLine(`{"type":"response_item","payload":{"type":"function_call","name":"apply_patch","call_id":"c1","arguments":"*** Begin Patch\n*** Update File: /repo/web/app.js\n@@\n-a\n+b\n*** End Patch\n"}}`, hint)
	if call.Activity != "busy" || len(call.Visits) != 1 || extract.FilePath(&call.Visits[0].Visit) != "/repo/web/app.js" {
		t.Fatalf("call %+v", call)
	}
	shell := ParseLine(`{"payload":{"type":"local_shell_call","action":{"command":["ls"]}}}`, hint)
	if shell.Activity != "busy" || len(shell.Visits) != 0 {
		t.Fatalf("shell %+v", shell)
	}
	done := ParseLine(`{"type":"event_msg","payload":{"type":"task_complete"}}`, hint)
	if done.Activity != "idle" {
		t.Fatalf("done %+v", done)
	}
	if ParseLine("{", hint).Activity != "" {
		t.Fatal("junk")
	}

	prompt := ParseLine(`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"hi"}]}}}`, hint)
	if !prompt.Prompt || prompt.Activity != "busy" {
		t.Fatalf("user message %+v", prompt)
	}
	read := ParseLine(`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"exec-1","cwd":"file:///repo","parsed_cmd":[{"type":"read","path":"web/app.js"}]}}}`, hint)
	if read.Activity != "busy" || len(read.Visits) != 1 || extract.FilePath(&read.Visits[0].Visit) != "/repo/web/app.js" {
		t.Fatalf("command %+v", read)
	}
	exec := ParseLine(`{"payload":{"type":"custom_tool_call","name":"exec","input":"await tools.exec_command({cmd:\"ls\"})"}}`, hint)
	if exec.Activity != "busy" || len(exec.Visits) != 0 {
		t.Fatalf("exec %+v", exec)
	}
}

func TestReadSessions(t *testing.T) {
	home := t.TempDir()
	cwd := "/Users/me/proj"
	id := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	file := filepath.Join(home, "sessions", "2026", "08", "25", "rollout-2026-08-25T10-00-00-"+id+".jsonl")
	write(t, file, `{"type":"session_meta","payload":{"cwd":"`+cwd+`","id":"`+id+`"}}`+"\n")
	_ = os.Chtimes(file, now, now)
	list := ReadSessions(home, now)
	if len(list) != 1 || list[0].SessionID != "codex:"+id || list[0].Cwd != cwd {
		t.Fatalf("%v", list)
	}

	write(t, filepath.Join(filepath.Dir(file), "notes.txt"), "ignore\n")
	oldID := "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"
	stale := filepath.Join(filepath.Dir(file), "rollout-2026-08-25T01-00-00-"+oldID+".jsonl")
	write(t, stale, `{"type":"session_meta","payload":{"cwd":"`+cwd+`"}}`+"\n")
	_ = os.Chtimes(stale, now.Add(-time.Hour), now.Add(-time.Hour))
	list = ReadSessions(home, now)
	if len(list) != 1 {
		t.Fatalf("stale %v", list)
	}

	otherDay := filepath.Join(home, "sessions", "2026", "08", "01", "rollout-2026-08-01T10-00-00-"+oldID+".jsonl")
	write(t, otherDay, `{"type":"session_meta","payload":{"cwd":"`+cwd+`"}}`+"\n")
	_ = os.Chtimes(otherDay, now, now)
	list = ReadSessions(home, now)
	if len(list) != 1 {
		t.Fatalf("old day %v", list)
	}
}

func TestInstallIdempotent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	bin := filepath.Join(t.TempDir(), "bin", "plexus")
	if err := Install(bin); err != nil {
		t.Fatal(err)
	}
	if err := Install(bin); err != nil {
		t.Fatal(err)
	}
	spec := hooks.LoadFile(filepath.Join(home, "hooks.json"))
	hm := jsonx.AsMap(spec["hooks"])
	if len(jsonx.Slice(hm["SessionStart"])) != 1 {
		t.Fatalf("dup start %v", hm["SessionStart"])
	}
	for _, event := range []string{"PreToolUse", "UserPromptSubmit", "Stop"} {
		if len(jsonx.Slice(hm[event])) != 1 {
			t.Fatalf("dup %s %v", event, hm[event])
		}
	}
}

func TestHomeEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	if Home() != dir {
		t.Fatal(Home())
	}
}

func TestOrBase(t *testing.T) {
	if orBase("/Users/me/proj", "codex") != "proj" {
		t.Fatal("base")
	}
}
