package hooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryusudol/plexus/internal/jsonx"
)

func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func TestHasMatchers(t *testing.T) {
	if !HasPlexusLauncher(`/tmp/bin/plexus --ensure`) || HasPlexusLauncher(`/tmp/plexus --ensure`) {
		t.Fatal("launcher")
	}
	if !HasPlexusHook(`plexus --hook --source claude`) || !HasPlexusHook(`node plexus-hook.js`) {
		t.Fatal("hook")
	}
	if !HasHTTPHook(`http://127.0.0.1:7733/hook`) || !HasHTTPHook(`--hook`) || HasHTTPHook(`curl example.com`) {
		t.Fatal("http")
	}
}

func TestMigrateLauncherCommands(t *testing.T) {
	bin := `/tmp/app/bin/plexus`
	hm := map[string]any{
		"SessionStart": []any{
			map[string]any{"hooks": []any{
				map[string]any{"type": "command", "command": `node plexus.ts --ensure`},
			}},
		},
		"PreToolUse": []any{
			map[string]any{"hooks": []any{
				map[string]any{"type": "command", "command": `node plexus-hook --source claude`},
			}},
		},
		"Stop": []any{
			map[string]any{"hooks": []any{
				map[string]any{"type": "command", "command": `node plexus-hook --source codex`},
			}},
		},
		"Other": "skip",
	}
	MigrateLauncherCommands(hm, bin)
	cmdOf := func(event string) string {
		group := jsonx.AsMap(jsonx.Slice(hm[event])[0])
		hook := jsonx.AsMap(jsonx.Slice(group["hooks"])[0])
		return jsonx.Str(hook["command"])
	}
	if cmdOf("SessionStart") != `"/tmp/app/bin/plexus" --ensure` {
		t.Fatalf("ensure %q", cmdOf("SessionStart"))
	}
	if cmdOf("PreToolUse") != `"/tmp/app/bin/plexus" --hook --source claude` {
		t.Fatalf("claude %q", cmdOf("PreToolUse"))
	}
	if cmdOf("Stop") != `"/tmp/app/bin/plexus" --hook --source codex` {
		t.Fatalf("codex %q", cmdOf("Stop"))
	}
}

func TestLoadSavePush(t *testing.T) {
	file := filepath.Join(t.TempDir(), "nested", "hooks.json")
	got := LoadFile(file)
	if jsonx.AsMap(got["hooks"]) == nil {
		t.Fatal("missing file")
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if jsonx.AsMap(LoadFile(file)["hooks"]) == nil {
		t.Fatal("invalid json")
	}

	hm := map[string]any{}
	EnsureList(hm, "PreToolUse")
	PushGroup(hm, "PreToolUse", CommandGroup(`"/bin/plexus" --ensure`, 8))
	if len(jsonx.Slice(hm["PreToolUse"])) != 1 {
		t.Fatalf("%v", hm)
	}
	spec := map[string]any{"hooks": hm}
	if err := SaveFile(file, spec); err != nil {
		t.Fatal(err)
	}
	reload := LoadFile(file)
	if jsonx.AsMap(reload["hooks"])["PreToolUse"] == nil {
		t.Fatalf("%v", reload)
	}
}

func TestInstallGrokWritesRepoNotApp(t *testing.T) {
	home := isolateHome(t)
	repo := t.TempDir()
	staleRepo := filepath.Join(repo, "hooks", "grok-explore.json")
	if err := os.MkdirAll(filepath.Dir(staleRepo), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staleRepo, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	staleHome := filepath.Join(home, ".grok", "hooks", "grok-explore.json")
	if err := os.MkdirAll(filepath.Dir(staleHome), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staleHome, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	url := InstallGrok(repo, `/tmp/bin/plexus`)
	if !strings.Contains(url, "/hook") {
		t.Fatalf("url %q", url)
	}
	homeHook := filepath.Join(home, ".grok", "hooks", "plexus.json")
	repoHook := filepath.Join(repo, "hooks", "plexus.json")
	for _, p := range []string{homeHook, repoHook} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		var spec map[string]any
		if json.Unmarshal(b, &spec) != nil {
			t.Fatal(p)
		}
		hm := jsonx.AsMap(spec["hooks"])
		if hm["SessionStart"] == nil || hm["PreToolUse"] == nil {
			t.Fatalf("%s %v", p, spec)
		}
	}
	if _, err := os.Stat(staleRepo); !os.IsNotExist(err) {
		t.Fatal("repo stale")
	}
	if _, err := os.Stat(staleHome); !os.IsNotExist(err) {
		t.Fatal("home stale")
	}

	appRoot := filepath.Join(t.TempDir(), "Plexus.app", "Contents", "Resources")
	if err := os.MkdirAll(appRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	InstallGrok(appRoot, `/tmp/bin/plexus`)
	if _, err := os.Stat(filepath.Join(appRoot, "hooks", "plexus.json")); !os.IsNotExist(err) {
		t.Fatal("must not write into signed app")
	}
	if _, err := os.Stat(homeHook); err != nil {
		t.Fatal("still write user hooks")
	}
}

func TestEnsureListReplacesNonList(t *testing.T) {
	hm := map[string]any{"PreToolUse": "bad"}
	EnsureList(hm, "PreToolUse")
	if _, ok := hm["PreToolUse"].([]any); !ok {
		t.Fatalf("%T", hm["PreToolUse"])
	}
}
