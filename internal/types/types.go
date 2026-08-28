package types

import "sort"

type SessionRow struct {
	SessionID string `json:"session_id"`
	NativeID  string `json:"nativeId,omitempty"`
	PID       int    `json:"pid"`
	Cwd       string `json:"cwd"`
	OpenedAt  string `json:"opened_at,omitempty"`
	Title     string `json:"title,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Provider  string `json:"provider,omitempty"`
	Updates   string `json:"updates,omitempty"`
	Mtime     int64  `json:"mtime,omitempty"`
	Live      bool   `json:"live,omitempty"`
}

type SnapshotSession struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Cwd      string `json:"cwd"`
	Live     bool   `json:"live"`
	Provider string `json:"provider"`
	Selected bool   `json:"selected"`
}

type SnapshotAgent struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Title      string  `json:"title"`
	FolderPath string  `json:"folderPath"`
	FilePath   *string `json:"filePath"`
}

type Snapshot struct {
	Type         string            `json:"type,omitempty"`
	Sessions     []SnapshotSession `json:"sessions"`
	SessionID    *string           `json:"sessionId"`
	SessionTitle *string           `json:"sessionTitle"`
	Root         *string           `json:"root"`
	Agents       []SnapshotAgent   `json:"agents"`
	Visited      []string          `json:"visited"`
	Files        []string          `json:"files"`
	Busy         bool              `json:"busy"`
	Pids         []int             `json:"pids"`
	FollowMode   string            `json:"followMode,omitempty"`
	Name         string            `json:"name,omitempty"`
}

func EmptySnapshot() Snapshot {
	return Snapshot{
		Sessions: []SnapshotSession{},
		Agents:   []SnapshotAgent{},
		Visited:  []string{},
		Files:    []string{},
		Pids:     []int{},
	}
}

func NewestByID(rows []SessionRow) []SessionRow {
	byID := map[string]SessionRow{}
	for _, row := range rows {
		prev, ok := byID[row.SessionID]
		if !ok || row.Mtime >= prev.Mtime {
			byID[row.SessionID] = row
		}
	}
	out := make([]SessionRow, 0, len(byID))
	for _, row := range byID {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mtime > out[j].Mtime })
	return out
}

func StrPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
