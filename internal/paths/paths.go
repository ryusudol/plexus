package paths

import (
	"io"
	"os"
	"path/filepath"
	"syscall"
)

func Home() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

func PlexusDir() string {
	next := filepath.Join(Home(), ".plexus")
	prev := filepath.Join(Home(), ".grok", "explore")
	if _, err := os.Stat(next); err != nil {
		if _, err := os.Stat(prev); err == nil {
			_ = copyDir(prev, next)
		}
	}
	_ = os.MkdirAll(next, 0o755)
	return next
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func PidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil
}

func ReadJSONFile(path string, dest any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return jsonUnmarshal(b, dest)
}

func WriteJSONFile(path string, v any, indent bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var b []byte
	var err error
	if indent {
		b, err = jsonMarshalIndent(v)
	} else {
		b, err = jsonMarshal(v)
	}
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func RepoRoot() string {
	if env := os.Getenv("PLEXUS_ROOT"); env != "" {
		return env
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if filepath.Base(dir) == "bin" {
			root := filepath.Dir(dir)
			if isRepo(root) {
				return root
			}
		}
		if root := walkRepo(dir); root != "" {
			return root
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		if root := walkRepo(cwd); root != "" {
			return root
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return "."
}

func isRepo(root string) bool {
	if _, err := os.Stat(filepath.Join(root, "public", "index.html")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
		return true
	}
	return false
}

func walkRepo(start string) string {
	dir := start
	for {
		if isRepo(dir) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func PeekJSONL(file string, limit int) []map[string]any {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, 16*1024)
	n, _ := f.Read(buf)
	text := string(buf[:n])
	rows := []map[string]any{}
	for _, line := range splitLines(text) {
		line = trimSpace(line)
		if line == "" {
			continue
		}
		var rec map[string]any
		if jsonUnmarshal([]byte(line), &rec) != nil {
			continue
		}
		rows = append(rows, rec)
		if len(rows) >= limit {
			break
		}
	}
	return rows
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

func splitLines(text string) []string {
	out := []string{}
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			out = append(out, text[start:i])
			start = i + 1
		}
	}
	if start < len(text) {
		out = append(out, text[start:])
	}
	return out
}
