.PHONY: init build run install uninstall typecheck test clean help

# Default target
help:
	@echo "codeninja development commands:"
	@echo ""
	@echo "  make init        Install dependencies (pnpm install)"
	@echo "  make build       Build the CLI to dist/cli/main.js"
	@echo "  make run         Build, then run the CLI (pass args with ARGS=, e.g. make run ARGS='--help')"
	@echo "  make install     Build, then symlink codeninja to ~/.local/bin"
	@echo "  make uninstall   Remove codeninja symlink"
	@echo "  make typecheck   Run TypeScript type checking"
	@echo "  make test        Run tests"
	@echo "  make clean       Remove dist/"
	@echo ""
	@echo "Examples:"
	@echo "  make run ARGS='--help'"
	@echo "  make run ARGS='review --help'"

ARGS ?=

init:
	pnpm install

build:
	pnpm run build
	@chmod +x dist/cli/main.js
	@echo ""
	@echo "Built: dist/cli/main.js"
	@echo "Run with: node dist/cli/main.js --help"

run: build
	@node dist/cli/main.js $(ARGS)

# Symlinks the built codeninja CLI into ~/.local/bin so it is on PATH.
# Works on any system where ~/.local/bin is in PATH (standard on Linux/macOS).
install: build
	@mkdir -p ~/.local/bin
	@ln -sf $(CURDIR)/dist/cli/main.js ~/.local/bin/codeninja
	@echo "Installed: ~/.local/bin/codeninja -> $(CURDIR)/dist/cli/main.js"
	@echo ""
	@echo "Make sure ~/.local/bin is in your PATH. Try: codeninja --help"

uninstall:
	@rm -f ~/.local/bin/codeninja
	@echo "Removed ~/.local/bin/codeninja"

typecheck:
	pnpm run typecheck

test:
	pnpm test

clean:
	rm -rf dist/
