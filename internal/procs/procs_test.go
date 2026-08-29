package procs

import "testing"

func TestParseAgentLines(t *testing.T) {
	got := parseAgentLines("" +
		"  12 /usr/local/bin/claude --help\n" +
		"34 /opt/homebrew/bin/codex resume\n" +
		"56 /usr/bin/codex-cli\n" +
		"78 /tmp/plexus --server\n" +
		"0 claude\n" +
		"not a line\n" +
		"99 /usr/bin/zsh\n")
	if len(got) != 3 || got[0] != 12 || got[1] != 34 || got[2] != 56 {
		t.Fatalf("%v", got)
	}
	if len(parseAgentLines("")) != 0 {
		t.Fatal("empty")
	}
}

func TestListAgentPids(t *testing.T) {
	_ = ListAgentPids()
}
