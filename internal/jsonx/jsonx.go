package jsonx

import (
	"encoding/json"
	"strings"
)

func Parse(text string) any {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	var v any
	if json.Unmarshal([]byte(text), &v) != nil {
		return nil
	}
	return v
}

func AsMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func Str(v any) string {
	s, _ := v.(string)
	return s
}

func TrimStr(v any) string {
	return strings.TrimSpace(Str(v))
}

func MapStr(m map[string]any, keys ...string) string {
	if m == nil {
		return ""
	}
	for _, key := range keys {
		if s := strings.TrimSpace(Str(m[key])); s != "" {
			return s
		}
	}
	return ""
}

func Int(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

func Bool(v any) bool {
	b, _ := v.(bool)
	return b
}

func Slice(v any) []any {
	s, _ := v.([]any)
	return s
}
