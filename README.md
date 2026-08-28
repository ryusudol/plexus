# Plexus

A macOS floating HUD that shows coding agents walking a project tree in real time.

It attaches to live sessions from **Grok Build**, **Claude Code**, and **OpenAI Codex**.

Grok sessions come from `~/.grok/active_sessions.json` (including CLI sessions in Terminal, iTerm, Ghostty, and similar — not only Orca) plus each session’s `updates.jsonl`. Claude Code and Codex attach through their PreToolUse hooks and recent local transcripts (`~/.claude/projects`, `~/.codex/sessions`). A session that is already mid-turn still shows up — including the folders it already touched. The window is a non-activating panel, so the agent keeps the keyboard.

The panel appears only while the related agent session is the focused Mac app (Orca / Grok Build, Claude Code, Codex, or the terminal hosting that process) — switch to Mail or Safari and it tucks away. The map is a neural arbor: no boxes, pink names on visited folders (customizable), organic branches, camera fitted to the whole trail. Click the second circle in the header to set an agent face (your character); Shift-click resets it.

## Run

```sh
cd projects/plexus
npm run build:hud
npm start
```

That starts a menu-bar extra (no Dock icon). The floating panel appears when that session is focused.

| | |
|---|---|
| Menu bar → Show Window | Open the HUD |
| Esc | Hide |
| `node bin/plexus.ts toggle` | Show / hide |
| `node bin/plexus.ts quit` | Stop HUD + backend |
| Menu bar → Walk Demo | Fake wide repo, no agent required |

`SessionStart` runs `bin/plexus.ts --ensure` so the HUD process is ready, still hidden, until that session actually starts working. Requires Node 22.6+ (type stripping).

## Notes

- macOS first. The tree still renders in a WKWebView; the product is the panel, not a browser tab.
- Shell commands with no path are ignored. Reads, lists, greps, and edits drive the mark.
