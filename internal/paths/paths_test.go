package paths

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPidAlive(t *testing.T) {
	if PidAlive(0) || PidAlive(-3) {
		t.Fatal("invalid")
	}
	if !PidAlive(os.Getpid()) {
		t.Fatal("self")
	}
}

func TestJSONFileAndPeek(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "nested", "x.json")
	if err := WriteJSONFile(file, map[string]any{"a": 1}, true); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := ReadJSONFile(file, &got); err != nil || got["a"].(float64) != 1 {
		t.Fatalf("%v %v", got, err)
	}
	plain := filepath.Join(dir, "y.json")
	if err := WriteJSONFile(plain, map[string]any{"b": 2}, false); err != nil {
		t.Fatal(err)
	}

	jsonl := filepath.Join(dir, "log.jsonl")
	body := "{\"n\":1}\n\nnot-json\n{\"n\":2}\n{\"n\":3}\n"
	if err := os.WriteFile(jsonl, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	rows := PeekJSONL(jsonl, 2)
	if len(rows) != 2 || rows[0]["n"].(float64) != 1 || rows[1]["n"].(float64) != 2 {
		t.Fatalf("%v", rows)
	}
	if PeekJSONL(filepath.Join(dir, "missing.jsonl"), 4) != nil {
		t.Fatal("missing")
	}
}

func TestPlexusDirMigratesExplore(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	prev := filepath.Join(home, ".grok", "explore")
	if err := os.MkdirAll(prev, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prev, "prefs.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := PlexusDir()
	if dir != filepath.Join(home, ".plexus") {
		t.Fatalf("%s", dir)
	}
	if _, err := os.Stat(filepath.Join(dir, "prefs.json")); err != nil {
		t.Fatal("migrated")
	}
	again := PlexusDir()
	if again != dir {
		t.Fatal("stable")
	}
}

func TestRepoRootEnv(t *testing.T) {
	t.Setenv("PLEXUS_ROOT", "/tmp/plexus-root-test")
	if RepoRoot() != "/tmp/plexus-root-test" {
		t.Fatal(RepoRoot())
	}
}

func TestIsRepoWalk(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if walkRepo(nested) != root {
		t.Fatal(walkRepo(nested))
	}
	if walkRepo(t.TempDir()) != "" {
		t.Fatal("empty")
	}
	htmlRoot := t.TempDir()
	if err := os.Mkdir(filepath.Join(htmlRoot, "public"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(htmlRoot, "public", "index.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !isRepo(htmlRoot) || isRepo(t.TempDir()) {
		t.Fatal("html repo")
	}
}

func TestRepoRootFromBinLayout(t *testing.T) {
	t.Setenv("PLEXUS_ROOT", "")
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if isRepo(root) && walkRepo(bin) != root {
		t.Fatal(walkRepo(bin))
	}
	if RepoRoot() == "" {
		t.Fatal("cwd walk")
	}
}
