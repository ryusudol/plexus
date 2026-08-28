package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryusudol/plexus/internal/claude"
	"github.com/ryusudol/plexus/internal/codex"
	"github.com/ryusudol/plexus/internal/config"
	"github.com/ryusudol/plexus/internal/extract"
	"github.com/ryusudol/plexus/internal/fstree"
	"github.com/ryusudol/plexus/internal/hooks"
	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/paths"
	"github.com/ryusudol/plexus/internal/prefs"
	"github.com/ryusudol/plexus/internal/sessions"
	"github.com/ryusudol/plexus/internal/transpile"
	"github.com/ryusudol/plexus/internal/types"
)

type Server struct {
	root      string
	publicDir string
	libDir    string
	hub       *sessions.Hub
	workspace string
	clients   map[http.ResponseWriter]bool
	recent    map[string]time.Time
	mu        sync.Mutex
}

func New(root string) *Server {
	ws := os.Getenv("PLEXUS_ROOT")
	if ws == "" {
		ws = os.Getenv("GROK_EXPLORE_ROOT")
	}
	if ws == "" {
		ws, _ = os.Getwd()
	}
	s := &Server{
		root:      root,
		publicDir: filepath.Join(root, "public"),
		libDir:    filepath.Join(root, "lib"),
		workspace: ws,
		clients:   map[http.ResponseWriter]bool{},
		recent:    map[string]time.Time{},
	}
	s.hub = sessions.New("", func(ev any) {
		if snap, ok := ev.(types.Snapshot); ok && snap.Type == "snapshot" && snap.Root != nil {
			s.setRoot(*snap.Root, false)
		}
		s.broadcast(ev)
	})
	p := prefs.Read()
	if p.GraphFollow == "project" {
		s.hub.SetFollowMode("project")
	} else {
		s.hub.SetFollowMode("focus")
	}
	if p.SessionID != "" {
		s.hub.SelectedID = p.SessionID
	}
	return s
}

func (s *Server) broadcast(event any) {
	if m := jsonx.AsMap(event); m != nil && jsonx.Str(m["type"]) == "visit" {
		key := jsonx.Str(m["agentId"]) + "|" + jsonx.Str(m["folderPath"]) + "|" + jsonx.Str(m["toolName"])
		s.mu.Lock()
		if t, ok := s.recent[key]; ok && time.Since(t) < config.VisitDedup {
			s.mu.Unlock()
			return
		}
		s.recent[key] = time.Now()
		s.mu.Unlock()
	}
	frame, err := json.Marshal(event)
	if err != nil {
		return
	}
	payload := append(append([]byte("data: "), frame...), []byte("\n\n")...)
	s.mu.Lock()
	defer s.mu.Unlock()
	for w := range s.clients {
		if _, err := w.Write(payload); err != nil {
			delete(s.clients, w)
			continue
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

func (s *Server) safeResolve(input string) string {
	if input == "" {
		return ""
	}
	resolved, err := filepath.Abs(input)
	if err != nil {
		return ""
	}
	st, err := os.Stat(resolved)
	if err != nil {
		return ""
	}
	if !st.IsDir() {
		return filepath.Dir(resolved)
	}
	return resolved
}

func (s *Server) setRoot(next string, emit bool) string {
	resolved := s.safeResolve(next)
	if resolved == "" {
		return ""
	}
	if resolved != s.workspace {
		s.workspace = resolved
		if emit {
			s.broadcast(map[string]any{
				"type": "root", "path": s.workspace, "name": fstree.FolderName(s.workspace, s.workspace),
			})
		}
	}
	return resolved
}

func (s *Server) installHooks(bin string) {
	url := hooks.InstallGrok(s.root, bin)
	if err := claude.Install(bin, url); err != nil {
		log.Println("Could not install Claude Code hook:", err)
	}
	if err := codex.Install(bin); err != nil {
		log.Println("Could not install Codex hook:", err)
	}
}

func (s *Server) handleHook(payload string) map[string]any {
	var event any
	if payload == "" {
		event = map[string]any{}
	} else if json.Unmarshal([]byte(payload), &event) != nil {
		return map[string]any{"ok": false}
	}
	m := jsonx.AsMap(event)
	if m == nil {
		return map[string]any{"ok": false}
	}
	provider := extract.InferProvider(event)
	if provider != "grok" {
		m["provider"] = provider
	}
	s.hub.NoteHook(m)
	visit := extract.ExtractVisit(m)
	native := jsonx.MapStr(m, "session_id", "sessionId")
	if native == "" && visit != nil {
		native = visit.AgentID
	}
	agentID := native
	if provider != "grok" && native != "" {
		agentID = provider + ":" + native
	}
	if visit != nil && visit.WorkspaceRoot != nil {
		s.setRoot(*visit.WorkspaceRoot, true)
	}
	if visit != nil && visit.FolderPath != nil {
		id := agentID
		if id == "" {
			id = visit.AgentID
		}
		if s.hub.Selected() == "" || id == s.hub.Selected() {
			s.broadcast(map[string]any{
				"type": "visit", "agentId": id,
				"agentLabel": orLabel(visit.AgentLabel, provider),
				"folderPath": *visit.FolderPath, "filePath": visit.FilePath,
				"toolName": visit.ToolName, "ts": visit.Ts,
			})
		}
	}
	hookName := jsonx.MapStr(m, "hook_event_name", "hookEventName")
	if hookName == "" {
		hookName = "PreToolUse"
	}
	return map[string]any{
		"ok":       true,
		"decision": "allow",
		"hookSpecificOutput": map[string]any{
			"hookEventName":      hookName,
			"permissionDecision": "allow",
		},
	}
}

func orLabel(label, provider string) string {
	if label != "" {
		return label
	}
	if provider != "" {
		return provider
	}
	return "agent"
}

func sendJSON(w http.ResponseWriter, status int, body any) {
	b, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u := r.URL
	switch {
	case r.Method == http.MethodGet && u.Path == "/api/health":
		s.mu.Lock()
		n := len(s.clients)
		s.mu.Unlock()
		sendJSON(w, 200, map[string]any{"ok": true, "root": s.workspace, "clients": n, "hud": "macos"})
		return
	case r.Method == http.MethodGet && u.Path == "/api/state":
		snap := s.hub.Snapshot()
		root := s.workspace
		if snap.Root != nil {
			root = *snap.Root
		}
		out := eventMap(snap)
		out["root"] = root
		out["name"] = fstree.FolderName(root, root)
		out["sep"] = string(os.PathSeparator)
		sendJSON(w, 200, out)
		return
	case r.Method == http.MethodGet && u.Path == "/api/prefs":
		sendJSON(w, 200, prefs.Read())
		return
	case r.Method == http.MethodPost && u.Path == "/api/prefs":
		body, _ := io.ReadAll(r.Body)
		var raw any
		_ = json.Unmarshal(body, &raw)
		patch := prefs.Sanitize(raw)
		p := prefs.Write(patch)
		if patch.GraphFollow != "" {
			changed := s.hub.GetFollowMode() != patch.GraphFollow
			s.hub.SetFollowMode(patch.GraphFollow)
			if changed && patch.GraphFollow == "focus" {
				s.hub.Refresh(true)
			}
		}
		sendJSON(w, 200, p)
		return
	case r.Method == http.MethodPost && u.Path == "/api/attach":
		body, _ := io.ReadAll(r.Body)
		var raw struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(body, &raw)
		if raw.SessionID != "" {
			s.hub.Select(raw.SessionID)
			prefs.Write(prefs.Prefs{SessionID: raw.SessionID})
		}
		sendJSON(w, 200, s.hub.Snapshot())
		return
	case r.Method == http.MethodPost && u.Path == "/api/root":
		body, _ := io.ReadAll(r.Body)
		next := s.workspace
		var raw struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(body, &raw) == nil && raw.Path != "" {
			next = raw.Path
		} else if t := strings.TrimSpace(string(body)); t != "" {
			next = t
		}
		resolved := s.setRoot(next, true)
		if resolved == "" {
			sendJSON(w, 400, map[string]any{"error": "directory not found"})
			return
		}
		sendJSON(w, 200, map[string]any{"root": s.workspace, "name": fstree.FolderName(s.workspace, s.workspace)})
		return
	case r.Method == http.MethodGet && u.Path == "/api/children":
		dir := u.Query().Get("path")
		if dir == "" {
			dir = s.workspace
		}
		resolved := s.safeResolve(dir)
		if resolved == "" {
			sendJSON(w, 404, map[string]any{"error": "not found"})
			return
		}
		sendJSON(w, 200, map[string]any{
			"path": resolved, "name": fstree.FolderName(resolved, s.workspace),
			"children": fstree.ListFolders(resolved),
		})
		return
	case r.Method == http.MethodGet && u.Path == "/api/stream":
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(":\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		s.mu.Lock()
		s.clients[w] = true
		s.mu.Unlock()
		snap := s.hub.Snapshot()
		name := fstree.FolderName(s.workspace, s.workspace)
		if snap.Root != nil {
			name = fstree.FolderName(*snap.Root, *snap.Root)
		}
		out := eventMap(snap)
		out["type"] = "snapshot"
		out["name"] = name
		frame, _ := json.Marshal(out)
		_, _ = w.Write(append(append([]byte("data: "), frame...), []byte("\n\n")...))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		notify := r.Context().Done()
		<-notify
		s.mu.Lock()
		delete(s.clients, w)
		s.mu.Unlock()
		return
	case r.Method == http.MethodPost && (u.Path == "/hook" || u.Path == "/api/visit"):
		body, _ := io.ReadAll(r.Body)
		sendJSON(w, 200, s.handleHook(string(body)))
		return
	}
	if s.serveStatic(w, r) {
		return
	}
	sendJSON(w, 404, map[string]any{"error": "not found"})
}

func eventMap(v any) map[string]any {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

var mime = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".ts":   "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) bool {
	rel := r.URL.Path
	if rel == "/" {
		rel = "/index.html"
	}
	trimmed := strings.TrimPrefix(rel, "/")
	var filePath, allowed string
	if strings.HasPrefix(rel, "/lib/") {
		filePath = filepath.Join(s.root, trimmed)
		allowed = s.libDir
	} else {
		filePath = filepath.Join(s.publicDir, trimmed)
		allowed = s.publicDir
	}
	resolved := filepath.Clean(filePath)
	if resolved != allowed && !strings.HasPrefix(resolved, allowed+string(os.PathSeparator)) {
		sendJSON(w, 403, map[string]any{"error": "forbidden"})
		return true
	}
	resolved = transpile.ResolveBrowserScript(resolved)
	st, err := os.Stat(resolved)
	if err != nil || st.IsDir() {
		return false
	}
	ext := filepath.Ext(resolved)
	if ext == ".ts" {
		body, err := transpile.Transpile(resolved)
		if err != nil {
			return false
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(body))
		return true
	}
	ctype := mime[ext]
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, resolved)
	return true
}

func (s *Server) Listen(bin string) error {
	_ = os.MkdirAll(paths.PlexusDir(), 0o755)
	_ = os.WriteFile(filepath.Join(paths.PlexusDir(), "backend.pid"), []byte(strconv.Itoa(os.Getpid())), 0o644)
	_ = os.WriteFile(filepath.Join(paths.PlexusDir(), "backend.port"), []byte(strconv.Itoa(config.Port())), 0o644)
	s.installHooks(bin)
	s.hub.Start()
	snap := s.hub.Snapshot()
	if snap.Root != nil {
		s.workspace = *snap.Root
	}
	log.Printf("Plexus hud %s", config.Origin())
	if snap.SessionTitle != nil && *snap.SessionTitle != "" {
		log.Printf("Attached %s · %s", *snap.SessionTitle, deref(snap.Root))
	} else {
		log.Printf("Watching %s", s.workspace)
	}
	go func() {
		t := time.NewTicker(config.SSEPing)
		for range t.C {
			s.mu.Lock()
			for w := range s.clients {
				if _, err := w.Write([]byte(":\n\n")); err != nil {
					delete(s.clients, w)
					continue
				}
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
			}
			s.mu.Unlock()
		}
	}()
	addr := config.Host + ":" + strconv.Itoa(config.Port())
	return http.ListenAndServe(addr, s)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
