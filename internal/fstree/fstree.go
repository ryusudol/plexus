package fstree

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var ignore = map[string]bool{
	"node_modules": true,
	".git":         true,
	".next":        true,
	"dist":         true,
	"build":        true,
	"coverage":     true,
	"__pycache__":  true,
	".venv":        true,
	"venv":         true,
	"target":       true,
	".turbo":       true,
	".cache":       true,
	"vendor":       true,
	".pnpm-store":  true,
}

type Child struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	HasChildren bool   `json:"hasChildren"`
}

func isIgnored(name string) bool {
	if ignore[name] {
		return true
	}
	if name == ".grok" {
		return false
	}
	return strings.HasPrefix(name, ".")
}

func hasSubfolder(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if isIgnored(entry.Name()) {
			continue
		}
		return true
	}
	return false
}

func ListFolders(dir string) []Child {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []Child{}
	}
	folders := []Child{}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if isIgnored(entry.Name()) {
			continue
		}
		full := filepath.Join(dir, entry.Name())
		folders = append(folders, Child{
			Name:        entry.Name(),
			Path:        full,
			HasChildren: hasSubfolder(full),
		})
	}
	sort.Slice(folders, func(i, j int) bool { return folders[i].Name < folders[j].Name })
	return folders
}

func FolderName(dir, root string) string {
	if dir == root {
		base := filepath.Base(root)
		if base == "" {
			return root
		}
		return base
	}
	return filepath.Base(dir)
}
