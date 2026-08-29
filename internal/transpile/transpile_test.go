package transpile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRewriteSpecifiers(t *testing.T) {
	in := `import { parentFolder } from "../lib/extract.ts";
import { pathUnder } from "../lib/under.ts";
const x = await import("./chrome.ts");
`
	got := rewriteSpecifiers(in)
	if want := `import { parentFolder } from "../lib/extract.js";
import { pathUnder } from "../lib/under.js";
const x = await import("./chrome.js");
`; got != want {
		t.Fatalf("got %q", got)
	}
}

func TestTranspile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sample.ts")
	src := `import { x } from "./dep.ts";
export { x };
export const n: number = 1;
`
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := Transpile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "./dep.js") || !strings.Contains(out, "export") {
		t.Fatalf("%s", out)
	}
	again, err := Transpile(file)
	if err != nil || again != out {
		t.Fatal("cache")
	}
	if err := os.WriteFile(file, []byte(src+"\nexport const m = 2;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := Transpile(file)
	if err != nil || changed == out || !strings.Contains(changed, "m") {
		t.Fatalf("mtime %s", changed)
	}

	bad := filepath.Join(dir, "bad.ts")
	if err := os.WriteFile(bad, []byte("const x: = 1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Transpile(bad); err == nil {
		t.Fatal("expected error")
	}
	if _, err := Transpile(filepath.Join(dir, "missing.ts")); err == nil {
		t.Fatal("missing")
	}
}

func TestResolveBrowserScript(t *testing.T) {
	dir := t.TempDir()
	tsPath := filepath.Join(dir, "app.ts")
	jsPath := filepath.Join(dir, "app.js")
	if err := os.WriteFile(tsPath, []byte("export {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ResolveBrowserScript(jsPath) != tsPath {
		t.Fatal("prefer ts when js missing")
	}
	if err := os.WriteFile(jsPath, []byte("export {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ResolveBrowserScript(jsPath) != jsPath {
		t.Fatal("keep js")
	}
	other := filepath.Join(dir, "nope.css")
	if ResolveBrowserScript(other) != other {
		t.Fatal("passthrough")
	}
}
