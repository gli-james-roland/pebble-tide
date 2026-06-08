# Convenience wrappers around the Pebble SDK toolchain.
.PHONY: build install clean test release publish

build:        ## build the .pbw for all platforms
	pebble build

install: build ## build + run on the gabbro emulator
	pebble install --emulator gabbro

test:         ## run the pkjs unit tests
	node --test

clean:
	pebble clean

VERSION := $(shell python3 -c "import json;print(json.load(open('package.json'))['version'])")

release: build ## cut a GitHub release with the .pbw (tag vX.Y.Z from package.json)
	gh release create v$(VERSION) build/*.pbw --title "Pebble Tides $(VERSION)" --generate-notes

publish:      ## build + publish to the repebble appstore (run `pebble login` first)
	./scripts/publish.sh
