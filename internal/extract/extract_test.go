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

	titled := VisitFromAcpRecord(map[string]any{
		"update": map[string]any{
			"sessionUpdate": "tool_call",
			"toolCallId":    "c6",
			"title":         "read `/repo/web/page.tsx`",
		},
	}, SessionHint{SessionID: "s1", Cwd: "/repo"})
	if titled == nil || FolderPath(&titled.Visit) != "/repo/web" {
		t.Fatalf("title path %v", titled)
	}
}

func TestShellToolsAndSessionStart(t *testing.T) {
	for _, name := range []string{"Bash", "bash", "Shell", "shell", "exec", "local_shell", "run_terminal_command"} {
		if !IsShellTool(name) {
			t.Fatalf("%s", name)
		}
		if ExtractVisit(map[string]any{
			"toolName":  name,
			"toolInput": map[string]any{"command": "ls /repo/src"},
			"cwd":       "/repo",
		}) != nil {
			t.Fatalf("visit %s", name)
		}
	}
	start := ExtractVisit(map[string]any{
		"hookEventName": "SessionStart",
		"workspaceRoot": "/Users/me/proj",
		"sessionId":     "s1",
	})
	if start == nil || FolderPath(start) != "/Users/me/proj" {
		t.Fatalf("start %v", start)
	}
	if ExtractVisit(map[string]any{"foo": 1}) != nil {
		t.Fatal("empty")
	}
}

func TestApplyPatchAndToolArgs(t *testing.T) {
	patch := "*** Begin Patch\n*** Add File: /repo/new.ts\n@@\n+a\n*** Delete File: /repo/old.ts\n*** Move File: /repo/a.ts\n*** End Patch\n"
	into := []string{}
	CollectApplyPatchPaths(patch, &into)
	if len(into) != 3 || into[0] != "/repo/new.ts" || into[2] != "/repo/a.ts" {
		t.Fatalf("%v", into)
	}
	visit := ExtractVisit(map[string]any{
		"toolName":  "apply_patch",
		"arguments": patch,
		"cwd":       "/repo",
	})
	if visit == nil || FolderPath(visit) != "/repo" {
		t.Fatalf("%v", visit)
	}
	args := ExtractVisit(map[string]any{
		"name":     "Read",
		"toolArgs": map[string]any{"file_path": "/repo/lib/x.ts"},
		"cwd":      "/repo",
	})
	if args == nil || FilePath(args) != "/repo/lib/x.ts" {
		t.Fatalf("toolArgs %v", args)
	}
	locs := ExtractVisit(map[string]any{
		"toolName":  "read_file",
		"locations": []any{map[string]any{"path": "/repo/src/main.ts"}},
		"cwd":       "/repo",
	})
	if locs == nil || FolderPath(locs) != "/repo/src" {
		t.Fatalf("locations %v", locs)
	}
}

func TestInferProvider(t *testing.T) {
	if InferProvider(map[string]any{"provider": "codex"}) != "codex" {
		t.Fatal("field")
	}
	if InferProvider(map[string]any{"transcript_path": "/Users/me/.claude/projects/x.jsonl"}) != "claude" {
		t.Fatal("transcript")
	}
	if InferProvider(map[string]any{"source": "/Users/me/.codex/sessions/x.jsonl"}) != "codex" {
		t.Fatal("source")
	}
	if InferProvider(map[string]any{"tool_name": "apply_patch"}) != "codex" {
		t.Fatal("codex tool")
	}
	if InferProvider(map[string]any{"name": "read_file"}) != "grok" {
		t.Fatal("default")
	}
}

func TestCollectNestedPaths(t *testing.T) {
	visit := ExtractVisit(map[string]any{
		"toolName":  "read_file",
		"toolInput": `{"target_file":"/repo/nested/a.ts"}`,
		"cwd":       "/repo",
	})
	if visit == nil || FilePath(visit) != "/repo/nested/a.ts" {
		t.Fatalf("nested json %v", visit)
	}
	visit = ExtractVisit(map[string]any{
		"toolName":  "read_file",
		"toolInput": []any{map[string]any{"path": "/repo/arr/b.ts"}},
		"cwd":       "/repo",
	})
	if visit == nil || FolderPath(visit) != "/repo/arr" {
		t.Fatalf("array %v", visit)
	}
	visit = ExtractVisit(map[string]any{
		"toolName": "apply_patch",
		"toolInput": map[string]any{
			"patch": "*** Begin Patch\n*** Update File: /repo/p.ts\n*** End Patch\n",
		},
		"cwd": "/repo",
	})
	if visit == nil || FilePath(visit) != "/repo/p.ts" {
		t.Fatalf("patch %v", visit)
	}
	if ExtractVisit(nil) != nil {
		t.Fatal("nil")
	}
}

func TestParentFolderAndDropGlob(t *testing.T) {
	if ParentFolder("/repo/src/a.ts", "/") != "/repo/src" {
		t.Fatal("unix")
	}
	if ParentFolder("", "/") != "/" {
		t.Fatal("empty")
	}
	if DropGlobSegments(`C:\repo\src\**\*.ts`) != "C:/repo/src" {
		t.Fatalf("%q", DropGlobSegments(`C:\repo\src\**\*.ts`))
	}
	if DropGlobSegments("**/*.ts") != "" {
		t.Fatal("all glob")
	}
}
