#!/usr/bin/env bash
set -euo pipefail

if ! command -v actionlint >/dev/null 2>&1; then
  echo "actionlint is required to validate GitHub workflows: https://github.com/rhysd/actionlint" >&2
  exit 127
fi

shopt -s nullglob
workflow_files=(
  .github/workflows/*.yml
  .github/workflows/*.yaml
  examples/workflows/*.yml
  examples/workflows/*.yaml
)

if ((${#workflow_files[@]} == 0)); then
  echo "no GitHub workflow files found" >&2
  exit 1
fi

actionlint "${workflow_files[@]}"
