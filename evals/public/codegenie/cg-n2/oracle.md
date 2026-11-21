---
repo: codegenie
case: cg-n2
role: negative-control
intro: 8d51475ef0ab3f077b6b729674b5c7d46d08bd74
base: 51ccfaa7580e278d52be049c69a7999c7a51c566
introDate: 2026-11-19
pr: 87
---

# codegenie cg-n2

Review base `51ccfaa7580e278d52be049c69a7999c7a51c566` (the parent) against head `8d51475ef0ab3f077b6b729674b5c7d46d08bd74`. The head exists only on `refs/pull/87/head`; fetch it by SHA.

## Control rationale

Accepts a CRLF frontmatter opener in skill files and slices from the matched opener length. The parser was never changed or reverted afterwards.

A published finding of medium severity or higher on the changed source is a candidate false positive. Adjudicate it against the source before counting it.
