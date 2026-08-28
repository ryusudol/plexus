GO ?= go
.PHONY: plexus test start quit toggle build-hud app dmg

plexus:
	$(GO) build -o bin/plexus ./cmd/plexus

test:
	$(GO) test ./...

start: plexus
	./bin/plexus

quit:
	$(GO) run ./cmd/plexus quit

toggle:
	$(GO) run ./cmd/plexus toggle

build-hud:
	swift build -c release --package-path macos
	$(GO) run ./cmd/plexus package-hud

app:
	$(GO) run ./cmd/plexus package-hud

dmg:
	$(GO) run ./cmd/plexus package-dmg
