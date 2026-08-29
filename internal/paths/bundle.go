package paths

import (
	"path/filepath"
	"strings"
)

// DetectAppBundle reports the .app bundle and its Resources dir when exe
// lives at Bundle.app/Contents/MacOS/<name>.
func DetectAppBundle(exe string) (app, resources string, ok bool) {
	if exe == "" {
		return "", "", false
	}
	dir := filepath.Dir(filepath.Clean(exe))
	if filepath.Base(dir) != "MacOS" {
		return "", "", false
	}
	contents := filepath.Dir(dir)
	if filepath.Base(contents) != "Contents" {
		return "", "", false
	}
	app = filepath.Dir(contents)
	if !strings.HasSuffix(strings.ToLower(app), ".app") {
		return "", "", false
	}
	return app, filepath.Join(contents, "Resources"), true
}

// InsideAppBundle reports whether path is inside a .app wrapper.
func InsideAppBundle(path string) bool {
	p := filepath.Clean(path)
	for {
		if strings.HasSuffix(strings.ToLower(p), ".app") {
			return true
		}
		next := filepath.Dir(p)
		if next == p {
			return false
		}
		p = next
	}
}
