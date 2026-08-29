package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ryusudol/plexus/internal/config"
	"github.com/ryusudol/plexus/internal/paths"
)

func TestShQuoteAndWrapper(t *testing.T) {
	if shQuote("a'b") != `'a'"'"'b'` {
		t.Fatalf("%q", shQuote("a'b"))
	}
	dest := filepath.Join(t.TempDir(), "bin", "plexus")
	if err := writeAppWrapper(dest, "/App/Plexus.app/Contents/MacOS/plexus", "/App/Plexus.app/Contents/Resources"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "PLEXUS_ROOT=") || !strings.Contains(string(b), "exec ") {
		t.Fatalf("%s", b)
	}
}

func TestSameFileCopyTree(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.MkdirAll(filepath.Join(src, "keep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "keep", "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(src, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "node_modules", "x"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, ".DS_Store"), []byte("m"), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "dst")
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "keep", "a.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "node_modules")); !os.IsNotExist(err) {
		t.Fatal("skipped node_modules")
	}
	same, err := sameFile(filepath.Join(src, "keep", "a.txt"), filepath.Join(src, "keep", "a.txt"))
	if err != nil || !same {
		t.Fatal(same, err)
	}
	if _, err := sameFile(filepath.Join(src, "missing"), filepath.Join(src, "keep", "a.txt")); err == nil {
		t.Fatal("missing")
	}
	if err := copyFile(filepath.Join(src, "missing"), filepath.Join(dst, "nope"), 0o644); err == nil {
		t.Fatal("copy missing")
	}
}

func TestLookCmdResolvedExeKill(t *testing.T) {
	if lookCmd("go") == "go" && lookCmd("/bin/sh") == "/bin/sh" {
		if p := lookCmd("sh"); p == "" {
			t.Fatal("look")
		}
	}
	if lookCmd("definitely-not-a-plexus-bin-xyz") == "" {
		t.Fatal("fallback")
	}
	if resolvedExe() == "" {
		t.Fatal("exe")
	}
	killPid(0)
	killPid(-1)
}

func TestPidHudQuit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if readPid("hud.pid") != 0 {
		t.Fatal("missing")
	}
	if hudRunning() {
		t.Fatal("dead")
	}
	sendHUD("toggle")
	b, err := os.ReadFile(filepath.Join(paths.PlexusDir(), "hud-cmd"))
	if err != nil || strings.TrimSpace(string(b)) != "toggle" {
		t.Fatal(string(b), err)
	}
	if err := os.WriteFile(filepath.Join(paths.PlexusDir(), "hud.pid"), []byte("999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.PlexusDir(), "backend.pid"), []byte("999999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	quitAll()
}

func TestGetJSONAndWaitHealth(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	t.Setenv("PORT", strconv.Itoa(port))
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/bad", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() { _ = srv.Close() })
	time.Sleep(20 * time.Millisecond)

	if h := getJSON("/api/health"); h["ok"] != true {
		t.Fatalf("%v", h)
	}
	if getJSON("/bad") != nil {
		t.Fatal("bad json")
	}
	if waitHealth() == nil {
		t.Fatal("health")
	}
	if config.Origin() != "http://127.0.0.1:"+strconv.Itoa(port) {
		t.Fatal(config.Origin())
	}
}

func TestGetJSONDown(t *testing.T) {
	t.Setenv("PORT", "1")
	if getJSON("/api/health") != nil {
		t.Fatal("down")
	}
}

func TestRun(t *testing.T) {
	if err := run("true"); err != nil {
		t.Fatal(err)
	}
	if err := run("false"); err == nil {
		t.Fatal("false")
	}
	detachVolume("PlexusNoSuchVolume")
}

func TestInstallSelfSameDir(t *testing.T) {
	root := t.TempDir()
	got := installSelf(root)
	if got == "" {
		t.Fatal("empty")
	}
	if _, err := os.Stat(filepath.Join(root, "bin", "plexus")); err != nil && got == filepath.Join(root, "bin", "plexus") {
		t.Fatal(err)
	}
}
