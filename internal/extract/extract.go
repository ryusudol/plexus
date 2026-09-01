package extract

import (
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ryusudol/plexus/internal/jsonx"
	"github.com/ryusudol/plexus/internal/under"
)

var (
	shellTools     = regexp.MustCompile(`^(run_terminal_command|Bash|bash|Shell|shell|exec|local_shell)$`)
	listLike       = regexp.MustCompile(`(?i)list_dir|ListDir|Glob`)
	fileLike       = regexp.MustCompile(`(?i)read_file|search_replace|write|Read|Edit|Write|apply_patch`)
	claudeTool     = regexp.MustCompile(`^(Read|Write|Edit|Glob|NotebookEdit|Task|WebFetch|WebSearch)$`)
	codexTool      = regexp.MustCompile(`(?i)^(apply_patch|local_shell)$`)
	applyPatchFile = regexp.MustCompile(`(?m)^\*\*\* (?:Add|Update|Delete|Move) File: (.+)$`)
	titlePath      = regexp.MustCompile("`([^`]+)`")
	globPart       = regexp.MustCompile(`[*?{\[]`)
	winDrive       = regexp.MustCompile(`^[A-Za-z]:`)
)

var fileKeys = []string{"target_file", "targetFile", "file_path", "filePath"}
var dirKeys = []string{"target_directory", "targetDirectory"}
var pathKeys = append(append([]string{}, fileKeys...), append(dirKeys, "path", "cwd")...)

type Visit struct {
	Kind          string  `json:"kind"`
	ToolName      *string `json:"toolName"`
	AgentID       string  `json:"agentId"`
	AgentLabel    string  `json:"agentLabel"`
	WorkspaceRoot *string `json:"workspaceRoot"`
	FolderPath    *string `json:"folderPath"`
	FilePath      *string `json:"filePath"`
	Ts            *string `json:"ts"`
}

type ParsedVisit struct {
	ToolCallID *string
	Kind       string
	Visit      Visit
}

type LineParse struct {
	Visits   []ParsedVisit
	Activity string // "busy", "idle", or ""
	Prompt   bool
}

type SessionHint struct {
	SessionID  string
	Cwd        string
	Label      string
	AgentLabel string
}

func ptr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func strPtr(s string) *string { return &s }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func firstString(obj any, keys []string) string {
	m := jsonx.AsMap(obj)
	if m == nil {
		return ""
	}
	return jsonx.MapStr(m, keys...)
}

func parseMaybeJSON(value any) any {
	if value == nil {
		return nil
	}
	if jsonx.AsMap(value) != nil || jsonx.Slice(value) != nil {
		return value
	}
	s, ok := value.(string)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(s)
	if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") {
		return nil
	}
	return jsonx.Parse(trimmed)
}

func isGlobbishPart(part string) bool {
	return part == "**" || globPart.MatchString(part)
}

func isGlobbish(value string) bool {
	for _, part := range strings.Split(strings.ReplaceAll(value, "\\", "/"), "/") {
		if part != "" && isGlobbishPart(part) {
			return true
		}
	}
	return false
}

func DropGlobSegments(value string) string {
	if value == "" {
		return ""
	}
	normalized := strings.TrimRight(strings.ReplaceAll(value, "\\", "/"), "/")
	if normalized == "" {
		return ""
	}
	isAbs := isAbsPath(normalized)
	parts := strings.Split(normalized, "/")
	kept := make([]string, 0, len(parts))
	for i, part := range parts {
		if part == "" && i == 0 && isAbs {
			kept = append(kept, "")
			continue
		}
		if part == "" || part == "." {
			continue
		}
		if isGlobbishPart(part) {
			break
		}
		kept = append(kept, part)
	}
	if len(kept) == 0 {
		return ""
	}
	if len(kept) == 1 && kept[0] == "" {
		return "/"
	}
	return strings.Join(kept, "/")
}

func looksLikeFile(value string) bool {
	if isGlobbish(value) {
		return false
	}
	replaced := strings.ReplaceAll(value, "\\", "/")
	base := replaced
	if idx := strings.LastIndex(replaced, "/"); idx >= 0 {
		base = replaced[idx+1:]
	}
	if base == "" || base == "." || base == ".." {
		return false
	}
	return strings.Contains(base, ".") && !strings.HasPrefix(base, ".")
}

func pushPath(into *[]string, value any) {
	s, ok := value.(string)
	if !ok {
		return
	}
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return
	}
	if stem := DropGlobSegments(trimmed); stem != "" {
		*into = append(*into, stem)
	}
}

func collectPathStrings(input any, into *[]string, depth int) {
	if depth > 4 || input == nil {
		return
	}
	if s, ok := input.(string); ok {
		if parsed := parseMaybeJSON(s); parsed != nil {
			collectPathStrings(parsed, into, depth+1)
			return
		}
		pushPath(into, s)
		return
	}
	if arr := jsonx.Slice(input); arr != nil {
		for _, item := range arr {
			collectPathStrings(item, into, depth+1)
		}
		return
	}
	m := jsonx.AsMap(input)
	if m == nil {
		return
	}
	for _, key := range pathKeys {
		pushPath(into, m[key])
	}
	pushPath(into, m["glob"])
	pushPath(into, m["glob_pattern"])
	if s, ok := m["patch"].(string); ok {
		CollectApplyPatchPaths(s, into)
	}
	if s, ok := m["command"].(string); ok {
		CollectApplyPatchPaths(s, into)
	}
}

func IsShellTool(name string) bool {
	return shellTools.MatchString(strings.TrimSpace(name))
}

func CollectApplyPatchPaths(text string, into *[]string) []string {
	if into == nil {
		into = &[]string{}
	}
	if text == "" || !strings.Contains(text, "***") {
		return *into
	}
	for _, match := range applyPatchFile.FindAllStringSubmatch(text, -1) {
		value := strings.TrimSpace(match[1])
		if value == "" {
			continue
		}
		first := strings.Fields(value)
		if len(first) > 0 {
			pushPath(into, first[0])
		}
	}
	return *into
}

func InferProvider(event any) string {
	m := jsonx.AsMap(event)
	if m == nil {
		return "grok"
	}
	if p := jsonx.Str(m["provider"]); p == "claude" || p == "codex" || p == "grok" {
		return p
	}
	src := jsonx.Str(m["transcript_path"]) + " " + jsonx.Str(m["transcriptPath"]) + " " + jsonx.Str(m["source"])
	if strings.Contains(src, ".claude") {
		return "claude"
	}
	if strings.Contains(src, ".codex") {
		return "codex"
	}
	name := jsonx.Str(m["tool_name"])
	if name == "" {
		name = jsonx.Str(m["toolName"])
	}
	if name == "" {
		name = jsonx.Str(m["name"])
	}
	if claudeTool.MatchString(name) {
		return "claude"
	}
	if codexTool.MatchString(name) {
		return "codex"
	}
	return "grok"
}

func ParentFolder(filePath, sep string) string {
	if sep == "" {
		sep = "/"
	}
	if filePath == "" {
		if sep == "\\" {
			return filePath
		}
		return "/"
	}
	normalized := strings.TrimRight(strings.ReplaceAll(filePath, "\\", "/"), "/")
	idx := strings.LastIndex(normalized, "/")
	if idx <= 0 {
		if sep == "\\" {
			return filePath
		}
		return "/"
	}
	return normalized[:idx]
}

func folderOf(pathValue string, isFile bool, sep string) string {
	if pathValue == "" {
		return ""
	}
	normalized := strings.ReplaceAll(pathValue, "\\", "/")
	if isFile {
		return ParentFolder(normalized, sep)
	}
	out := strings.TrimRight(normalized, "/")
	if out == "" {
		return "/"
	}
	return out
}

type ExtractOpts struct {
	Sep        string
	AssumeFile *bool
}

func ExtractVisit(event any, opts ...ExtractOpts) *Visit {
	if jsonx.AsMap(event) == nil && event != nil {
		// allow typed maps only
	}
	m := jsonx.AsMap(event)
	if m == nil {
		return nil
	}
	sep := "/"
	var assumeFile *bool
	if len(opts) > 0 {
		if opts[0].Sep != "" {
			sep = opts[0].Sep
		}
		assumeFile = opts[0].AssumeFile
	}

	toolName := jsonx.MapStr(m, "toolName", "tool_name", "name")
	if IsShellTool(toolName) {
		return nil
	}
	toolInput := parseMaybeJSON(m["toolInput"])
	if toolInput == nil {
		toolInput = parseMaybeJSON(m["tool_input"])
	}
	if toolInput == nil {
		toolInput = parseMaybeJSON(m["arguments"])
	}
	if toolInput == nil {
		toolInput = parseMaybeJSON(m["toolArgs"])
	}
	if toolInput == nil {
		toolInput = map[string]any{}
	}

	workspaceRoot := jsonx.MapStr(m, "workspaceRoot", "workspace_root", "cwd")

	agentID := jsonx.MapStr(m, "sessionId", "session_id", "agentId")
	if agentID == "" {
		agentID = "main"
	}

	agentLabel := jsonx.MapStr(m, "subagentType", "subagent_type")
	if agentLabel == "" && jsonx.Str(m["session_relationship"]) == "primary" {
		agentLabel = "main"
	}
	if agentLabel == "" {
		if toolName != "" {
			agentLabel = "agent"
		} else {
			agentLabel = "main"
		}
	}

	hookEvent := jsonx.MapStr(m, "hookEventName", "hook_event_name", "type")

	candidates := []string{}
	collectPathStrings(toolInput, &candidates, 0)
	pushPath(&candidates, m["path"])
	pushPath(&candidates, m["folderPath"])
	if s, ok := m["arguments"].(string); ok {
		CollectApplyPatchPaths(s, &candidates)
	}
	if locs := jsonx.Slice(m["locations"]); locs != nil {
		for _, loc := range locs {
			if lm := jsonx.AsMap(loc); lm != nil {
				pushPath(&candidates, lm["path"])
			}
		}
	}

	unique := uniqueStrings(candidates)
	toolInputRec := jsonx.AsMap(toolInput)
	globRaw := []string{}
	if toolInputRec != nil {
		for _, key := range []string{"glob", "glob_pattern"} {
			if s := jsonx.Str(toolInputRec[key]); s != "" && isGlobbish(s) {
				globRaw = append(globRaw, s)
			}
		}
	}
	for _, key := range []string{"path", "folderPath"} {
		if s := jsonx.Str(m[key]); s != "" && isGlobbish(s) {
			globRaw = append(globRaw, s)
		}
	}
	if len(unique) == 0 && hookEvent == "" && len(globRaw) == 0 {
		return nil
	}

	dirHint := DropGlobSegments(firstString(toolInput, dirKeys))
	fileHint := firstString(toolInput, fileKeys)

	var filePath string
	if fileHint != "" && !isGlobbish(fileHint) {
		filePath = fileHint
	}
	folderPath := dirHint

	if folderPath == "" && len(unique) > 0 {
		chosen := unique[0]
		treatAsFile := !listLike.MatchString(toolName) &&
			((assumeFile != nil && *assumeFile) ||
				fileLike.MatchString(toolName) ||
				fileHint != "" ||
				looksLikeFile(chosen))
		if treatAsFile {
			if filePath == "" {
				filePath = chosen
			}
			folderPath = folderOf(chosen, true, sep)
		} else {
			folderPath = folderOf(chosen, false, sep)
		}
	}

	folderPath = DropGlobSegments(folderPath)
	if filePath != "" && isGlobbish(filePath) {
		filePath = ""
	}

	if folderPath == "" && workspaceRoot != "" && (len(globRaw) > 0 || hookEvent == "session_start" || hookEvent == "SessionStart") {
		folderPath = strings.ReplaceAll(workspaceRoot, "\\", "/")
	}

	ts := jsonx.MapStr(m, "timestamp", "ts")
	toolNamePtr := (*string)(nil)
	if toolName != "" {
		toolNamePtr = &toolName
	}

	if folderPath == "" {
		return &Visit{
			Kind:          orDefault(hookEvent, "event"),
			ToolName:      toolNamePtr,
			AgentID:       agentID,
			AgentLabel:    agentLabel,
			WorkspaceRoot: ptr(workspaceRoot),
			FolderPath:    nil,
			FilePath:      ptr(filePath),
			Ts:            ptr(ts),
		}
	}

	if workspaceRoot != "" && folderPath != "" && !isAbsPath(folderPath) {
		root := strings.TrimRight(strings.ReplaceAll(workspaceRoot, "\\", "/"), "/")
		folderPath = root + "/" + strings.TrimPrefix(folderPath, "./")
		if filePath != "" && !strings.HasPrefix(filePath, "/") {
			filePath = root + "/" + strings.TrimPrefix(filePath, "./")
		}
	}

	if ts == "" {
		ts = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}

	return &Visit{
		Kind:          orDefault(hookEvent, "visit"),
		ToolName:      toolNamePtr,
		AgentID:       agentID,
		AgentLabel:    agentLabel,
		WorkspaceRoot: ptr(strings.ReplaceAll(workspaceRoot, "\\", "/")),
		FolderPath:    strPtr(strings.ReplaceAll(folderPath, "\\", "/")),
		FilePath:      ptr(strings.ReplaceAll(filePath, "\\", "/")),
		Ts:            &ts,
	}
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func uniqueStrings(items []string) []string {
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func VisitFromAcpRecord(record any, session SessionHint) *ParsedVisit {
	rec := jsonx.AsMap(record)
	params := jsonx.AsMap(rec["params"])
	var updateRaw any
	if params != nil && params["update"] != nil {
		updateRaw = params["update"]
	} else if rec != nil && rec["update"] != nil {
		updateRaw = rec["update"]
	} else {
		updateRaw = record
	}
	update := jsonx.AsMap(updateRaw)
	if update == nil {
		return nil
	}
	kind := jsonx.Str(update["sessionUpdate"])
	if kind != "tool_call" && kind != "tool_call_update" {
		return nil
	}
	meta := jsonx.AsMap(update["_meta"])
	var toolMeta map[string]any
	if meta != nil {
		toolMeta = jsonx.AsMap(meta["x.ai/tool"])
	}
	toolNameGuess := ""
	if toolMeta != nil {
		toolNameGuess = jsonx.Str(toolMeta["name"])
	}
	if toolNameGuess == "" {
		toolNameGuess = jsonx.Str(update["title"])
	}
	if IsShellTool(toolNameGuess) {
		return nil
	}

	locations := jsonx.Slice(update["locations"])
	var titleP string
	if t := jsonx.Str(update["title"]); t != "" {
		if match := titlePath.FindStringSubmatch(t); len(match) > 1 {
			titleP = match[1]
		}
	}
	var locPath string
	if len(locations) > 0 {
		if first := jsonx.AsMap(locations[0]); first != nil {
			locPath = jsonx.Str(first["path"])
		}
	}
	pathVal := locPath
	if pathVal == "" {
		pathVal = titleP
	}
	toolName := ""
	if toolMeta != nil {
		toolName = jsonx.Str(toolMeta["name"])
	}
	if toolName == "" {
		toolName = jsonx.Str(update["title"])
	}
	var toolInput any
	if update["rawInput"] != nil {
		toolInput = update["rawInput"]
	} else if toolMeta != nil {
		toolInput = toolMeta["input"]
	} else {
		toolInput = map[string]any{}
	}
	locObjs := []any{}
	for _, loc := range locations {
		if lm := jsonx.AsMap(loc); lm != nil {
			locObjs = append(locObjs, map[string]any{"path": jsonx.Str(lm["path"])})
		}
	}
	ts := ""
	if rec != nil {
		ts = jsonx.MapStr(rec, "timestamp", "ts")
	}
	label := session.Label
	if label == "" {
		label = session.AgentLabel
	}
	event := map[string]any{
		"toolName":      toolName,
		"toolInput":     toolInput,
		"sessionId":     session.SessionID,
		"workspaceRoot": session.Cwd,
		"subagentType":  label,
	}
	if pathVal != "" {
		event["path"] = pathVal
	}
	if ts != "" {
		event["timestamp"] = ts
	}
	if len(locObjs) > 0 {
		event["locations"] = locObjs
	}
	visit := ExtractVisit(event)
	if visit == nil || visit.FolderPath == nil {
		return nil
	}
	var id *string
	if s := jsonx.Str(update["toolCallId"]); s != "" {
		id = &s
	}
	return &ParsedVisit{ToolCallID: id, Kind: kind, Visit: *visit}
}

func claudeBlocks(record any) []any {
	rec := jsonx.AsMap(record)
	if rec == nil {
		return nil
	}
	message := jsonx.AsMap(rec["message"])
	var content any
	if message != nil && message["content"] != nil {
		content = message["content"]
	} else {
		content = rec["content"]
	}
	return jsonx.Slice(content)
}

func VisitFromClaudeRecord(record any, session SessionHint) []ParsedVisit {
	rec := jsonx.AsMap(record)
	if rec == nil {
		return nil
	}
	if rec["type"] != nil && jsonx.Str(rec["type"]) != "assistant" {
		return nil
	}
	out := []ParsedVisit{}
	for _, block := range claudeBlocks(record) {
		bm := jsonx.AsMap(block)
		if bm == nil || jsonx.Str(bm["type"]) != "tool_use" {
			continue
		}
		name := jsonx.Str(bm["name"])
		if IsShellTool(name) {
			continue
		}
		sid := session.SessionID
		if sid == "" {
			sid = jsonx.Str(rec["sessionId"])
		}
		cwd := session.Cwd
		if cwd == "" {
			cwd = jsonx.Str(rec["cwd"])
		}
		label := session.Label
		if label == "" {
			label = "claude"
		}
		event := map[string]any{
			"toolName":      name,
			"toolInput":     bm["input"],
			"sessionId":     sid,
			"workspaceRoot": cwd,
			"timestamp":     jsonx.Str(rec["timestamp"]),
			"subagentType":  label,
		}
		visit := ExtractVisit(event)
		if visit == nil || visit.FolderPath == nil {
			continue
		}
		var id *string
		if s := jsonx.Str(bm["id"]); s != "" {
			id = &s
		}
		out = append(out, ParsedVisit{ToolCallID: id, Kind: "tool_use", Visit: *visit})
	}
	return out
}

func stripFileURL(p string) string {
	p = strings.TrimSpace(p)
	if len(p) >= 7 && strings.EqualFold(p[:7], "file://") {
		if u, err := url.Parse(p); err == nil && strings.EqualFold(u.Scheme, "file") && u.Path != "" {
			p = u.Path
		} else {
			p = p[7:]
			p = strings.TrimPrefix(strings.TrimPrefix(p, "localhost"), "127.0.0.1")
		}
	}
	return strings.ReplaceAll(p, "\\", "/")
}

func isAbsPath(p string) bool {
	return strings.HasPrefix(p, "/") || winDrive.MatchString(p)
}

func joinUnderRoot(root, rel string) string {
	root = strings.TrimRight(stripFileURL(root), "/")
	rel = strings.TrimPrefix(strings.ReplaceAll(rel, "\\", "/"), "./")
	if rel == "" || rel == "." {
		return root
	}
	if isAbsPath(rel) {
		return rel
	}
	if root == "" {
		return rel
	}
	return root + "/" + rel
}

func isSingleSegment(p string) bool {
	p = strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/")
	return p != "" && !strings.Contains(p, "/")
}

func codexCallID(base string, index int, pathVal string) *string {
	if base == "" {
		return nil
	}
	id := base + ":" + strconv.Itoa(index) + ":" + pathVal
	return &id
}

func visitFromCodexPath(toolName, pathVal, cwd string, session SessionHint, label, ts, callID string, asFile bool) *ParsedVisit {
	cwd = stripFileURL(cwd)
	pathVal = stripFileURL(pathVal)
	if pathVal == "" {
		return nil
	}
	if !isAbsPath(pathVal) {
		if cwd == "" {
			return nil
		}
		pathVal = joinUnderRoot(cwd, pathVal)
	}
	event := map[string]any{
		"toolName":      toolName,
		"sessionId":     session.SessionID,
		"workspaceRoot": cwd,
		"timestamp":     ts,
		"subagentType":  label,
	}
	if asFile {
		event["toolInput"] = map[string]any{"file_path": pathVal, "target_file": pathVal}
	} else {
		event["toolInput"] = map[string]any{"target_directory": pathVal, "path": pathVal}
	}
	visit := ExtractVisit(event)
	if visit == nil || visit.FolderPath == nil {
		return nil
	}
	var id *string
	if callID != "" {
		id = &callID
	}
	return &ParsedVisit{ToolCallID: id, Kind: toolName, Visit: *visit}
}

func visitFromParsedCmd(cmd map[string]any, cwd string, session SessionHint, label, ts, itemID string, index int) *ParsedVisit {
	kind := jsonx.Str(cmd["type"])
	pathVal := stripFileURL(jsonx.Str(cmd["path"]))
	if pathVal == "" || pathVal == "." {
		return nil
	}
	tool := ""
	asFile := false
	switch kind {
	case "read":
		tool = "read_file"
		asFile = true
	case "list_files":
		tool = "list_dir"
		asFile = false
		if isSingleSegment(pathVal) && !isAbsPath(pathVal) {
			return nil
		}
	case "search":
		tool = "grep"
		asFile = looksLikeFile(pathVal)
		if isSingleSegment(pathVal) && !isAbsPath(pathVal) {
			return nil
		}
	default:
		return nil
	}
	callID := ""
	if id := codexCallID(itemID, index, pathVal); id != nil {
		callID = *id
	}
	return visitFromCodexPath(tool, pathVal, cwd, session, label, ts, callID, asFile)
}

func visitsFromCodexItem(item map[string]any, session SessionHint, cwd, label, ts string) []ParsedVisit {
	if item == nil {
		return nil
	}
	if itemCwd := stripFileURL(jsonx.Str(item["cwd"])); itemCwd != "" {
		cwd = itemCwd
	}
	itemID := jsonx.Str(item["id"])
	switch jsonx.Str(item["type"]) {
	case "CommandExecution":
		out := []ParsedVisit{}
		for i, raw := range jsonx.Slice(item["parsed_cmd"]) {
			cmd := jsonx.AsMap(raw)
			if cmd == nil {
				continue
			}
			if v := visitFromParsedCmd(cmd, cwd, session, label, ts, itemID, i); v != nil {
				out = append(out, *v)
			}
		}
		return out
	case "FileChange":
		changes := jsonx.AsMap(item["changes"])
		if changes == nil {
			return nil
		}
		paths := make([]string, 0, len(changes))
		for p := range changes {
			p = stripFileURL(p)
			if p != "" {
				paths = append(paths, p)
			}
		}
		sort.Strings(paths)
		out := []ParsedVisit{}
		for i, p := range paths {
			callID := ""
			if id := codexCallID(itemID, i, p); id != nil {
				callID = *id
			}
			if v := visitFromCodexPath("apply_patch", p, cwd, session, label, ts, callID, true); v != nil {
				out = append(out, *v)
			}
		}
		return out
	}
	return nil
}

func VisitFromCodexRecord(record any, session SessionHint) []ParsedVisit {
	rec := jsonx.AsMap(record)
	if rec == nil {
		return nil
	}
	payload := jsonx.AsMap(rec["payload"])
	if payload == nil {
		payload = rec
	}
	kind := jsonx.Str(payload["type"])
	if kind == "" {
		kind = jsonx.Str(rec["type"])
	}
	ts := jsonx.Str(rec["timestamp"])
	label := session.Label
	if label == "" {
		label = "codex"
	}
	if kind == "item_completed" {
		return visitsFromCodexItem(jsonx.AsMap(payload["item"]), session, stripFileURL(session.Cwd), label, ts)
	}
	if kind == "local_shell_call" {
		return nil
	}
	if kind != "function_call" && kind != "custom_tool_call" {
		return nil
	}
	name := jsonx.Str(payload["name"])
	if IsShellTool(name) {
		return nil
	}
	var toolInput any = payload["arguments"]
	if toolInput == nil {
		toolInput = payload["input"]
	}
	event := map[string]any{
		"toolName":      name,
		"toolInput":     toolInput,
		"arguments":     payload["arguments"],
		"sessionId":     session.SessionID,
		"workspaceRoot": session.Cwd,
		"timestamp":     ts,
		"subagentType":  label,
	}
	visit := ExtractVisit(event)
	if visit == nil || visit.FolderPath == nil {
		return nil
	}
	var id *string
	if s := jsonx.Str(payload["call_id"]); s != "" {
		id = &s
	} else if s := jsonx.Str(payload["id"]); s != "" {
		id = &s
	}
	return []ParsedVisit{{ToolCallID: id, Kind: kind, Visit: *visit}}
}

func SegmentsFrom(root, folderPath string) []struct{ Name, Path string } {
	if folderPath == "" {
		return nil
	}
	normRoot := strings.TrimRight(strings.ReplaceAll(orDefault(root, "/"), "\\", "/"), "/")
	if normRoot == "" {
		normRoot = "/"
	}
	normPath := strings.TrimRight(strings.ReplaceAll(folderPath, "\\", "/"), "/")
	if normPath == normRoot {
		return nil
	}
	if !under.PathUnder(normRoot, normPath) {
		return nil
	}
	rest := strings.TrimPrefix(normPath[len(normRoot):], "/")
	if rest == "" {
		return nil
	}
	out := []struct{ Name, Path string }{}
	cursor := normRoot
	for _, part := range strings.Split(rest, "/") {
		if part == "" {
			continue
		}
		if isGlobbishPart(part) {
			break
		}
		cursor = cursor + "/" + part
		out = append(out, struct{ Name, Path string }{Name: part, Path: cursor})
	}
	return out
}

func FolderPath(v *Visit) string { return deref(v.FolderPath) }
func FilePath(v *Visit) string   { return deref(v.FilePath) }
