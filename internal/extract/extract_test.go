package extract

import (
	"testing"

	"github.com/ryusudol/plexus/internal/under"
)

func TestExtractVisitReadFile(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"hookEventName": "pre_tool_use",
		"sessionId":     "abc",
		"toolName":      "read_file",
		"toolInput":     map[string]any{"target_file": "/Users/me/proj/src/app.ts"},
		"workspaceRoot": "/Users/me/proj",
	})
	if visit == nil {
		t.Fatal("expected visit")
	}
	if FolderPath(visit) != "/Users/me/proj/src" {
		t.Fatalf("folder %q", FolderPath(visit))
	}
	if FilePath(visit) != "/Users/me/proj/src/app.ts" {
		t.Fatalf("file %q", FilePath(visit))
	}
	if visit.AgentID != "abc" {
		t.Fatalf("agent %q", visit.AgentID)
	}
}

func TestExtractVisitListDir(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"toolName":  "list_dir",
		"toolInput": map[string]any{"target_directory": "/Users/me/proj/lib"},
	})
	if visit == nil {
		t.Fatal("expected visit")
	}
	if FolderPath(visit) != "/Users/me/proj/lib" {
		t.Fatalf("folder %q", FolderPath(visit))
	}
	if visit.FilePath != nil {
		t.Fatalf("file %v", visit.FilePath)
	}
}

func TestExtractVisitJSONArguments(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"name":      "read_file",
		"arguments": `{"target_file":"/repo/web/page.tsx"}`,
	})
	if visit == nil {
		t.Fatal("expected visit")
	}
	if FolderPath(visit) != "/repo/web" {
		t.Fatalf("folder %q", FolderPath(visit))
	}
}

func TestExtractVisitRelative(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"toolName":      "read_file",
		"toolInput":     map[string]any{"target_file": "./src/main.js"},
		"workspaceRoot": "/repo",
	})
	if visit == nil {
		t.Fatal("expected visit")
	}
	if FolderPath(visit) != "/repo/src" {
		t.Fatalf("folder %q", FolderPath(visit))
	}
	if FilePath(visit) != "/repo/src/main.js" {
		t.Fatalf("file %q", FilePath(visit))
	}
}

func TestPathUnder(t *testing.T) {
	if !under.PathUnder("/repo", "/repo") || !under.PathUnder("/repo", "/repo/src/app.ts") {
		t.Fatal("inside")
	}
	if under.PathUnder("/repo", "/other") || under.PathUnder("/repo", "/repo-extra") {
		t.Fatal("outside")
	}
	if !under.PathsOverlap("/a", "/a/b") || !under.PathsOverlap("/a/b", "/a") || under.PathsOverlap("/a", "/b") {
		t.Fatal("overlap")
	}
	list := []string{}
	under.UniquePush(&list, "/repo/a")
	under.UniquePush(&list, "/repo/a")
	under.UniquePush(&list, "/repo/b")
	if len(list) != 2 || list[0] != "/repo/a" || list[1] != "/repo/b" {
		t.Fatalf("%v", list)
	}
	got := under.UniqueUnder("/repo", []string{"/repo/src", "/tmp/x", "/repo/src", "/repo/lib"})
	if len(got) != 2 || got[0] != "/repo/src" || got[1] != "/repo/lib" {
		t.Fatalf("%v", got)
	}
}

func TestSegmentsFrom(t *testing.T) {
	segs := SegmentsFrom("/repo", "/repo/web/src/agents")
	if len(segs) != 3 || segs[0].Name != "web" || segs[2].Path != "/repo/web/src/agents" {
		t.Fatalf("%v", segs)
	}
	if len(SegmentsFrom("/repo", "/other/x")) != 0 {
		t.Fatal("outside")
	}
	glob := SegmentsFrom("/repo", "/repo/web/**/*.js")
	if len(glob) != 1 || glob[0].Name != "web" {
		t.Fatalf("%v", glob)
	}
}

func TestGlobPatterns(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"toolName":      "grep",
		"toolInput":     map[string]any{"pattern": "foo", "glob": "**/*.{js,css}"},
		"workspaceRoot": "/Users/me/proj",
	})
	if visit == nil || FolderPath(visit) != "/Users/me/proj" {
		t.Fatalf("%v", visit)
	}
	visit = ExtractVisit(map[string]any{
		"toolName":      "grep",
		"toolInput":     map[string]any{"path": "/Users/me/proj/src/**/*.ts"},
		"workspaceRoot": "/Users/me/proj",
	})
	if visit == nil || FolderPath(visit) != "/Users/me/proj/src" {
		t.Fatalf("%v", visit)
	}
	visit = ExtractVisit(map[string]any{
		"toolName":      "grep",
		"toolInput":     map[string]any{"pattern": "foo", "path": "/Users/me/proj/lib", "glob": "**/*.js"},
		"workspaceRoot": "/Users/me/proj",
	})
	if visit == nil || FolderPath(visit) != "/Users/me/proj/lib" {
		t.Fatalf("%v", visit)
	}
}

func TestClaudeAndCodexVisits(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"hook_event_name": "PreToolUse",
		"session_id":      "uuid-1",
		"tool_name":       "Read",
		"tool_input":      map[string]any{"file_path": "/repo/src/app.ts"},
		"cwd":             "/repo",
	})
	if visit == nil || FolderPath(visit) != "/repo/src" {
		t.Fatalf("%v", visit)
	}
	if InferProvider(map[string]any{"tool_name": "Read"}) != "claude" {
		t.Fatal("provider")
	}
	if ExtractVisit(map[string]any{
		"tool_name":  "Bash",
		"tool_input": map[string]any{"command": "cd /repo/src && npm test"},
		"cwd":        "/repo",
	}) != nil {
		t.Fatal("bash")
	}
	parsed := VisitFromClaudeRecord(map[string]any{
		"type":      "assistant",
		"cwd":       "/repo",
		"sessionId": "uuid-1",
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "tool_use", "id": "t1", "name": "Read", "input": map[string]any{"file_path": "/repo/lib/a.ts"}},
			},
		},
	}, SessionHint{SessionID: "uuid-1", Cwd: "/repo"})
	if len(parsed) == 0 || FolderPath(&parsed[0].Visit) != "/repo/lib" {
		t.Fatalf("%v", parsed)
	}
	codex := VisitFromCodexRecord(map[string]any{
		"type": "response_item",
		"payload": map[string]any{
			"type":      "function_call",
			"name":      "apply_patch",
			"call_id":   "c1",
			"arguments": "*** Begin Patch\n*** Update File: /repo/web/app.js\n@@\n-a\n+b\n*** End Patch\n",
		},
	}, SessionHint{SessionID: "s1", Cwd: "/repo"})
	if codex == nil || FolderPath(&codex.Visit) != "/repo/web" || FilePath(&codex.Visit) != "/repo/web/app.js" {
		t.Fatalf("%v", codex)
	}
	if VisitFromCodexRecord(map[string]any{
		"payload": map[string]any{"type": "local_shell_call", "action": map[string]any{"command": []any{"ls", "/repo"}}},
	}, SessionHint{}) != nil {
		t.Fatal("shell")
	}
}

func TestGrepHeuristic(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"toolName":  "grep",
		"toolInput": map[string]any{"path": "/repo/src", "pattern": "TODO"},
	})
	if visit == nil || FolderPath(visit) != "/repo/src" {
		t.Fatalf("%v", visit)
	}
}

func TestAcpVisits(t *testing.T) {
	parsed := VisitFromAcpRecord(map[string]any{
		"params": map[string]any{
			"update": map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "c1",
				"title":         "list_dir",
				"rawInput":      map[string]any{"target_directory": "/repo/lib"},
				"_meta":         map[string]any{"x.ai/tool": map[string]any{"name": "list_dir"}},
			},
		},
	}, SessionHint{SessionID: "s1", Cwd: "/repo"})
	if parsed == nil || FolderPath(&parsed.Visit) != "/repo/lib" || parsed.Visit.FilePath != nil {
		t.Fatalf("%v", parsed)
	}

	grep := VisitFromAcpRecord(map[string]any{
		"params": map[string]any{
			"update": map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "c2",
				"title":         "grep",
				"rawInput":      map[string]any{"pattern": "foo", "path": "/repo/web/app.js"},
				"_meta":         map[string]any{"x.ai/tool": map[string]any{"name": "grep"}},
			},
		},
	}, SessionHint{SessionID: "s1", Cwd: "/repo"})
	if grep == nil || FolderPath(&grep.Visit) != "/repo/web" || FilePath(&grep.Visit) != "/repo/web/app.js" {
		t.Fatalf("%v", grep)
	}

	loc := VisitFromAcpRecord(map[string]any{
		"params": map[string]any{
			"update": map[string]any{
				"sessionUpdate": "tool_call_update",
				"toolCallId":    "c3",
				"locations":     []any{map[string]any{"path": "/repo/src/main.ts"}},
				"_meta":         map[string]any{"x.ai/tool": map[string]any{"name": "read_file"}},
			},
		},
	}, SessionHint{})
	if loc == nil || FolderPath(&loc.Visit) != "/repo/src" {
		t.Fatalf("%v", loc)
	}

	if VisitFromAcpRecord(map[string]any{
		"params": map[string]any{
			"update": map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "c5",
				"rawInput":      map[string]any{"command": "cd /Users/me/proj && npm test"},
				"_meta":         map[string]any{"x.ai/tool": map[string]any{"name": "run_terminal_command"}},
			},
		},
	}, SessionHint{}) != nil {
		t.Fatal("shell")
	}
	if VisitFromAcpRecord(map[string]any{
		"params": map[string]any{
			"update": map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "c4",
				"rawInput":      map[string]any{"command": "ls"},
				"_meta":         map[string]any{"x.ai/tool": map[string]any{"name": "run_terminal_command"}},
			},
		},
	}, SessionHint{}) != nil {
		t.Fatal("ls")
	}
}
