package orca

import (
	"os"
	"path/filepath"
	"testing"
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

func sample(cwd, id, tab string) string {
	return `{
		"workspaceSession": {
			"activeWorktreeId": "wt::` + cwd + `",
			"activeTabId": "` + tab + `",
			"tabsByWorktree": {"wt::` + cwd + `": [{"id": "` + tab + `"}]},
			"terminalLayoutsByTabId": {"` + tab + `": {"activeLeafId": "leaf"}},
			"sleepingAgentSessionsByPaneKey": {
				"` + tab + `:leaf": {
					"tabId": "` + tab + `",
					"worktreeId": "wt::` + cwd + `",
					"providerSession": {"id": "` + id + `"}
				}
			}
		}
	}`
}

func TestReadFocusAndPanes(t *testing.T) {
	file := filepath.Join(t.TempDir(), "orca-data.json")
	cwd := "/Users/me/proj"
	id := "sess-9"
	write(t, file, sample(cwd, id, "tab-1"))
	focus := ReadFocus(file)
	if focus == nil || focus.Cwd != cwd || focus.SessionID != id {
		t.Fatalf("%v", focus)
	}
	if ReadActiveCwd(file) != cwd {
		t.Fatal("cwd")
	}
	panes, ok := ReadLivePanes(file)
	if !ok || panes[id].Cwd != cwd || panes[id].TabID != "tab-1" {
		t.Fatalf("%v %v", panes, ok)
	}
}

func TestIgnoreClosedTab(t *testing.T) {
	file := filepath.Join(t.TempDir(), "orca-data.json")
	write(t, file, `{
		"workspaceSession": {
			"activeWorktreeId": "wt::/repo",
			"activeTabId": "open",
			"tabsByWorktree": {"wt::/repo": [{"id": "open"}]},
			"sleepingAgentSessionsByPaneKey": {
				"closed:leaf": {
					"tabId": "closed",
					"worktreeId": "wt::/repo",
					"providerSession": {"id": "gone"}
				}
			}
		}
	}`)
	panes, ok := ReadLivePanes(file)
	if !ok {
		t.Fatal("saw file")
	}
	if _, exists := panes["gone"]; exists {
		t.Fatalf("%v", panes)
	}
}

func TestDataFilesEnv(t *testing.T) {
	file := filepath.Join(t.TempDir(), "orca-data.json")
	write(t, file, `{}`)
	t.Setenv("ORCA_DATA_FILE", file)
	files := DataFiles()
	if len(files) != 1 || files[0] != file {
		t.Fatalf("%v", files)
	}
}

func TestCwdFromWorktreeID(t *testing.T) {
	if cwdFromWorktreeID("wt::/Users/me/proj") != "/Users/me/proj" {
		t.Fatal("cwd")
	}
	if cwdFromWorktreeID("nope") != "" {
		t.Fatal("empty")
	}
}

func TestMissingFile(t *testing.T) {
	if ReadFocus(filepath.Join(t.TempDir(), "no.json")) != nil {
		t.Fatal("focus")
	}
	if _, ok := ReadLivePanes(filepath.Join(t.TempDir(), "no.json")); ok {
		t.Fatal("panes")
	}
}

func TestDataFilesFromProfiles(t *testing.T) {
	t.Setenv("ORCA_DATA_FILE", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if DataFiles() != nil {
		t.Fatal("missing profiles")
	}
	file := filepath.Join(home, "Library/Application Support/orca/profiles/p1/orca-data.json")
	write(t, file, `{}`)
	if err := os.Mkdir(filepath.Join(home, "Library/Application Support/orca/profiles/empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := DataFiles()
	if len(files) != 1 || files[0] != file {
		t.Fatalf("%v", files)
	}
}

func TestTabIdByWorktreeAndFallbackScan(t *testing.T) {
	file := filepath.Join(t.TempDir(), "orca-data.json")
	write(t, file, `{
		"workspaceSession": {
			"activeWorktreeId": "wt::/repo",
			"activeTabIdByWorktree": {"wt::/repo": "tab-2"},
			"tabsByWorktree": {"wt::/repo": [{"id": "tab-2"}]},
			"sleepingAgentSessionsByPaneKey": {
				"tab-2:other": {
					"tabId": "tab-2",
					"worktreeId": "wt::/repo",
					"providerSession": {"id": "from-scan"}
				}
			}
		}
	}`)
	focus := ReadFocus(file)
	if focus == nil || focus.SessionID != "from-scan" || focus.Cwd != "/repo" {
		t.Fatalf("%v", focus)
	}
}

func TestEmptyTabAndUIFallback(t *testing.T) {
	file := filepath.Join(t.TempDir(), "orca-data.json")
	write(t, file, `{
		"ui": {"lastActiveWorktreeId": "wt::/from-ui"},
		"workspaceSession": {
			"sleepingAgentSessionsByPaneKey": {
				"x:y": {"tabId": "x", "worktreeId": "wt::/from-ui", "providerSession": {"id": "p"}}
			}
		}
	}`)
	focus := ReadFocus(file)
	if focus == nil || focus.Cwd != "/from-ui" {
		t.Fatalf("%v", focus)
	}
	if focus.SessionID != "" {
		t.Fatalf("no tab %v", focus)
	}
}

func TestReadLivePanesEdges(t *testing.T) {
	t.Setenv("ORCA_DATA_FILE", "")
	t.Setenv("HOME", t.TempDir())
	if _, ok := ReadLivePanes(""); ok {
		t.Fatal("no files")
	}

	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.json")
	write(t, bad, `{`)
	if _, ok := ReadLivePanes(bad); ok {
		t.Fatal("invalid")
	}

	empty := filepath.Join(dir, "empty.json")
	write(t, empty, `{"workspaceSession":{}}`)
	panes, ok := ReadLivePanes(empty)
	if !ok || len(panes) != 0 {
		t.Fatalf("%v %v", panes, ok)
	}

	skip := filepath.Join(dir, "skip.json")
	write(t, skip, `{
		"workspaceSession": {
			"tabsByWorktree": {"wt::/r": [{"id": "open"}, "nope"]},
			"sleepingAgentSessionsByPaneKey": {
				"a": null,
				"b": {"tabId": "open", "worktreeId": "wt::/r", "providerSession": {}},
				"c": {"tabId": "open", "worktreeId": "wt::/r", "providerSession": {"id": "ok"}}
			}
		}
	}`)
	panes, ok = ReadLivePanes(skip)
	if !ok || panes["ok"].TabID != "open" || len(panes) != 1 {
		t.Fatalf("%v", panes)
	}
}

func TestReadFocusInvalidAndActiveCwd(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "x.json")
	write(t, bad, `{`)
	if ReadFocus(bad) != nil {
		t.Fatal("bad")
	}
	if ReadActiveCwd(filepath.Join(t.TempDir(), "no.json")) != "" {
		t.Fatal("cwd")
	}
}
