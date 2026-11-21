---
repo: codegenie
case: cg-n1
role: negative-control
intro: 04b2706e7fcd3bacdb78da357150f774a42a5bc8
base: a3ab6e02a396f2c4bf45945b0da6792be66cef4e
introDate: 2026-11-19
pr: 87
---

# codegenie cg-n1

Review base `a3ab6e02a396f2c4bf45945b0da6792be66cef4e` (the parent) against head `04b2706e7fcd3bacdb78da357150f774a42a5bc8`. The head exists only on `refs/pull/87/head`; fetch it by SHA.

## Control rationale

Lower-cases the path before extension routing so that uppercase extensions (.TS, .PY, .MD) reach the right language. The function and file were never changed or reverted afterwards.

A published finding of medium severity or higher on the changed source is a candidate false positive. Adjudicate it against the source before counting it.
