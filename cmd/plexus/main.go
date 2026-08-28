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
	if cmd == "package-hud" {
		if err := packageHUD(); err != nil {
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
	ensureHUD(!flags["--demo"], flags["--demo"])
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

func installSelf(root string) string {
	exe, err := os.Executable()
	if err != nil {
		return ""
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

func packageHUD() error {
	root := paths.RepoRoot()
	app := filepath.Join(root, "macos", "dist", "Plexus.app")
	contents := filepath.Join(app, "Contents")
	macOS := filepath.Join(contents, "MacOS")
	binary := filepath.Join(root, "macos", ".build", "release", "PlexusHUD")
	if _, err := os.Stat(binary); err != nil {
		return fmt.Errorf("Missing HUD binary. Run swift build first.")
	}
	if err := os.MkdirAll(macOS, 0o755); err != nil {
		return err
	}
	in, err := os.Open(binary)
	if err != nil {
		return err
	}
	defer in.Close()
	dest := filepath.Join(macOS, "PlexusHUD")
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	out.Close()
	plistSrc := filepath.Join(root, "macos", "Info.plist")
	plistDst := filepath.Join(contents, "Info.plist")
	b, err := os.ReadFile(plistSrc)
	if err != nil {
		return err
	}
	if err := os.WriteFile(plistDst, b, 0o644); err != nil {
		return err
	}
	resSrc := filepath.Join(root, "macos", "Resources")
	resDst := filepath.Join(contents, "Resources")
	_ = os.MkdirAll(resDst, 0o755)
	entries, _ := os.ReadDir(resSrc)
	for _, e := range entries {
		src := filepath.Join(resSrc, e.Name())
		dst := filepath.Join(resDst, e.Name())
		data, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		_ = os.WriteFile(dst, data, 0o644)
	}
	fmt.Println(app)
	return nil
}
