package config

import (
	"os"
	"strconv"
	"time"
)

const (
	Host            = "127.0.0.1"
	DefaultPort     = 7733
	Live            = 15 * time.Minute
	Focus           = 100 * time.Millisecond
	Roster          = 750 * time.Millisecond
	RefreshDebounce = 16 * time.Millisecond
	VisitDedup      = 400 * time.Millisecond
	SSEPing         = 15 * time.Second
	TailPoll        = 40 * time.Millisecond
	HealthWait      = 100 * time.Millisecond
	HealthTries     = 40
	HUDWait         = 120 * time.Millisecond
	HUDTries        = 25
	AgentSymbolMax  = 180000
)

func Port() int {
	if raw := os.Getenv("PORT"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return n
		}
	}
	return DefaultPort
}

func Origin() string {
	return "http://" + Host + ":" + strconv.Itoa(Port())
}
