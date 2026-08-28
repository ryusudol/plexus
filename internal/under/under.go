package under

import "strings"

func NormalizeSlash(value string) string {
	return strings.ReplaceAll(value, "\\", "/")
}

func PathUnder(root, value string) bool {
	if root == "" || value == "" {
		return false
	}
	r := strings.TrimRight(NormalizeSlash(root), "/")
	if r == "" {
		r = "/"
	}
	v := NormalizeSlash(value)
	return v == r || strings.HasPrefix(v, r+"/")
}

func PathsOverlap(a, b string) bool {
	return PathUnder(a, b) || PathUnder(b, a)
}

func UniquePush(list *[]string, item string) bool {
	for _, existing := range *list {
		if existing == item {
			return false
		}
	}
	*list = append(*list, item)
	return true
}

func UniqueUnder(root string, lists ...[]string) []string {
	out := make([]string, 0)
	seen := map[string]bool{}
	for _, list := range lists {
		for _, item := range list {
			if !PathUnder(root, item) || seen[item] {
				continue
			}
			seen[item] = true
			out = append(out, item)
		}
	}
	return out
}
