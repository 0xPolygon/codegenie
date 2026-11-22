---
repo: codegenie
case: cg-12
role: positive
intro: 68069b68047c9a8af1ed7253e7b0e74978044c9d
base: deb7190dec0b85ee811c748e87e3f38a17cdb791
introDate: 2026-06-11
fix: 1d977f23832187dc785475420c512d5209eb0b5c
kind: data-integrity/removed-guarantee
severity: medium
---

# codegenie cg-12

Review [deb7190dec0b](https://github.com/0xPolygon/codegenie/commit/deb7190dec0b85ee811c748e87e3f38a17cdb791) against its child [68069b68047c](https://github.com/0xPolygon/codegenie/commit/68069b68047c9a8af1ed7253e7b0e74978044c9d).

## Expected finding for git-tree-paths-return-quoted-names

Git tree enumeration can return a quoted spelling instead of the literal path for a non-ASCII file. lsTree requests newline-delimited names and splits on newlines without undoing Git's quoting. Consumers such as the classifier's head-tree inventory compare the returned strings to literal paths and can miss an existing file.

## Why the diff introduces it

The parent lacks this Git tree enumeration and directory probing path. The introduced lsTree returns raw text lines as paths, and headTreePaths turns those strings into the lookup set without decoding them.

## Anchors

[src/git/git-client.ts:100–108](https://github.com/0xPolygon/codegenie/blob/68069b68047c9a8af1ed7253e7b0e74978044c9d/src/git/git-client.ts#L100-L108).

## Severity floor

The prefilter uses low. Expected severity is medium. Adjudicate severity independently of detection.

## Fixing evidence

The fix requests NUL-delimited raw names and splits on NUL. Its Git-client tests compare non-ASCII and newline filenames with the literal paths. The separate unsupported-glob fix in the same commit does not identify this oracle. [Fixing commit](https://github.com/0xPolygon/codegenie/commit/1d977f23832187dc785475420c512d5209eb0b5c)
