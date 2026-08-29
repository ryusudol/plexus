package paths

import "testing"

func TestDetectAppBundle(t *testing.T) {
	app, res, ok := DetectAppBundle("/Applications/Plexus.app/Contents/MacOS/plexus")
	if !ok || app != "/Applications/Plexus.app" || res != "/Applications/Plexus.app/Contents/Resources" {
		t.Fatalf("app=%q res=%q ok=%v", app, res, ok)
	}
	if _, _, ok := DetectAppBundle("/Users/me/projects/plexus/bin/plexus"); ok {
		t.Fatal("repo binary is not an app bundle")
	}
	if _, _, ok := DetectAppBundle(""); ok {
		t.Fatal("empty")
	}
	if _, _, ok := DetectAppBundle("/tmp/MacOS/plexus"); ok {
		t.Fatal("no Contents")
	}
	if _, _, ok := DetectAppBundle("/tmp/Foo/Contents/MacOS/plexus"); ok {
		t.Fatal("not .app")
	}
}

func TestInsideAppBundle(t *testing.T) {
	if !InsideAppBundle("/Applications/Plexus.app/Contents/Resources") {
		t.Fatal("resources should be inside the app")
	}
	if InsideAppBundle("/Users/me/projects/plexus") {
		t.Fatal("repo root is not an app bundle")
	}
}
