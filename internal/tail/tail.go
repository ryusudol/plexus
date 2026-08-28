package tail

import (
	"os"
	"sync"
)

type FileTail struct {
	path   string
	onLine func(string)
	offset int64
	buf    string
	mu     sync.Mutex
}

func New(path string, onLine func(string)) *FileTail {
	return &FileTail{path: path, onLine: onLine}
}

func (t *FileTail) Replay() {
	t.mu.Lock()
	t.offset = 0
	t.buf = ""
	t.mu.Unlock()
	t.ReadNew()
}

func (t *FileTail) ReadNew() {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, err := os.Stat(t.path)
	if err != nil {
		return
	}
	size := st.Size()
	if size < t.offset {
		t.offset = 0
		t.buf = ""
	}
	if size == t.offset {
		return
	}
	length := size - t.offset
	f, err := os.Open(t.path)
	if err != nil {
		return
	}
	buf := make([]byte, length)
	_, err = f.ReadAt(buf, t.offset)
	f.Close()
	if err != nil && err.Error() != "EOF" {
		// still consume what we got
	}
	t.offset = size
	t.buf += string(buf)
	parts := splitKeepLast(t.buf)
	t.buf = parts[len(parts)-1]
	for _, line := range parts[:len(parts)-1] {
		if line != "" {
			t.mu.Unlock()
			t.onLine(line)
			t.mu.Lock()
		}
	}
}

func splitKeepLast(s string) []string {
	out := []string{}
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			out = append(out, line)
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
