# Convenience wrappers around the Pebble SDK toolchain.
.PHONY: build install clean test test-live release publish screenshots emu-australia emu-seattle emu-vancouver emu-uk seed-region

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

emu-australia: ## run the gabbro emulator forced to Sydney, AU (exercises BOM)
	./scripts/emulate.sh australia

emu-seattle:  ## run the gabbro emulator forced to Seattle (exercises NOAA)
	./scripts/emulate.sh seattle

emu-vancouver: ## run the gabbro emulator forced to Vancouver (exercises DFO)
	./scripts/emulate.sh vancouver

emu-uk:       ## run the gabbro emulator forced to Portsmouth, UK (exercises UKHO EasyTide)
	./scripts/emulate.sh uk

seed-region:  ## seed a pinned region into the emulator for offline testing: make seed-region PLACE="Vancouver BC" RADIUS=25 DAYS=45
	./scripts/seed-region.sh "$(PLACE)" $(RADIUS) $(DAYS)
