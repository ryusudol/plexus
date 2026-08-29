package types

import "testing"

func TestNewestByID(t *testing.T) {
	rows := []SessionRow{
		{SessionID: "a", Mtime: 1, Title: "old"},
		{SessionID: "a", Mtime: 3, Title: "new"},
		{SessionID: "b", Mtime: 2, Title: "b"},
	}
	got := NewestByID(rows)
	if len(got) != 2 {
		t.Fatalf("%v", got)
	}
	if got[0].SessionID != "a" || got[0].Title != "new" || got[1].SessionID != "b" {
		t.Fatalf("%v", got)
	}
	if len(NewestByID(nil)) != 0 {
		t.Fatal("empty")
	}
}

func TestEmptySnapshotAndStrPtr(t *testing.T) {
	s := EmptySnapshot()
	if s.Sessions == nil || s.Agents == nil || s.Visited == nil || s.Files == nil || s.Pids == nil {
		t.Fatal("nil slices")
	}
	if StrPtr("") != nil || *StrPtr("x") != "x" {
		t.Fatal("strptr")
	}
}
