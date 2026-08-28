package roster

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ryusudol/plexus/internal/claude"
	"github.com/ryusudol/plexus/internal/codex"
	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/orca"
	"github.com/ryusudol/plexus/internal/paths"
	"github.com/ryusudol/plexus/internal/types"
	"github.com/ryusudol/plexus/internal/under"
)

func GrokHome() string {
	if env := os.Getenv("GROK_HOME"); env != "" {
		return env
	}
	return filepath.Join(paths.Home(), ".grok")
}

func EncodeCwd(cwd string) string {
	return url.QueryEscape(cwd)
}

func SessionDir(cwd, sessionID, home string) string {
	if home == "" {
		home = GrokHome()
	}
	direct := filepath.Join(home, "sessions", EncodeCwd(cwd), sessionID)
	if _, err := os.Stat(direct); err == nil {
		return direct
	}
	root := filepath.Join(home, "sessions")
	entries, err := os.ReadDir(root)
	if err != nil {
		return direct
	}
	for _, group := range entries {
		if !group.IsDir() {
			continue
		}
		candidate := filepath.Join(root, group.Name(), sessionID)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return direct
}

func UpdatesPath(session types.SessionRow, home string) string {
	if session.Updates != "" {
		return session.Updates
	}
	if home == "" {
		home = GrokHome()
	}
	id := session.NativeID
	if id == "" {
		id = session.SessionID
	}
	return filepath.Join(SessionDir(session.Cwd, id, home), "updates.jsonl")
}

type summary struct {
	GeneratedTitle string `json:"generated_title"`
	AgentName      string `json:"agent_name"`
}

func readSummary(session types.SessionRow, home string) *summary {
	file := filepath.Join(SessionDir(session.Cwd, session.SessionID, home), "summary.json")
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var s summary
	if json.Unmarshal(b, &s) != nil {
		return nil
	}
	return &s
}

func findSessionCwd(sessionID, home string) string {
	root := filepath.Join(home, "sessions")
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, group := range entries {
		if !group.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, group.Name(), sessionID)); err != nil {
			continue
		}
		dec, err := url.QueryUnescape(group.Name())
		if err != nil {
			return group.Name()
		}
		return dec
	}
	return ""
}

func rosterEntry(row types.SessionRow, home string, live bool) types.SessionRow {
	sum := readSummary(row, home)
	updates := UpdatesPath(row, home)
	var mtime int64
	if st, err := os.Stat(updates); err == nil {
		mtime = st.ModTime().UnixMilli()
	}
	title := filepath.Base(row.Cwd)
	agent := "agent"
	if sum != nil {
		if sum.GeneratedTitle != "" {
			title = sum.GeneratedTitle
		}
		if sum.AgentName != "" {
			agent = sum.AgentName
		}
	}
	provider := row.Provider
	if provider == "" {
		provider = "grok"
	}
	return types.SessionRow{
		SessionID: row.SessionID,
		PID:       row.PID,
		Cwd:       row.Cwd,
		OpenedAt:  row.OpenedAt,
		Title:     title,
		Agent:     agent,
		Provider:  provider,
		Updates:   updates,
		Mtime:     mtime,
		Live:      live,
	}
}

func readActiveSessionRows(home string) []types.SessionRow {
	b, err := os.ReadFile(filepath.Join(home, "active_sessions.json"))
	if err != nil {
		return nil
	}
	var raw []map[string]any
	if json.Unmarshal(b, &raw) != nil {
		return nil
	}
	out := []types.SessionRow{}
	for _, rec := range raw {
		id := jsonx.Str(rec["session_id"])
		cwd := jsonx.Str(rec["cwd"])
		if id == "" || cwd == "" {
			continue
		}
		out = append(out, types.SessionRow{
			SessionID: id,
			PID:       jsonx.Int(rec["pid"]),
			Cwd:       cwd,
			OpenedAt:  jsonx.Str(rec["opened_at"]),
		})
	}
	return out
}

func ReadActiveSessions(home string, panes map[string]orca.Pane, panesSet bool) []types.SessionRow {
	if home == "" {
		home = GrokHome()
	}
	activePath := filepath.Join(home, "active_sessions.json")
	_, activeErr := os.Stat(activePath)
	hasActiveFile := activeErr == nil
	rows := readActiveSessionRows(home)

	var livePanes map[string]orca.Pane
	var hasPanes bool
	if panesSet {
		livePanes, hasPanes = panes, true
	} else if home == GrokHome() {
		livePanes, hasPanes = orca.ReadLivePanes("")
	}

	pidCount := map[int]int{}
	for _, row := range rows {
		if row.PID > 0 {
			pidCount[row.PID]++
		}
	}

	byID := map[string]types.SessionRow{}
	for _, row := range rows {
		inPane := hasPanes && livePanes != nil && paneListed(livePanes, row.SessionID)
		hostLive := paths.PidAlive(row.PID)
		if !inPane && !hostLive {
			continue
		}
		if !inPane && hostLive && pidCount[row.PID] > 1 && siblingOnPane(rows, livePanes, hasPanes, row) {
			continue
		}
		byID[row.SessionID] = rosterEntry(row, home, true)
	}

	out := []types.SessionRow{}
	seen := map[string]bool{}
	if hasPanes && livePanes != nil {
		for id, pane := range livePanes {
			if existing, ok := byID[id]; ok {
				existing.Live = true
				out = append(out, existing)
				seen[id] = true
				continue
			}
			// Grok's active_sessions.json is authoritative once it exists.
			// A leftover Orca pane after terminate must not keep the session
			// in the picker.
			if hasActiveFile {
				continue
			}
			cwd := pane.Cwd
			if cwd == "" {
				cwd = findSessionCwd(id, home)
			}
			if cwd == "" {
				continue
			}
			out = append(out, rosterEntry(types.SessionRow{
				SessionID: id, Cwd: cwd, PID: 0, Provider: "grok", Title: "", Agent: "agent", Mtime: 0, Live: true,
			}, home, true))
			seen[id] = true
		}
	}
	for _, session := range byID {
		if seen[session.SessionID] {
			continue
		}
		out = append(out, session)
		seen[session.SessionID] = true
	}
	return types.NewestByID(out)
}

func paneListed(panes map[string]orca.Pane, id string) bool {
	if panes == nil {
		return false
	}
	_, ok := panes[id]
	return ok
}

func siblingOnPane(rows []types.SessionRow, panes map[string]orca.Pane, hasPanes bool, row types.SessionRow) bool {
	if !hasPanes || panes == nil || row.PID <= 0 {
		return false
	}
	for _, other := range rows {
		if other.SessionID == row.SessionID || other.PID != row.PID {
			continue
		}
		if paneListed(panes, other.SessionID) {
			return true
		}
	}
	return false
}

func ReadAllSessions(home string) []types.SessionRow {
	if home == "" {
		home = GrokHome()
	}
	all := append([]types.SessionRow{}, ReadActiveSessions(home, nil, false)...)
	all = append(all, claude.ReadSessions("", time.Time{})...)
	all = append(all, codex.ReadSessions("", time.Time{})...)
	return types.NewestByID(all)
}

func Fingerprint(roster []types.SessionRow) string {
	parts := make([]string, 0, len(roster))
	for _, s := range roster {
		live := "0"
		if s.Live {
			live = "1"
		}
		parts = append(parts, s.SessionID+":"+strconv.Itoa(s.PID)+":"+s.Cwd+":"+s.Title+":"+live)
	}
	return strings.Join(parts, "|")
}

func PickFocusedSession(list []types.SessionRow, hint orca.Focus) *types.SessionRow {
	if len(list) == 0 {
		return nil
	}
	if hint.SessionID != "" {
		for i := range list {
			if list[i].SessionID == hint.SessionID {
				return &list[i]
			}
		}
	}
	cwd := hint.Cwd
	if cwd == "" {
		return nil
	}
	exact := []types.SessionRow{}
	nested := []types.SessionRow{}
	for _, s := range list {
		if s.Cwd == cwd {
			exact = append(exact, s)
		}
		if under.PathUnder(cwd, s.Cwd) {
			nested = append(nested, s)
		}
	}
	pool := exact
	if len(pool) == 0 {
		pool = nested
	}
	if len(pool) == 0 {
		return nil
	}
	best := pool[0]
	for _, s := range pool[1:] {
		if boolInt(s.Live) > boolInt(best.Live) || (boolInt(s.Live) == boolInt(best.Live) && s.Mtime > best.Mtime) {
			best = s
		}
	}
	return &best
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
