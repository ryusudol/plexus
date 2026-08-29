package tail

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadNewAndReplay(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "log.jsonl")
	var lines []string
	tt := New(file, func(line string) { lines = append(lines, line) })

	tt.ReadNew()
	if len(lines) != 0 {
		t.Fatal("missing file")
	}

	if err := os.WriteFile(file, []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt.ReadNew()
	if len(lines) != 2 || lines[0] != "one" || lines[1] != "two" {
		t.Fatalf("%v", lines)
	}

	tt.ReadNew()
	if len(lines) != 2 {
		t.Fatal("idempotent")
	}

	lines = nil
	tt.Replay()
	if len(lines) != 2 || lines[0] != "one" {
		t.Fatalf("replay %v", lines)
	}
}

func TestPartialLineCRLFTruncate(t *testing.T) {
	file := filepath.Join(t.TempDir(), "log.jsonl")
	var lines []string
	tt := New(file, func(line string) { lines = append(lines, line) })

	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("hel"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	tt.ReadNew()
	if len(lines) != 0 {
		t.Fatalf("partial %v", lines)
	}

	f, err = os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("lo\r\nnext\r\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	tt.ReadNew()
	if len(lines) != 2 || lines[0] != "hello" || lines[1] != "next" {
		t.Fatalf("%v", lines)
	}

	if err := os.WriteFile(file, []byte("reset\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines = nil
	tt.ReadNew()
	if len(lines) != 1 || lines[0] != "reset" {
		t.Fatalf("truncate %v", lines)
	}

	if err := os.WriteFile(file, []byte("a\n\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines = nil
	tt.Replay()
	if len(lines) != 2 || lines[0] != "a" || lines[1] != "b" {
		t.Fatalf("blank %v", lines)
	}
}

func TestSplitKeepLast(t *testing.T) {
	got := splitKeepLast("a\nb")
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("%v", got)
	}
	got = splitKeepLast("a\r\n")
	if len(got) != 2 || got[0] != "a" || got[1] != "" {
		t.Fatalf("%v", got)
	}
}
