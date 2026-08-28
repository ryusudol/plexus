package orca

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/paths"
)

type Pane struct {
	SessionID string
	Cwd       string
	TabID     string
}

type Focus struct {
	Cwd       string
	SessionID string
}

func DataFiles() []string {
	if env := os.Getenv("ORCA_DATA_FILE"); env != "" {
		return []string{env}
	}
	root := filepath.Join(paths.Home(), "Library/Application Support/orca/profiles")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, e := range entries {
		candidate := filepath.Join(root, e.Name(), "orca-data.json")
		if _, err := os.Stat(candidate); err == nil {
			out = append(out, candidate)
		}
	}
	return out
}

func cwdFromWorktreeID(key string) string {
	idx := strings.Index(key, "::")
	if idx < 0 {
		return ""
	}
	return key[idx+2:]
}

func sessionIDFromWorkspace(ws map[string]any) string {
	worktreeID := jsonx.Str(ws["activeWorktreeId"])
	tabID := jsonx.Str(ws["activeTabId"])
	if tabID == "" && worktreeID != "" {
		if by := jsonx.AsMap(ws["activeTabIdByWorktree"]); by != nil {
			tabID = jsonx.Str(by[worktreeID])
		}
	}
	if tabID == "" {
		return ""
	}
	panes := jsonx.AsMap(ws["sleepingAgentSessionsByPaneKey"])
	layouts := jsonx.AsMap(ws["terminalLayoutsByTabId"])
	var leafID string
	if layouts != nil {
		if layout := jsonx.AsMap(layouts[tabID]); layout != nil {
			leafID = jsonx.Str(layout["activeLeafId"])
		}
	}
	if leafID != "" && panes != nil {
		if pane := jsonx.AsMap(panes[tabID+":"+leafID]); pane != nil {
			if ps := jsonx.AsMap(pane["providerSession"]); ps != nil {
				if id := jsonx.Str(ps["id"]); id != "" {
					return id
				}
			}
		}
	}
	if panes == nil {
		return ""
	}
	for _, raw := range panes {
		pane := jsonx.AsMap(raw)
		if pane == nil || jsonx.Str(pane["tabId"]) != tabID {
			continue
		}
		if ps := jsonx.AsMap(pane["providerSession"]); ps != nil {
			if id := jsonx.Str(ps["id"]); id != "" {
				return id
			}
		}
	}
	return ""
}

func ReadLivePanes(file string) (map[string]Pane, bool) {
	files := DataFiles()
	if file != "" {
		files = []string{file}
	}
	if len(files) == 0 {
		return nil, false
	}
	panes := map[string]Pane{}
	saw := false
	for _, item := range files {
		b, err := os.ReadFile(item)
		if err != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(b, &obj) != nil {
			continue
		}
		saw = true
		ws := jsonx.AsMap(obj["workspaceSession"])
		if ws == nil {
			ws = map[string]any{}
		}
		openTabs := map[string]bool{}
		if tabsBy := jsonx.AsMap(ws["tabsByWorktree"]); tabsBy != nil {
			for _, tabs := range tabsBy {
				for _, tab := range jsonx.Slice(tabs) {
					if tm := jsonx.AsMap(tab); tm != nil {
						if id := jsonx.Str(tm["id"]); id != "" {
							openTabs[id] = true
						}
					}
				}
			}
		}
		sleeping := jsonx.AsMap(ws["sleepingAgentSessionsByPaneKey"])
		if sleeping == nil {
			continue
		}
		for _, raw := range sleeping {
			pane := jsonx.AsMap(raw)
			if pane == nil {
				continue
			}
			ps := jsonx.AsMap(pane["providerSession"])
			id := jsonx.Str(ps["id"])
			if id == "" {
				continue
			}
			tabID := jsonx.Str(pane["tabId"])
			if tabID != "" && len(openTabs) > 0 && !openTabs[tabID] {
				continue
			}
			cwd := cwdFromWorktreeID(jsonx.Str(pane["worktreeId"]))
			prev, ok := panes[id]
			if !ok || (cwd != "" && prev.Cwd == "") {
				panes[id] = Pane{SessionID: id, Cwd: cwd, TabID: tabID}
			}
		}
	}
	if !saw {
		return nil, false
	}
	return panes, true
}

func ReadFocus(file string) *Focus {
	files := DataFiles()
	if file != "" {
		files = []string{file}
	}
	var best *Focus
	var bestM int64
	for _, item := range files {
		st, err := os.Stat(item)
		if err != nil {
			continue
		}
		b, err := os.ReadFile(item)
		if err != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(b, &obj) != nil {
			continue
		}
		ws := jsonx.AsMap(obj["workspaceSession"])
		if ws == nil {
			ws = map[string]any{}
		}
		worktreeID := jsonx.Str(ws["activeWorktreeId"])
		if worktreeID == "" {
			if ui := jsonx.AsMap(obj["ui"]); ui != nil {
				worktreeID = jsonx.Str(ui["lastActiveWorktreeId"])
			}
		}
		cwd := cwdFromWorktreeID(worktreeID)
		sessionID := sessionIDFromWorkspace(ws)
		m := st.ModTime().UnixMilli()
		if (cwd != "" || sessionID != "") && m >= bestM {
			best = &Focus{Cwd: cwd, SessionID: sessionID}
			bestM = m
		}
	}
	return best
}

func ReadActiveCwd(file string) string {
	if f := ReadFocus(file); f != nil {
		return f.Cwd
	}
	return ""
}
