package fstree

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListFolders(t *testing.T) {
	root := t.TempDir()
	mkdir := func(name string) {
		t.Helper()
		if err := os.Mkdir(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mkdir("src")
	mkdir("lib")
	mkdir("node_modules")
	mkdir(".git")
	mkdir(".cache")
	mkdir(".grok")
	mkdir("vendor")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "src")
	if err := os.Symlink(target, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "src", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := ListFolders(root)
	names := map[string]bool{}
	for _, c := range got {
		names[c.Name] = true
		if c.Name == "src" && !c.HasChildren {
			t.Fatal("src should have children")
		}
		if c.Name == "lib" && c.HasChildren {
			t.Fatal("lib empty")
		}
	}
	if !names["src"] || !names["lib"] || !names[".grok"] {
		t.Fatalf("kept %v", names)
	}
	if names["node_modules"] || names[".git"] || names[".cache"] || names["vendor"] || names["link"] {
		t.Fatalf("ignored %v", names)
	}
	if got[0].Name != ".grok" || got[1].Name != "lib" || got[2].Name != "src" {
		t.Fatalf("sort %v", got)
	}
	if len(ListFolders(filepath.Join(root, "missing"))) != 0 {
		t.Fatal("missing")
	}
}

func TestFolderName(t *testing.T) {
	if FolderName("/repo", "/repo") != "repo" {
		t.Fatal("root")
	}
	if FolderName("/repo/src", "/repo") != "src" {
		t.Fatal("child")
	}
}

func TestIsIgnored(t *testing.T) {
	if !isIgnored("node_modules") || !isIgnored(".env") || isIgnored(".grok") || isIgnored("src") {
		t.Fatal("ignore")
	}
}
