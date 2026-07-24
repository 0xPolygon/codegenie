import { describe, expect, it } from "vitest";
import { allocateShortHunkIds, buildDiffAnchorIndex, parseDiff, validateDiffAnchor } from "../src/git/diff-parser.js";
import type { DiffHunk, UnifiedDiff } from "../src/types.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("diff parser", () => {
  it("parses statuses, line numbers, and stable hunk ids", () => {
    const diff = parseDiff(FIXTURE_DIFF);

    expect(diff.files.map((file) => [file.path, file.status])).toEqual([
      ["src/a.ts", "modified"],
      ["new-name.ts", "renamed"],
      ["dead.go", "deleted"],
      ["logo.png", "modified"],
      ["run.sh", "modified"]
    ]);
    expect(diff.files[2]?.hunks[0]?.lines).toMatchObject([
      { kind: "delete", oldLineNumber: 1, content: "package dead" },
      { kind: "delete", oldLineNumber: 2, content: "func x() {}" }
    ]);
    expect(diff.files[3]?.isBinary).toBe(true);
    expect(diff.files[4]?.modeOnly).toBe(true);

    const firstHunk = diff.files[0]?.hunks[0];
    expect(firstHunk?.id).toMatch(/^[0-9a-f]{8}$/);
    expect(firstHunk?.hunkHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseDiff(FIXTURE_DIFF).files[0]?.hunks[0]?.id).toBe(firstHunk?.id);
    expect(firstHunk?.lines).toMatchObject([
      { kind: "context", oldLineNumber: 1, newLineNumber: 1 },
      { kind: "delete", oldLineNumber: 2 },
      { kind: "add", newLineNumber: 2 },
      { kind: "add", newLineNumber: 3 },
      { kind: "context", oldLineNumber: 3, newLineNumber: 4 }
    ]);
  });

  it("uses golden hunk ids that are sensitive to hunk coordinate shifts", () => {
    const original = parseDiff(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ function a
 line1
-old
+new
+extra
 line3
`);
    const shifted = parseDiff(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -11,3 +11,4 @@ function a
 line1
-old
+new
+extra
 line3
`);

    const originalHunk = original.files[0]?.hunks[0];
    const shiftedHunk = shifted.files[0]?.hunks[0];
    const originalId = originalHunk?.id;
    const shiftedId = shiftedHunk?.id;
    expect(originalId).toBe("67b374e1");
    expect(originalHunk?.hunkHash).toBe("67b374e1b962d93f6e48a62c580d36498d2bbe3c3c03e35813c353894883d2e5");
    expect(shiftedId).toMatch(/^[0-9a-f]{8}$/u);
    expect(shiftedId).not.toBe(originalId);
  });

  it("extends only colliding short-id groups and rejects duplicate full digests", () => {
    const firstHash = `aaaaaaaa1${"0".repeat(55)}`;
    const secondHash = `aaaaaaaa2${"0".repeat(55)}`;
    const distinctHash = `bbbbbbbb${"0".repeat(56)}`;
    const allocated = allocateShortHunkIds(syntheticDiff([firstHash, secondHash, distinctHash]));

    expect(allocated.files[0]?.hunks.map((hunk) => hunk.id)).toEqual([
      "aaaaaaaa1000",
      "aaaaaaaa2000",
      "bbbbbbbb"
    ]);
    expect(() => allocateShortHunkIds(syntheticDiff([firstHash, firstHash]))).toThrow(/duplicate hunk digest/u);
  });

  it("validates changed-line anchors on the correct side", () => {
    const diff = parseDiff(FIXTURE_DIFF);
    const index = buildDiffAnchorIndex(diff);
    const modifiedHunk = diff.files[0]?.hunks[0];
    const renameHunk = diff.files[1]?.hunks[0];

    expect(
      validateDiffAnchor(
        { path: "src/a.ts", line: 2, side: "RIGHT", hunkId: modifiedHunk?.id ?? "" },
        index
      )
    ).toEqual({ valid: true });
    expect(
      validateDiffAnchor(
        { path: "src/a.ts", line: 1, side: "RIGHT", hunkId: modifiedHunk?.id ?? "" },
        index
      )
    ).toEqual({ valid: false, reason: "line_not_changed" });
    expect(
      validateDiffAnchor(
        { path: "old-name.ts", line: 1, side: "LEFT", hunkId: renameHunk?.id ?? "" },
        index
      )
    ).toEqual({ valid: true });
    expect(
      validateDiffAnchor(
        { path: "new-name.ts", line: 1, side: "LEFT", hunkId: renameHunk?.id ?? "" },
        index
      )
    ).toEqual({ valid: false, reason: "wrong_side_path" });
    expect(
      validateDiffAnchor(
        { path: "src/a.ts", line: 2, side: "RIGHT", hunkId: "missing" },
        index
      )
    ).toEqual({ valid: false, reason: "unknown_hunk" });
  });

  it("fails malformed non-empty input", () => {
    expect(() => parseDiff("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n")).toThrow(
      /expected git diff header/
    );
  });

  it("consumes GIT binary patch payload sections", () => {
    const diff = parseDiff(`diff --git a/image.bin b/image.bin
index 1111111..2222222 100644
GIT binary patch
literal 4
LcmeZQ

literal 0
HcmV?d00001
`);

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: "image.bin",
      isBinary: true,
      hunks: []
    });
  });

  it("parses real git diffs for paths with spaces", () => {
    const repo = initRepo();
    writeRepoFile(repo, "a b.txt", "one\n");
    const base = commitAll(repo, "base");
    writeRepoFile(repo, "a b.txt", "one\ntwo\n");
    const head = commitAll(repo, "head");
    const raw = git(repo, [
      "-c",
      "core.quotepath=off",
      "-c",
      "diff.mnemonicPrefix=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "--find-renames",
      "--find-copies",
      "--diff-algorithm=myers",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      head,
      "--"
    ]);

    expect(raw).toContain("diff --git a/a b.txt b/a b.txt");
    const diff = parseDiff(raw);
    expect(diff.files[0]?.path).toBe("a b.txt");
    expect(diff.files[0]?.hunks[0]?.path).toBe("a b.txt");
    expect(diff.files[0]?.hunks[0]?.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "add", newLineNumber: 2, content: "two" })])
    );
  });

  it("does not mark hunkless added or deleted files as mode-only changes", () => {
    const diff = parseDiff(`diff --git a/new-empty.ts b/new-empty.ts
new file mode 100644
index 0000000..e69de29
diff --git a/old-empty.ts b/old-empty.ts
deleted file mode 100644
index e69de29..0000000
`);

    expect(diff.files).toMatchObject([
      { path: "new-empty.ts", status: "added" },
      { path: "old-empty.ts", status: "deleted" }
    ]);
    expect(diff.files[0]?.modeOnly).toBeUndefined();
    expect(diff.files[1]?.modeOnly).toBeUndefined();
  });

  it("marks a pure permission change mode-only but not a rename that also changes mode", () => {
    const pureChmod = parseDiff(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`);
    expect(pureChmod.files[0]).toMatchObject({ path: "run.sh", status: "modified", modeOnly: true });

    const renameChmod = parseDiff(`diff --git a/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
similarity index 100%
rename from run.sh
rename to scripts/run.sh
`);
    expect(renameChmod.files[0]).toMatchObject({ path: "scripts/run.sh", status: "renamed" });
    expect(renameChmod.files[0]?.modeOnly).toBeUndefined();
  });

  it("parses independently C-quoted diff-git paths and octal escapes", () => {
    const diff = parseDiff(`diff --git a/src/plain.ts "b/src/quoted\\040new.ts"
index 1111111..2222222 100644
--- a/src/plain.ts
+++ "b/src/quoted\\040new.ts"
@@ -1 +1 @@
-old
+new
`);

    expect(diff.files[0]?.path).toBe("src/quoted new.ts");
    expect(diff.files[0]?.hunks[0]?.path).toBe("src/quoted new.ts");
  });

  it("parses copied files, symlink diffs, and submodule pointer diffs", () => {
    const diff = parseDiff(`diff --git a/src/source.ts b/src/copy.ts
similarity index 100%
copy from src/source.ts
copy to src/copy.ts
diff --git a/link b/link
new file mode 120000
index 0000000..1111111
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+target/file
diff --git a/vendor/lib b/vendor/lib
index 1234567..89abcde 160000
--- a/vendor/lib
+++ b/vendor/lib
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
`);

    expect(diff.files[0]).toMatchObject({
      path: "src/copy.ts",
      oldPath: "src/source.ts",
      status: "copied"
    });
    expect(diff.files[1]).toMatchObject({
      path: "link",
      status: "added",
      isSymlink: true
    });
    expect(diff.files[2]).toMatchObject({
      path: "vendor/lib",
      isSubmodule: true
    });
  });
});

function syntheticDiff(hashes: string[]): UnifiedDiff {
  return {
    files: [{
      path: "synthetic.ts",
      status: "modified",
      language: "typescript",
      hunks: hashes.map((hunkHash, index): DiffHunk => ({
        id: hunkHash,
        hunkHash,
        path: "synthetic.ts",
        oldStart: index + 1,
        oldLines: 1,
        newStart: index + 1,
        newLines: 1,
        header: "",
        lines: [{ kind: "add", content: String(index), newLineNumber: index + 1 }]
      }))
    }]
  };
}

const FIXTURE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ function a
 line1
-old
+new
+extra
 line3
\\ No newline at end of file
diff --git a/old-name.ts b/new-name.ts
similarity index 70%
rename from old-name.ts
rename to new-name.ts
index 3333333..4444444 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,2 +1,2 @@
-old
+new
 keep
diff --git a/dead.go b/dead.go
deleted file mode 100644
index 5555555..0000000
--- a/dead.go
+++ /dev/null
@@ -1,2 +0,0 @@
-package dead
-func x() {}
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;
