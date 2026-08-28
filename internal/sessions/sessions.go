package sessions

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/ryusudol/plexus/internal/acp"
	"github.com/ryusudol/plexus/internal/claude"
	"github.com/ryusudol/plexus/internal/codex"
	"github.com/ryusudol/plexus/internal/config"
	"github.com/ryusudol/plexus/internal/extract"
	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/orca"
	"github.com/ryusudol/plexus/internal/procs"
	"github.com/ryusudol/plexus/internal/roster"
	"github.com/ryusudol/plexus/internal/tail"
	"github.com/ryusudol/plexus/internal/types"
	"github.com/ryusudol/plexus/internal/under"
)

var promptHook = regexp.MustCompile(`(?i)UserPromptSubmit|user_prompt_submit|user_message`)
var preToolHook = regexp.MustCompile(`(?i)PreToolUse|pre_tool_use|tool_call`)
var stopHook = regexp.MustCompile(`(?i)^(Stop|StopFailure|stop)`)

type Hub struct {
	mu            sync.Mutex
	Home          string
	Emit          func(any)
	SelectedID    string
	FollowMode    string
	LastFocusedID string
	Roster        []types.SessionRow
	tails         map[string]*tail.FileTail
	seen          map[string]map[string]bool
	visits        map[string][]string
	files         map[string][]string
	lastFolder    map[string]string
	lastFile      map[string]string
	busy          map[string]bool
	hooked        map[string]types.SessionRow
	knownIDs      map[string]bool
	selectedCwd   string
	fingerprint   string
	focusKey      string
	stop          chan struct{}
	refreshDelay  *time.Timer
}

func New(home string, emit func(any)) *Hub {
	if home == "" {
		home = roster.GrokHome()
	}
	if emit == nil {
		emit = func(any) {}
	}
	return &Hub{
		Home:       home,
		Emit:       emit,
		FollowMode: "focus",
		tails:      map[string]*tail.FileTail{},
		seen:       map[string]map[string]bool{},
		visits:     map[string][]string{},
		files:      map[string][]string{},
		lastFolder: map[string]string{},
		lastFile:   map[string]string{},
		busy:       map[string]bool{},
		hooked:     map[string]types.SessionRow{},
		knownIDs:   map[string]bool{},
		stop:       make(chan struct{}),
	}
}

func (h *Hub) Snapshot() types.Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.snapshotLocked()
}

func (h *Hub) snapshotLocked() types.Snapshot {
	h.scanRosterLocked()
	if len(h.Roster) == 0 {
		return types.EmptySnapshot()
	}
	h.ensureSelectedLocked()
	var selected types.SessionRow
	for _, s := range h.Roster {
		if s.SessionID == h.SelectedID {
			selected = s
			break
		}
	}
	if selected.SessionID == "" && h.SelectedID != "" {
		selected = types.SessionRow{
			SessionID: h.SelectedID,
			Cwd:       h.selectedCwd,
			Title:     h.SelectedID,
			Provider:  "grok",
			Live:      false,
		}
	}
	if selected.SessionID == "" {
		selected = h.Roster[0]
		h.SelectedID = selected.SessionID
	}
	if selected.Cwd != "" {
		h.selectedCwd = selected.Cwd
	}
	visited := under.UniqueUnder(selected.Cwd, h.visits[selected.SessionID])
	files := under.UniqueUnder(selected.Cwd, h.files[selected.SessionID])
	last := h.lastFolder[selected.SessionID]
	lastFile := h.lastFile[selected.SessionID]
	folderPath := selected.Cwd
	if last != "" && under.PathUnder(selected.Cwd, last) {
		folderPath = last
	}
	var filePath *string
	if lastFile != "" && under.PathUnder(selected.Cwd, lastFile) {
		filePath = &lastFile
	}
	sessions := make([]types.SnapshotSession, 0, len(h.Roster))
	pids := []int{}
	seenPid := map[int]bool{}
	for _, s := range h.Roster {
		provider := s.Provider
		if provider == "" {
			provider = "grok"
		}
		sessions = append(sessions, types.SnapshotSession{
			ID: s.SessionID, Title: s.Title, Cwd: s.Cwd, Live: s.Live, Provider: provider,
			Selected: s.SessionID == selected.SessionID,
		})
		if s.PID != 0 && !seenPid[s.PID] {
			seenPid[s.PID] = true
			pids = append(pids, s.PID)
		}
	}
	for _, pid := range procs.ListAgentPids() {
		if !seenPid[pid] {
			seenPid[pid] = true
			pids = append(pids, pid)
		}
	}
	label := selected.Agent
	if label == "grok-build-plan" {
		label = "plan"
	}
	if label == "" {
		label = "agent"
	}
	follow := h.FollowMode
	if follow != "project" {
		follow = "focus"
	}
	return types.Snapshot{
		Sessions:     sessions,
		SessionID:    types.StrPtr(selected.SessionID),
		SessionTitle: types.StrPtr(selected.Title),
		Root:         types.StrPtr(selected.Cwd),
		Agents: []types.SnapshotAgent{{
			ID: selected.SessionID, Label: label, Title: selected.Title,
			FolderPath: folderPath, FilePath: filePath,
		}},
		Visited:    visited,
		Files:      files,
		Busy:       h.busy[selected.SessionID],
		Pids:       pids,
		FollowMode: follow,
	}
}

func (h *Hub) Selected() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.SelectedID
}

func (h *Hub) SetFollowMode(mode string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if mode == "project" {
		h.FollowMode = "project"
	} else {
		h.FollowMode = "focus"
	}
}

func (h *Hub) GetFollowMode() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.FollowMode == "project" {
		return "project"
	}
	return "focus"
}

func (h *Hub) ensureSelectedLocked() {
	if len(h.Roster) == 0 {
		return
	}
	if h.SelectedID == "" {
		h.SelectedID = h.Roster[0].SessionID
		h.selectedCwd = h.Roster[0].Cwd
		return
	}
	for _, s := range h.Roster {
		if s.SessionID == h.SelectedID {
			h.selectedCwd = s.Cwd
			return
		}
	}
	if h.FollowMode == "project" {
		return
	}
	h.SelectedID = h.Roster[0].SessionID
	h.selectedCwd = h.Roster[0].Cwd
}

func (h *Hub) Select(sessionID string) {
	h.mu.Lock()
	h.SelectedID = sessionID
	for _, s := range h.Roster {
		if s.SessionID == sessionID && s.Cwd != "" {
			h.selectedCwd = s.Cwd
			break
		}
	}
	h.syncTailsLocked()
	snap := h.snapshotLocked()
	h.mu.Unlock()
	h.emitSnapshot(snap)
	h.EmitActivity()
}

func (h *Hub) sessionStillLiveLocked() bool {
	if h.SelectedID == "" {
		return false
	}
	for _, s := range h.Roster {
		if s.SessionID == h.SelectedID {
			return true
		}
	}
	return false
}

func (h *Hub) NoteHook(event any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	provider := extract.InferProvider(event)
	m := jsonx.AsMap(event)
	native := jsonx.MapStr(m, "session_id", "sessionId")
	if native == "" {
		return
	}
	id := native
	if provider != "grok" {
		id = provider + ":" + native
	}
	cwd := jsonx.MapStr(m, "cwd", "workspace_root", "workspaceRoot")
	updates := jsonx.MapStr(m, "transcript_path", "transcriptPath")
	prev := h.hooked[id]
	if cwd != "" {
		pid := jsonx.Int(m["pid"])
		if pid == 0 {
			pid = prev.PID
		}
		title := prev.Title
		if title == "" {
			title = filepath.Base(cwd)
		}
		agent := prev.Agent
		if provider == "grok" {
			if agent == "" {
				agent = "agent"
			}
		} else {
			agent = provider
		}
		if updates == "" {
			updates = prev.Updates
		}
		h.hooked[id] = types.SessionRow{
			SessionID: id, NativeID: native, PID: pid, Cwd: cwd, Title: title,
			Agent: agent, Provider: provider, Updates: updates, Mtime: time.Now().UnixMilli(), Live: true,
		}
	}
	hook := jsonx.MapStr(m, "hook_event_name", "hookEventName", "type")
	if promptHook.MatchString(hook) {
		h.busy[id] = true
		row, ok := h.hooked[id]
		if !ok {
			for _, s := range h.Roster {
				if s.SessionID == id {
					row = s
					ok = true
					break
				}
			}
		}
		if ok {
			h.followPromptLocked(row.SessionID)
		}
	} else if preToolHook.MatchString(hook) {
		h.busy[id] = true
	} else if stopHook.MatchString(hook) {
		h.busy[id] = false
	}
}

func (h *Hub) FollowPrompt(sessionID string) bool {
	h.mu.Lock()
	changed := h.followPromptLocked(sessionID)
	var snap types.Snapshot
	if changed {
		snap = h.snapshotLocked()
	}
	h.mu.Unlock()
	if changed {
		h.emitSnapshot(snap)
		h.EmitActivity()
	}
	return changed
}

func (h *Hub) followPromptLocked(sessionID string) bool {
	if h.FollowMode == "project" || sessionID == "" || sessionID == h.SelectedID {
		return false
	}
	h.SelectedID = sessionID
	return true
}

func (h *Hub) Start() {
	h.Refresh(true)
	go h.loop()
}

func (h *Hub) loop() {
	focus := time.NewTicker(config.Focus)
	rosterTick := time.NewTicker(config.Roster)
	tailTick := time.NewTicker(config.TailPoll)
	defer focus.Stop()
	defer rosterTick.Stop()
	defer tailTick.Stop()
	for {
		select {
		case <-h.stop:
			return
		case <-focus.C:
			h.PollFocus()
		case <-rosterTick.C:
			h.Refresh(false)
		case <-tailTick.C:
			h.mu.Lock()
			tails := make([]*tail.FileTail, 0, len(h.tails))
			for _, t := range h.tails {
				tails = append(tails, t)
			}
			h.mu.Unlock()
			for _, t := range tails {
				t.ReadNew()
			}
		}
	}
}

func (h *Hub) Stop() {
	h.mu.Lock()
	select {
	case <-h.stop:
	default:
		close(h.stop)
	}
	if h.refreshDelay != nil {
		h.refreshDelay.Stop()
	}
	h.tails = map[string]*tail.FileTail{}
	h.mu.Unlock()
}

func (h *Hub) ScanRoster() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.scanRosterLocked()
}

func (h *Hub) scanRosterLocked() {
	listed := roster.ReadAllSessions(h.Home)
	byID := map[string]types.SessionRow{}
	for _, row := range listed {
		byID[row.SessionID] = row
	}
	now := time.Now().UnixMilli()
	for id, row := range h.hooked {
		if now-row.Mtime > config.Live.Milliseconds() {
			delete(h.hooked, id)
			continue
		}
		if existing, ok := byID[id]; ok {
			existing.Live = true
			if row.PID != 0 {
				existing.PID = row.PID
			}
			if row.Updates != "" {
				existing.Updates = row.Updates
			}
			byID[id] = existing
			continue
		}
		if row.Provider == "" || row.Provider == "grok" {
			delete(h.hooked, id)
			continue
		}
		byID[id] = row
	}
	h.Roster = types.NewestByID(values(byID))
}

func values(m map[string]types.SessionRow) []types.SessionRow {
	out := make([]types.SessionRow, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

func (h *Hub) FollowFocus(hint orca.Focus) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.followFocusLocked(hint)
}

func (h *Hub) followFocusLocked(hint orca.Focus) bool {
	if h.FollowMode == "project" {
		return false
	}
	if hint.Cwd == "" && hint.SessionID == "" {
		if f := orca.ReadFocus(""); f != nil {
			hint = *f
		}
	}
	focused := roster.PickFocusedSession(h.Roster, hint)
	var focusedID string
	if focused != nil {
		focusedID = focused.SessionID
	}
	if !h.sessionStillLiveLocked() {
		if focusedID == "" {
			return false
		}
		h.SelectedID = focusedID
		h.LastFocusedID = focusedID
		return true
	}
	if focusedID == "" {
		return false
	}
	if focusedID == h.LastFocusedID {
		return false
	}
	h.LastFocusedID = focusedID
	if focusedID == h.SelectedID {
		return false
	}
	h.SelectedID = focusedID
	return true
}

func (h *Hub) PollFocus() bool {
	h.mu.Lock()
	if h.FollowMode == "project" {
		h.mu.Unlock()
		return false
	}
	hint := orca.ReadFocus("")
	if hint == nil {
		hint = &orca.Focus{}
	}
	key := hint.SessionID + "|" + hint.Cwd
	if key == h.focusKey {
		h.mu.Unlock()
		return false
	}
	if hint.SessionID != "" {
		found := false
		for _, s := range h.Roster {
			if s.SessionID == hint.SessionID {
				found = true
				break
			}
		}
		if !found {
			h.scanRosterLocked()
		}
	}
	h.focusKey = key
	if !h.followFocusLocked(*hint) {
		h.mu.Unlock()
		return false
	}
	h.syncTailsLocked()
	snap := h.snapshotLocked()
	h.mu.Unlock()
	h.emitSnapshot(snap)
	h.EmitActivity()
	return true
}

func (h *Hub) followNewSessionLocked() bool {
	live := map[string]bool{}
	for _, s := range h.Roster {
		live[s.SessionID] = true
	}
	added := []types.SessionRow{}
	if len(h.knownIDs) > 0 {
		for _, s := range h.Roster {
			if !h.knownIDs[s.SessionID] {
				added = append(added, s)
			}
		}
	}
	h.knownIDs = live
	if h.FollowMode == "project" || len(added) == 0 {
		return false
	}
	newest := added[0]
	if newest.SessionID == h.SelectedID {
		return false
	}
	h.SelectedID = newest.SessionID
	return true
}

func (h *Hub) Refresh(force bool) {
	h.mu.Lock()
	h.scanRosterLocked()
	fp := roster.Fingerprint(h.Roster)
	rosterChanged := fp != h.fingerprint
	h.fingerprint = fp
	focusedChanged := h.followFocusLocked(orca.Focus{})
	spawned := h.followNewSessionLocked()
	h.syncTailsLocked()
	var snap types.Snapshot
	emit := force || rosterChanged || focusedChanged || spawned
	if emit {
		snap = h.snapshotLocked()
	}
	h.mu.Unlock()
	if emit {
		h.emitSnapshot(snap)
		h.EmitActivity()
	}
}

func (h *Hub) SyncTails() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.syncTailsLocked()
}

func (h *Hub) syncTailsLocked() {
	liveIDs := map[string]bool{}
	for _, s := range h.Roster {
		liveIDs[s.SessionID] = true
	}
	for id := range h.tails {
		if !liveIDs[id] {
			delete(h.tails, id)
			h.Emit(map[string]any{"type": "agent", "agentId": id, "status": "stop"})
			delete(h.busy, id)
		}
	}
	for i := range h.Roster {
		session := h.Roster[i]
		if _, ok := h.tails[session.SessionID]; ok {
			continue
		}
		file := roster.UpdatesPath(session, h.Home)
		if _, err := os.Stat(file); err != nil {
			continue
		}
		seen := map[string]bool{}
		h.seen[session.SessionID] = seen
		h.visits[session.SessionID] = []string{}
		h.files[session.SessionID] = []string{}
		live := false
		sess := session
		t := tail.New(file, func(line string) {
			if live {
				h.onLine(sess, line, seen, true)
			} else {
				h.onLineLocked(sess, line, seen, false)
			}
		})
		t.Replay()
		live = true
		h.tails[session.SessionID] = t
		h.Emit(map[string]any{
			"type": "agent", "agentId": session.SessionID, "agentLabel": orAgent(session.Agent),
			"cwd": session.Cwd, "status": "start",
		})
	}
}

func orAgent(s string) string {
	if s == "" {
		return "agent"
	}
	return s
}

func (h *Hub) EmitActivity() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.emitActivityLocked()
}

func (h *Hub) emitActivityLocked() {
	var selected *types.SessionRow
	for i := range h.Roster {
		if h.Roster[i].SessionID == h.SelectedID {
			selected = &h.Roster[i]
			break
		}
	}
	if selected == nil && len(h.Roster) > 0 {
		selected = &h.Roster[0]
	}
	if selected == nil {
		h.Emit(map[string]any{"type": "activity", "active": false, "sessionId": nil})
		return
	}
	h.Emit(map[string]any{
		"type": "activity", "active": h.busy[selected.SessionID],
		"sessionId": selected.SessionID, "cwd": selected.Cwd,
	})
}

func (h *Hub) interpretLine(session types.SessionRow, line string) extract.LineParse {
	hint := extract.SessionHint{SessionID: session.SessionID, Cwd: session.Cwd, Label: session.Agent}
	if session.Provider == "claude" {
		return claude.ParseLine(line, hint)
	}
	if session.Provider == "codex" {
		return codex.ParseLine(line, hint)
	}
	activity := acp.ParseSessionEvent(line)
	prompt := acp.IsUserPromptEvent(line)
	parsed := acp.ParseLine(line, hint)
	visits := []extract.ParsedVisit{}
	if parsed != nil {
		visits = []extract.ParsedVisit{*parsed}
	}
	return extract.LineParse{Visits: visits, Activity: activity, Prompt: prompt}
}

func (h *Hub) onLine(session types.SessionRow, line string, seen map[string]bool, live bool) {
	h.mu.Lock()
	h.onLineLocked(session, line, seen, live)
	h.mu.Unlock()
}

func (h *Hub) onLineLocked(session types.SessionRow, line string, seen map[string]bool, live bool) {
	parsed := h.interpretLine(session, line)
	emitActivity := false
	var followSnap *types.Snapshot
	if parsed.Activity != "" {
		h.busy[session.SessionID] = parsed.Activity == "busy"
		if live {
			emitActivity = true
		}
	}
	if live && parsed.Prompt && h.followPromptLocked(session.SessionID) {
		snap := h.snapshotLocked()
		followSnap = &snap
	}
	pending := []any{}
	for _, item := range parsed.Visits {
		if item.ToolCallID != nil && seen[*item.ToolCallID] {
			continue
		}
		if item.ToolCallID != nil {
			seen[*item.ToolCallID] = true
		}
		folder := extract.FolderPath(&item.Visit)
		if folder == "" {
			continue
		}
		list := h.visits[session.SessionID]
		under.UniquePush(&list, folder)
		h.visits[session.SessionID] = list
		h.lastFolder[session.SessionID] = folder
		file := extract.FilePath(&item.Visit)
		if file != "" {
			fileList := h.files[session.SessionID]
			under.UniquePush(&fileList, file)
			h.files[session.SessionID] = fileList
			h.lastFile[session.SessionID] = file
		} else {
			delete(h.lastFile, session.SessionID)
		}
		if !live || h.SelectedID != session.SessionID {
			continue
		}
		pending = append(pending, map[string]any{
			"type": "visit", "agentId": session.SessionID,
			"agentLabel": orAgent(session.Agent),
			"folderPath": folder, "filePath": item.Visit.FilePath,
			"toolName": item.Visit.ToolName, "cwd": session.Cwd, "ts": item.Visit.Ts,
		})
	}
	if followSnap != nil {
		h.emitSnapshot(*followSnap)
	}
	if emitActivity {
		h.emitActivityLocked()
	}
	for _, ev := range pending {
		h.Emit(ev)
	}
}

func (h *Hub) emitSnapshot(snap types.Snapshot) {
	snap.Type = "snapshot"
	h.Emit(snap)
}

func Replay(session types.SessionRow, home string) []extract.Visit {
	file := roster.UpdatesPath(session, home)
	seen := map[string]bool{}
	visits := []extract.Visit{}
	b, err := os.ReadFile(file)
	if err != nil {
		return visits
	}
	hint := extract.SessionHint{SessionID: session.SessionID, Cwd: session.Cwd}
	for _, line := range splitNonEmpty(string(b)) {
		var list []extract.ParsedVisit
		if session.Provider == "claude" {
			list = claude.ParseLine(line, hint).Visits
		} else if session.Provider == "codex" {
			list = codex.ParseLine(line, hint).Visits
		} else {
			if p := acp.ParseLine(line, hint); p != nil {
				list = []extract.ParsedVisit{*p}
			}
		}
		for _, parsed := range list {
			if parsed.ToolCallID != nil && seen[*parsed.ToolCallID] {
				continue
			}
			if parsed.ToolCallID != nil {
				seen[*parsed.ToolCallID] = true
			}
			visits = append(visits, parsed.Visit)
		}
	}
	return visits
}

func splitNonEmpty(text string) []string {
	out := []string{}
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			line := text[start:i]
			if line != "" {
				out = append(out, line)
			}
			start = i + 1
		}
	}
	if start < len(text) && text[start:] != "" {
		out = append(out, text[start:])
	}
	return out
}
