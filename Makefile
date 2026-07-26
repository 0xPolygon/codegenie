.PHONY: init build run install uninstall check check-workflows typecheck test clean help models-list

# Default target
help:
	@echo "codegenie development commands:"
	@echo ""
	@echo "  make init        Install dependencies (pnpm install)"
	@echo "  make build       Build the CLI to dist/cli/main.js"
	@echo "  make run         Build, then run the CLI (pass args with ARGS=, e.g. make run ARGS='--help')"
	@echo "  make install     Build, then symlink codegenie to ~/.local/bin"
	@echo "  make uninstall   Remove codegenie symlink"
	@echo "  make check       Run type checking and GitHub workflow validation"
	@echo "  make check-workflows Validate workflows with actionlint"
	@echo "  make typecheck   Run TypeScript type checking"
	@echo "  make test        Run tests"
	@echo "  make models-list Regenerate models.md from the model registry"
	@echo "  make clean       Remove dist/"
	@echo ""
	@echo "Examples:"
	@echo "  make run ARGS='--help'"
	@echo "  make run ARGS='review --help'"

ARGS ?=

init:
	pnpm install

build: clean
	pnpm run build
	@chmod +x dist/cli/main.js
	@echo ""
	@echo "Built: dist/cli/main.js"
	@echo "Run with: node dist/cli/main.js --help"

run: build
	@node dist/cli/main.js $(ARGS)

# Symlinks the built codegenie CLI into ~/.local/bin so it is on PATH.
# Works on any system where ~/.local/bin is in PATH (standard on Linux/macOS).
install: build
	@mkdir -p ~/.local/bin
	@ln -sf $(CURDIR)/dist/cli/main.js ~/.local/bin/codegenie
	@echo "Installed: ~/.local/bin/codegenie -> $(CURDIR)/dist/cli/main.js"
	@echo ""
	@echo "Make sure ~/.local/bin is in your PATH. Try: codegenie --help"

uninstall:
	@rm -f ~/.local/bin/codegenie
	@echo "Removed ~/.local/bin/codegenie"

typecheck:
	pnpm run typecheck

check-workflows:
	pnpm run check:workflows

check:
	pnpm run check

test:
	pnpm test

models-list: build
	pnpm run models-list

clean:
	rm -rf dist/ bundled-grammars/
