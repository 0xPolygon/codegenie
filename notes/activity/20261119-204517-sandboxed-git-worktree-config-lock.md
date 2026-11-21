---
created: 2026-11-19T20:45:17.562Z
author: operator
source: "#44 deep review, report from @lead-dev-2 at 2026-11-19T20:44Z; reproduced in the operator's own sandboxed push failure the same day"
status: verified
kind: learning
---

Claude Code members run git inside a sandbox. Two things follow from that on this machine:

- **Network git needs a standalone command.** `git push`, `git fetch` and `git pull` are excluded from the sandbox only when the command is run on its own (for example `git fetch origin`). Prefixed with `cd … &&` or chained, they run sandboxed. SSH then fails before it connects ("Bad owner or permissions" on a root-owned `/nix/store` ssh config file, which shows as uid 65534 inside the sandbox).
- **A stale config lock.** Sandboxed git commands in a worktree can leave a 0-byte, read-only `.git/config.lock` in the main checkout. It blocks later git config writes. The cause is that the sandbox denies writes to `.git/config`, so any git command that writes config fails halfway and leaves the lock behind. The usual trigger is `git switch -c <branch> origin/master`, which sets an upstream. Create branches with `git switch -c <branch> --no-track origin/master` instead, and remove a leftover lock if one appears.
