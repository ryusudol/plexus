package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ryusudol/plexus/internal/config"
	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/paths"
	"github.com/ryusudol/plexus/internal/server"
)

func main() {
	args := os.Args[1:]
	flags := map[string]bool{}
	cmd := "open"
	source := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--source" && i+1 < len(args) {
			source = args[i+1]
			i++
			continue
		}
		if strings.HasPrefix(a, "-") {
			flags[a] = true
			continue
		}
		if cmd == "open" {
			cmd = a
		}
	}

	if flags["--hook"] || cmd == "hook" {
		runHook(source)
		return
	}
	if flags["--server"] || cmd == "server" {
		runServer()
		return
	}
	if cmd == "package-hud" || cmd == "package" {
		if err := packageHUD(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if cmd == "package-dmg" {
		if err := packageDMG(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	if cmd == "ensure" || flags["--ensure"] {
		ensureBackend()
		ensureHUD(true, flags["--demo"])
		return
	}
	if cmd == "hide" || flags["--hide"] {
		sendHUD("toggle")
		return
	}
	if cmd == "toggle" {
		ensureBackend()
		if hudRunning() {
			sendHUD("toggle")
		} else {
			ensureHUD(false, flags["--demo"])
		}
		return
	}
	if cmd == "quit" || cmd == "stop" {
		quitAll()
		return
	}
	if cmd == "demo" {
		flags["--demo"] = true
		ensureBackend()
		ensureHUD(false, true)
		return
	}

	ensureBackend()
	ensureHUD(false, flags["--demo"])
}

func runServer() {
	root := paths.RepoRoot()
	bin := installSelf(root)
	s := server.New(root)
	if err := s.Listen(bin); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runHook(source string) {
	body, _ := io.ReadAll(os.Stdin)
	var event map[string]any
	trimmed := strings.TrimSpace(string(body))
	if trimmed != "" {
		_ = json.Unmarshal([]byte(trimmed), &event)
	}
	if event == nil {
		event = map[string]any{}
	}
	if source == "claude" || source == "codex" {
		event["provider"] = source
	}
	if jsonx.Int(event["pid"]) == 0 && os.Getppid() > 1 {
		event["pid"] = os.Getppid()
	}
	payload, _ := json.Marshal(event)
	req, err := http.NewRequest(http.MethodPost, config.Origin()+"/hook", strings.NewReader(string(payload)))
	if err == nil {
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 800 * time.Millisecond}
		res, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}
	fmt.Println(`{"ok":true,"decision":"allow"}`)
}

func resolvedExe() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved
	}
	return exe
}

func installSelf(root string) string {
	exe := resolvedExe()
	if exe == "" {
		return ""
	}
	if _, resources, ok := paths.DetectAppBundle(exe); ok {
		dest := filepath.Join(paths.PlexusDir(), "bin", "plexus")
		if err := writeAppWrapper(dest, exe, resources); err != nil {
			return exe
		}
		return dest
	}
	dest := filepath.Join(root, "bin", "plexus")
	if same, _ := sameFile(exe, dest); same {
		return dest
	}
	_ = os.MkdirAll(filepath.Dir(dest), 0o755)
	_ = os.Remove(dest)
	in, err := os.Open(exe)
	if err != nil {
		return exe
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return exe
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return exe
	}
	return dest
}

func shQuote(s string) string {
	return `'` + strings.ReplaceAll(s, `'`, `'"'"'`) + `'`
}

func writeAppWrapper(dest, helper, root string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	body := "#!/bin/sh\nexport PLEXUS_ROOT=" + shQuote(root) + "\nexec " + shQuote(helper) + " \"$@\"\n"
	return os.WriteFile(dest, []byte(body), 0o755)
}

func sameFile(a, b string) (bool, error) {
	sa, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	sb, err := os.Stat(b)
	if err != nil {
		return false, err
	}
	return os.SameFile(sa, sb), nil
}

func getJSON(pathname string) map[string]any {
	client := &http.Client{Timeout: 400 * time.Millisecond}
	res, err := client.Get(config.Origin() + pathname)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}

func waitHealth() map[string]any {
	for i := 0; i < config.HealthTries; i++ {
		h := getJSON("/api/health")
		if jsonx.Bool(h["ok"]) {
			return h
		}
		time.Sleep(config.HealthWait)
	}
	return nil
}

func ensureBackend() map[string]any {
	if h := getJSON("/api/health"); jsonx.Bool(h["ok"]) {
		return h
	}
	root := paths.RepoRoot()
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Plexus backend failed to start")
		os.Exit(1)
	}
	cmd := exec.Command(exe, "--server")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PLEXUS_ROOT="+root, "PORT="+strconv.Itoa(config.Port()))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "Plexus backend failed to start:", err)
		os.Exit(1)
	}
	_ = cmd.Process.Release()
	ready := waitHealth()
	if ready == nil {
		fmt.Fprintln(os.Stderr, "Plexus backend failed to start")
		os.Exit(1)
	}
	return ready
}

func sendHUD(command string) {
	dir := paths.PlexusDir()
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "hud-cmd"), []byte(command), 0o644)
}

func readPid(name string) int {
	b, err := os.ReadFile(filepath.Join(paths.PlexusDir(), name))
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func hudRunning() bool {
	return paths.PidAlive(readPid("hud.pid"))
}

func ensureHUD(hide, demo bool) {
	pendingPath := filepath.Join(paths.PlexusDir(), "hud-cmd")
	if b, err := os.ReadFile(pendingPath); err == nil && strings.TrimSpace(string(b)) == "quit" {
		_ = os.Remove(pendingPath)
	}
	if hudRunning() {
		if !hide {
			sendHUD("show")
		}
		return
	}
	root := paths.RepoRoot()
	hudApp := filepath.Join(root, "macos", "dist", "Plexus.app")
	if app, _, ok := paths.DetectAppBundle(resolvedExe()); ok {
		hudApp = app
	}
	hudBin := filepath.Join(root, "macos", ".build", "release", "PlexusHUD")
	appExists := false
	if _, err := os.Stat(filepath.Join(hudApp, "Contents", "MacOS", "PlexusHUD")); err == nil {
		appExists = true
	}
	if !appExists {
		if _, err := os.Stat(hudBin); err != nil {
			fmt.Fprintln(os.Stderr, "HUD missing. Build it with: go run ./cmd/plexus package-hud (after swift build)")
			fmt.Fprintf(os.Stderr, "Backend is up at %s\n", config.Origin())
			return
		}
	}
	url := config.Origin()
	if demo {
		url += "?demo=1"
	}
	launchArgs := []string{"--url", url}
	if hide {
		launchArgs = append(launchArgs, "--hide")
	}
	var cmd *exec.Cmd
	if appExists {
		args := []string{"-n", "-a", hudApp, "--args"}
		args = append(args, launchArgs...)
		cmd = exec.Command("open", args...)
	} else {
		cmd = exec.Command(hudBin, launchArgs...)
	}
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	_ = cmd.Start()
	if cmd.Process != nil {
		_ = cmd.Process.Release()
	}
	for i := 0; i < config.HUDTries; i++ {
		if hudRunning() {
			return
		}
		time.Sleep(config.HUDWait)
	}
}

func killPid(pid int) {
	if !paths.PidAlive(pid) {
		return
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
}

func quitAll() {
	sendHUD("quit")
	killPid(readPid("backend.pid"))
	killPid(readPid("hud.pid"))
	time.Sleep(300 * time.Millisecond)
	_ = os.Remove(filepath.Join(paths.PlexusDir(), "hud-cmd"))
}

func lookCmd(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/bin", "/usr/local/bin"} {
		cand := filepath.Join(dir, name)
		if _, err := os.Stat(cand); err == nil {
			return cand
		}
	}
	return name
}

func copyFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return os.Chmod(dst, mode)
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		name := info.Name()
		if name == ".DS_Store" || name == "node_modules" || name == ".git" || name == "hooks" {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		perm := info.Mode().Perm()
		if perm&0o111 != 0 {
			perm = 0o755
		} else if perm == 0 {
			perm = 0o644
		}
		return copyFile(path, target, perm)
	})
}

func packageHUD() error {
	root := paths.RepoRoot()
	app := filepath.Join(root, "macos", "dist", "Plexus.app")
	contents := filepath.Join(app, "Contents")
	macOS := filepath.Join(contents, "MacOS")
	resources := filepath.Join(contents, "Resources")
	if err := os.MkdirAll(macOS, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(resources, 0o755); err != nil {
		return err
	}

	swift := exec.Command(lookCmd("swift"), "build", "-c", "release", "--package-path", filepath.Join(root, "macos"))
	swift.Dir = root
	if out, err := swift.CombinedOutput(); err != nil {
		return fmt.Errorf("swift build: %w\n%s", err, out)
	}
	hudBin := filepath.Join(root, "macos", ".build", "release", "PlexusHUD")
	if err := copyFile(hudBin, filepath.Join(macOS, "PlexusHUD"), 0o755); err != nil {
		return err
	}

	helper := filepath.Join(macOS, "plexus")
	gobuild := exec.Command(lookCmd("go"), "build", "-o", helper, "./cmd/plexus")
	gobuild.Dir = root
	gobuild.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := gobuild.CombinedOutput(); err != nil {
		return fmt.Errorf("go build helper: %w\n%s", err, out)
	}

	if err := copyFile(filepath.Join(root, "macos", "Info.plist"), filepath.Join(contents, "Info.plist"), 0o644); err != nil {
		return err
	}
	if err := copyTree(filepath.Join(root, "macos", "Resources"), resources); err != nil {
		return err
	}
	if err := copyTree(filepath.Join(root, "public"), filepath.Join(resources, "public")); err != nil {
		return err
	}
	if err := copyTree(filepath.Join(root, "lib"), filepath.Join(resources, "lib")); err != nil {
		return err
	}
	fmt.Println(app)
	return nil
}
