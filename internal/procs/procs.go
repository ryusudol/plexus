package procs

import (
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var agentBin = regexp.MustCompile(`^(claude|codex|codex-cli)$`)

func ListAgentPids() []int {
	cmd := exec.Command("ps", "-axo", "pid=,command=")
	done := make(chan []byte, 1)
	go func() {
		out, _ := cmd.Output()
		done <- out
	}()
	var out []byte
	select {
	case out = <-done:
	case <-time.After(400 * time.Millisecond):
		_ = cmd.Process.Kill()
		return nil
	}
	return parseAgentLines(string(out))
}

func parseAgentLines(out string) []int {
	pids := []int{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		match := regexp.MustCompile(`^(\d+)\s+(.*)$`).FindStringSubmatch(line)
		if match == nil {
			continue
		}
		pid, _ := strconv.Atoi(match[1])
		command := match[2]
		if pid == 0 || strings.Contains(command, "plexus") {
			continue
		}
		fields := strings.Fields(command)
		if len(fields) == 0 {
			continue
		}
		base := fields[0]
		if i := strings.LastIndex(base, "/"); i >= 0 {
			base = base[i+1:]
		}
		if agentBin.MatchString(base) {
			pids = append(pids, pid)
		}
	}
	return pids
}
