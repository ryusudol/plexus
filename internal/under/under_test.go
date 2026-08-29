package under

import "testing"

func TestPathUnder(t *testing.T) {
	if !PathUnder("/repo", "/repo") || !PathUnder("/repo", "/repo/src/app.ts") {
		t.Fatal("inside")
	}
	if PathUnder("/repo", "/other") || PathUnder("/repo", "/repo-extra") || PathUnder("/repo", "/repo2") {
		t.Fatal("prefix")
	}
	if PathUnder("", "/repo") || PathUnder("/repo", "") {
		t.Fatal("empty")
	}
	if !PathUnder(`\repo`, `\repo\src`) {
		t.Fatal("slash")
	}
	if PathUnder("/", "") {
		t.Fatal("root empty")
	}
}

func TestPathsOverlap(t *testing.T) {
	if !PathsOverlap("/a", "/a/b") || !PathsOverlap("/a/b", "/a") || PathsOverlap("/a", "/b") {
		t.Fatal("overlap")
	}
}

func TestUniquePushUnder(t *testing.T) {
	list := []string{}
	if !UniquePush(&list, "/repo/a") || UniquePush(&list, "/repo/a") {
		t.Fatal("push")
	}
	UniquePush(&list, "/repo/b")
	if len(list) != 2 {
		t.Fatalf("%v", list)
	}
	got := UniqueUnder("/repo", []string{"/repo/src", "/tmp/x", "/repo/src"}, []string{"/repo/lib"})
	if len(got) != 2 || got[0] != "/repo/src" || got[1] != "/repo/lib" {
		t.Fatalf("%v", got)
	}
	if len(UniqueUnder("/repo")) != 0 {
		t.Fatal("empty")
	}
}

func TestNormalizeSlash(t *testing.T) {
	if NormalizeSlash(`C:\a\b`) != "C:/a/b" {
		t.Fatal("norm")
	}
}
