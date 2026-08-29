package config

import (
	"strconv"
	"testing"
)

func TestPortAndOrigin(t *testing.T) {
	t.Setenv("PORT", "")
	if Port() != DefaultPort {
		t.Fatal("default")
	}
	t.Setenv("PORT", "abc")
	if Port() != DefaultPort {
		t.Fatal("invalid")
	}
	t.Setenv("PORT", "0")
	if Port() != DefaultPort {
		t.Fatal("zero")
	}
	t.Setenv("PORT", "8123")
	if Port() != 8123 {
		t.Fatal(Port())
	}
	if Origin() != "http://"+Host+":"+strconv.Itoa(8123) {
		t.Fatal(Origin())
	}
}
