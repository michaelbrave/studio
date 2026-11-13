# Shortcuts for working on Studio. Installing on a new machine is just `./install.sh`
# (or `make install`); after that, run `studio`.
.PHONY: install install-service uninstall run test typecheck check doctor update help

install:          ## Node, T3, packages and the `studio` command
	./install.sh
install-service:  ## the same, plus boot services (Linux)
	./install.sh --service
uninstall:        ## remove the `studio` command (data in ~/.config/studio stays)
	./install.sh --uninstall
run:              ## start Studio in this terminal
	bin/studio
test:             ## unit tests
	npm test
typecheck:        ## TypeScript check (Studio runs .ts directly; there's no build)
	npm run typecheck
check: test typecheck
doctor:           ## check the setup on this machine
	bin/studio doctor
update:           ## pull, reinstall packages, restart services
	bin/studio update
help:
	@grep -E '^[a-z-]+:.*##' Makefile | sed -E 's/:.*## /\t/'
