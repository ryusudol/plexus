package jsonx

import (
	"encoding/json"
	"testing"
)

func TestParse(t *testing.T) {
	if Parse("") != nil || Parse("  ") != nil || Parse("{") != nil {
		t.Fatal("invalid")
	}
	m := AsMap(Parse(`{"a": 1}`))
	if m == nil || Int(m["a"]) != 1 {
		t.Fatalf("%v", m)
	}
	if Parse(" [] ") == nil {
		t.Fatal("array")
	}
}

func TestAsMapStrSliceBool(t *testing.T) {
	if AsMap("nope") != nil || AsMap(nil) != nil {
		t.Fatal("asmap")
	}
	if Str(3) != "" || Str(" x ") != " x " {
		t.Fatal("str")
	}
	if TrimStr("  hi\t") != "hi" {
		t.Fatal("trim")
	}
	if !Bool(true) || Bool(false) || Bool("true") {
		t.Fatal("bool")
	}
	if Slice("x") != nil || len(Slice([]any{1, 2})) != 2 {
		t.Fatal("slice")
	}
	m := map[string]any{"cwd": " /repo ", "path": "", "other": "no"}
	if MapStr(m, "path", "cwd") != "/repo" {
		t.Fatal("mapstr")
	}
	if MapStr(nil, "cwd") != "" {
		t.Fatal("nil map")
	}
}

func TestInt(t *testing.T) {
	if Int(3) != 3 || Int(int64(4)) != 4 || Int(5.9) != 5 {
		t.Fatal("nums")
	}
	if Int(json.Number("12")) != 12 {
		t.Fatal("json.Number")
	}
	if Int("9") != 0 || Int(nil) != 0 {
		t.Fatal("zero")
	}
}
