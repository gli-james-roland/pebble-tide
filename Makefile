# Convenience wrappers around the Pebble SDK toolchain.
.PHONY: build install clean test test-live release publish screenshots

build:        ## build the .pbw for all platforms
	pebble build

install: build ## build + run on the gabbro emulator
	pebble install --emulator gabbro

test:         ## run the pkjs unit tests (live API tests skipped)
	node --test

test-live:    ## run unit tests + live NOAA API smoke tests (needs network)
	LIVE_NOAA=1 node --test

clean:
	pebble clean

release:      ## bump version (BUMP=patch|minor|major), commit to master, cut GitHub release
	./scripts/release.sh

publish:      ## build + publish to the repebble appstore (run `pebble login` first)
	./scripts/publish.sh

screenshots:  ## capture fresh store screenshots into screenshots/ (emulators)
	./scripts/screenshots.sh
