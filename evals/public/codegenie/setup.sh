#!/usr/bin/env bash
# Materialize every codegenie public eval case as a detached, depth-2 checkout of
# its pinned head (base = head^) under ~/.cache/codegenie/public-evals/codegenie/<case>.
# The oracle (oracle.md) and later fix commits stay outside the reviewed checkout.
set -euo pipefail
url=https://github.com/0xPolygon/codegenie.git
here=$(cd "$(dirname "$0")" && pwd)
root="${HOME}/.cache/codegenie/public-evals/codegenie"
for yml in "$here"/*/eval.yml; do
  case_id=$(basename "$(dirname "$yml")")
  head=$(sed -n 's/^  head: //p' "$yml")
  base=$(sed -n 's/^  base: //p' "$yml")
  dir="$root/$case_id"
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD)" = "$head" ]; then
    echo "$case_id: ready"; continue
  fi
  rm -rf "$dir" && mkdir -p "$dir"
  git -C "$dir" init -q
  if ! git -C "$dir" fetch -q --depth=2 "$url" "$head"; then
    # Squash-merged PR heads stay reachable from refs/pull/<N>/head.
    pr=$(sed -n 's/^pr: //p' "$(dirname "$yml")/oracle.md")
    git -C "$dir" fetch -q --depth=2 "$url" "refs/pull/$pr/head"
    git -C "$dir" cat-file -e "$head^{commit}" 2>/dev/null || git -C "$dir" fetch -q --deepen=200 "$url" "refs/pull/$pr/head"
  fi
  git -C "$dir" checkout -q --detach "$head"
  [ "$(git -C "$dir" rev-parse HEAD^)" = "$base" ] || { echo "$case_id: base is not head^" >&2; exit 1; }
  echo "$case_id: fetched $head"
done
