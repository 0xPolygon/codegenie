import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodegenieConfig } from "../src/types.js";
import { applyRepoConfigLayer } from "../src/config/config-loader.js";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { classifyChangedFiles, filterDiffFiles } from "../src/git/file-classifier.js";
import type { InternalGitClient } from "../src/git/git-client.js";
import { resolveReviewInput } from "../src/git/review-input-resolver.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("file filtering and classification", () => {
  it.each([
    {
      label: "a mixed eval diff",
      reviewable: [
        "evals/public/pi/setup.sh",
        "evals/public/README.md",
        "evals/synthetics/docs-comment-identity.test.ts",
        "scripts/check-workflows.sh",
        "tests/public-evals.test.ts"
      ],
      excluded: [
        "evals/fixtures/artifacts/history.json",
        "evals/fixtures/go.yml",
        "evals/fixtures/repos/go/feature/service/main.go",
        "evals/public/pi/pi-01/eval.yml",
        "evals/public/pi/pi-01/oracle.md",
        "evals/public/pi/pi-02/eval.yaml",
        "evals/skill-semantics/typescript.yml",
        "evals/skill-semantics/repos/typescript/feature/src/config.ts",
        "specs/project/components/evals.md",
        "specs/reviews/example.md",
        "tests/fixtures/project/src/example.ts"
      ]
    },
    { label: "a one-hunk plan-only diff", reviewable: ["specs/plans/131-example.md"], excluded: [] }
  ])("applies the repository review policy to $label", async ({ reviewable, excluded }) => {
    const { config } = applyRepoConfigLayer(defaultConfig, path.resolve(import.meta.dirname, ".."));
    const repo = initRepo();
    writeRepoFile(repo, "README.md", "# Review fixture\n");
    const baseRef = commitAll(repo, "base");
    for (const filePath of [...reviewable, ...excluded]) {
      writeRepoFile(repo, filePath, "# Proposed change\n");
    }
    const headRef = commitAll(repo, "changes");
    const telemetry = nullTelemetry();
    const resolved = await resolveReviewInput({ mode: "head", baseRef, headRef }, config, telemetry, { repoRoot: repo });
    const { kept, decisions } = await filterDiffFiles(resolved, parseDiff(resolved.rawDiff), config, telemetry);

    expect(kept.map(file => file.path).sort()).toEqual([...reviewable].sort());
    expect(kept.flatMap(file => file.hunks)).toHaveLength(reviewable.length);
    const skipped = decisions.filter(decision => decision.action === "skip");
    expect(skipped.map(decision => decision.path).sort()).toEqual([...excluded].sort());
    expect(skipped.every(decision => decision.reason === "configured skip rule")).toBe(true);
  });

  it("skips SVGs by default, permits opt-in, and retains explicit exclusions", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "README.md", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    for (const file of ["icon.svg", "assets/diagram.svg", "assets/upper.SVG"]) writeRepoFile(repo, file, "<svg></svg>\n");
    commitAll(repo, "SVGs");
    const resolved = await resolveReviewInput({ mode: "branch", branchName: "feature" }, defaultConfig, nullTelemetry(), { repoRoot: repo });
    const diff = parseDiff(resolved.rawDiff);
    expect((await filterDiffFiles(resolved, diff, defaultConfig, nullTelemetry())).kept).toHaveLength(0);
    const config = structuredClone(defaultConfig);
    config.review.skipSvgReview = false;
    expect((await filterDiffFiles(resolved, diff, config, nullTelemetry())).kept).toHaveLength(3);
    config.classification.pathRules.push({ pattern: "**/*.svg", processingMode: "skip", reason: "explicit exclusion" });
    expect((await filterDiffFiles(resolved, diff, config, nullTelemetry())).kept.map(file => file.path)).toEqual(["assets/upper.SVG"]);
  });

  it("classifies Rust, Python, and Solidity path roles without ambiguous directory skips", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "README.md", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    const languageFiles: Array<[string, string]> = [
      ["src/lib.rs", "pub fn value() {}\n"],
      ["src/inline.rs", "pub fn value() {}\n\n#[cfg(test)]\nmod tests { #[test] fn value_works() {} }\n"],
      ["src/lib_test.rs", "#[test] fn value() {}\n"],
      ["crates/payments/tests/transfer.rs", "#[test] fn transfer() {}\n"],
      ["pkg/service.py", "def value(): return 1\n"],
      ["pkg/test_service.py", "def test_value(): pass\n"],
      ["pkg/service_test.py", "def test_value(): pass\n"],
      ["contracts/Vault.sol", "contract Vault {}\n"],
      ["Vault.t.sol", "contract VaultTest {}\n"],
      ["test/VaultTest.t.sol", "contract VaultTest {}\n"],
      ["Cargo.lock", "version = 4\n"],
      ["poetry.lock", "# lock\n"],
      ["uv.lock", "version = 1\n"],
      ["Pipfile.lock", "{}\n"]
    ];
    for (const [filePath, content] of languageFiles) {
      writeRepoFile(repo, filePath, content);
    }
    commitAll(repo, "language paths");

    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);
    const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, nullTelemetry());
    const facts = await classifyChangedFiles(resolved, kept, decisions, defaultConfig, nullTelemetry());

    const byPath = new Map(facts.map((fact) => [fact.path, fact]));
    const expectedTests: Array<[string, string]> = [
      ["src/lib_test.rs", "rust"],
      ["crates/payments/tests/transfer.rs", "rust"],
      ["pkg/test_service.py", "python"],
      ["pkg/service_test.py", "python"],
      ["Vault.t.sol", "solidity"],
      ["test/VaultTest.t.sol", "solidity"]
    ];
    for (const [filePath, language] of expectedTests) {
      expect(byPath.get(filePath)).toMatchObject({ language, testStatus: "test" });
    }
    const expectedSources: Array<[string, string]> = [
      ["src/lib.rs", "rust"],
      ["src/inline.rs", "rust"],
      ["pkg/service.py", "python"],
      ["contracts/Vault.sol", "solidity"]
    ];
    for (const [filePath, language] of expectedSources) {
      expect(byPath.get(filePath)).toMatchObject({ language, testStatus: "source" });
    }
    for (const lockfile of ["Cargo.lock", "poetry.lock", "uv.lock", "Pipfile.lock"]) {
      expect(decisions).toContainEqual(expect.objectContaining({ path: lockfile, action: "skip", reason: "lockfile" }));
    }
  });

  it("recognizes generated headers only in the leading comment preamble", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "README.md", "base\n");
    const baseRef = commitAll(repo, "base");

    const generated = {
      "src/bindings.go": "// Copyright Example\n\n// Code generated by tool. DO NOT EDIT.\npackage bindings\n",
      "src/bindings.rs": "// This file is @generated by prost-build.\nfn binding() {}\n",
      "src/bindings.ts": "/**\n * @generated SignedSource<<fixture>>\n */\nexport const value = 1;\n",
      "src/bindings.py": "# Generated by the protocol buffer compiler.  DO NOT EDIT!\nprint(1)\n",
      "src/bindings.php": "<?php\n/* This file was automatically generated. */\nreturn 1;\n",
      "src/bindings.xml": "\uFEFF<?xml version=\"1.0\"?>\n<!-- Autogenerated -->\n<bindings/>\n",
      "src/bindings.html": "<!DOCTYPE html>\n<!-- Autogenerated -->\n<html></html>\n",
      "src/bindings.sh": "#!/bin/sh\n# Automatically generated\nexit 0\n",
      "src/bindings.yaml": "%YAML 1.2\n---\n# Automatically generated\nvalue: 1\n",
      "src/bindings.sql": "-- Automatically generated\nSELECT 1;\n",
      "src/bindings.ini": "; Automatically generated\nvalue = 1\n"
    };
    const reviewed = {
      // Pinned cg-12 head 68069b6, tests/file-classifier.test.ts.
      "tests/file-classifier.test.ts": '    writeRepoFile(repo, "src/marker.go", "// Code generated by tool. DO NOT EDIT.\\npackage src\\n");\n',
      "src/literal.go": 'package api\nconst fixture = `\n// Code generated by tool. DO NOT EDIT.\n`\n',
      "src/literal.ts": '/* license */ ;const fixture = "DO NOT EDIT";\n',
      "src/literal.h": '#define LABEL "DO NOT EDIT"\n',
      "src/literal.json": '{"description":"Automatically generated"}\n',
      "src/late.go": "package api\n// Code generated by tool. DO NOT EDIT.\n"
    };
    for (const [file, contents] of Object.entries({ ...generated, ...reviewed })) writeRepoFile(repo, file, contents);
    const headRef = commitAll(repo, "generated headers and handwritten fixtures");
    const telemetry = nullTelemetry();
    const resolved = await resolveReviewInput({ mode: "head", baseRef, headRef }, defaultConfig, telemetry, { repoRoot: repo });
    const { kept, decisions } = await filterDiffFiles(resolved, parseDiff(resolved.rawDiff), defaultConfig, telemetry);

    expect(kept.map(file => file.path).sort()).toEqual(Object.keys(reviewed).sort());
    expect(decisions.filter(decision => decision.reason === "generated file").map(decision => decision.path).sort())
      .toEqual(Object.keys(generated).sort());
  });

  it("records deterministic skip decisions and kept-file facts from detectors and path rules", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "go.mod", "module example.com/repo\n");
    writeRepoFile(repo, "lib/package.json", "{\"name\":\"lib\"}\n");
    writeRepoFile(repo, "README.md", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);

    writeRepoFile(repo, "src/generated.gen.go", "package src\n");
    writeRepoFile(repo, "src/marker.go", "// Code generated by tool. DO NOT EDIT.\npackage src\n");
    writeRepoFile(repo, "vendor/lib.go", "package vendor\n");
    writeRepoFile(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeRepoFile(repo, "skip/me.ts", "export const skipped = true;\n");
    writeRepoFile(repo, "src/foo_test.go", "package src\nfunc TestFoo() {}\n");
    writeRepoFile(repo, "lib/payments/a.ts", "export const amount = 1;\n");
    writeRepoFile(repo, "codegenie.toml", "[review]\ndepth = \"normal\"\n");
    commitAll(repo, "feature inventory");

    const config: CodegenieConfig = {
      ...defaultConfig,
      classification: {
        pathRules: [
          {
            pattern: "lib/**",
            labels: ["critical"],
            reviewPriority: "critical",
            reason: "critical lib"
          },
          {
            pattern: "lib/payments/**",
            labels: ["payments"],
            processingMode: "whole-file",
            reason: "payments area"
          },
          {
            pattern: "skip/**",
            processingMode: "skip",
            reason: "not reviewable"
          }
        ]
      },
      telemetry: {
        ...defaultConfig.telemetry,
        enabled: false
      }
    };
    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      config,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);
    const { kept, decisions } = await filterDiffFiles(resolved, diff, config, nullTelemetry());
    const facts = await classifyChangedFiles(resolved, kept, decisions, config, nullTelemetry());

    expect(decisions).toHaveLength(diff.files.length);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/generated.gen.go", action: "skip", reason: "generated file" }),
        expect.objectContaining({ path: "src/marker.go", action: "skip", reason: "generated file" }),
        expect.objectContaining({ path: "vendor/lib.go", action: "skip", reason: "vendored/dependency file" }),
        expect.objectContaining({ path: "pnpm-lock.yaml", action: "skip", reason: "lockfile" }),
        expect.objectContaining({ path: "skip/me.ts", action: "skip", reason: "configured skip rule" })
      ])
    );
    expect(kept.map((file) => file.path).sort()).toEqual([
      "codegenie.toml",
      "lib/payments/a.ts",
      "src/foo_test.go"
    ]);

    const payment = facts.find((fact) => fact.path === "lib/payments/a.ts");
    expect(payment).toMatchObject({
      language: "typescript",
      packageRoot: "lib",
      processingMode: "whole-file",
      reviewPriority: "critical",
      labels: ["critical", "payments"],
      testStatus: "source"
    });

    const testFile = facts.find((fact) => fact.path === "src/foo_test.go");
    expect(testFile).toMatchObject({
      language: "go",
      processingMode: "whole-file",
      testStatus: "test"
    });

    const policy = facts.find((fact) => fact.path === "codegenie.toml");
    expect(policy?.labels).toContain("policy-change");
    expect(facts.every((fact) => fact.processingMode !== "skip")).toBe(true);
  });

  it("skips committed files that match gitignore rules", async () => {
    const repo = initRepo();
    writeRepoFile(repo, ".gitignore", "ignored-artifact.txt\n");
    writeRepoFile(repo, "README.md", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "ignored-artifact.txt", "force-added ignored artifact\n");
    git(repo, ["add", "-f", "ignored-artifact.txt"]);
    git(repo, ["commit", "-m", "force add ignored artifact"]);

    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);
    const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, nullTelemetry());

    expect(diff.files.map((file) => file.path)).toEqual(["ignored-artifact.txt"]);
    expect(kept).toEqual([]);
    expect(decisions).toEqual([
      expect.objectContaining({
        path: "ignored-artifact.txt",
        action: "skip",
        reason: "ignored path"
      })
    ]);
  });

  it("finds package roots with non-ASCII directory names in the head tree", async () => {
    const repo = initRepo();
    git(repo, ["config", "core.quotePath", "true"]);
    const packageRoot = "packages/café";
    const file = `${packageRoot}/src/index.ts`;
    writeRepoFile(repo, "package.json", "{}\n");
    writeRepoFile(repo, `${packageRoot}/package.json`, "{}\n");
    writeRepoFile(repo, file, "export const value = 1;\n");
    const baseRef = commitAll(repo, "base");
    writeRepoFile(repo, file, "export const value = 2;\n");
    const headRef = commitAll(repo, "change nested package");
    const telemetry = nullTelemetry();
    const resolved = await resolveReviewInput({ mode: "head", baseRef, headRef }, defaultConfig, telemetry, { repoRoot: repo });
    const { kept, decisions } = await filterDiffFiles(resolved, parseDiff(resolved.rawDiff), defaultConfig, telemetry);

    await expect(classifyChangedFiles(resolved, kept, decisions, defaultConfig, telemetry)).resolves.toEqual([
      expect.objectContaining({ path: file, packageRoot })
    ]);
  });

  it("uses capped revision reads for generated-marker detection", async () => {
    let prefixRead = false;
    const gitClient: InternalGitClient = {
      revParse: async () => "head",
      catFile: async () => {
        throw new Error("full catFile should not be used by detectors");
      },
      catFilePrefix: async () => {
        prefixRead = true;
        return "// Code generated by tool. DO NOT EDIT.\npackage src\n";
      },
      lsTree: async () => [],
      lsFiles: async () => [],
      grep: async () => [],
      mergeBase: async () => "base",
      log: async () => [],
      diff: async () => "",
      fetch: async () => undefined,
      isShallow: async () => false,
      currentBranch: async () => "feature",
      isInsideWorktree: async () => true,
      repoRoot: async () => "/tmp/repo",
      commitExists: async () => true,
      resolveBranch: async () => undefined,
      remotes: async () => [],
      fetchFrom: async () => undefined,
      deleteRef: async () => undefined,
      listRefs: async () => [],
      lsTreeEntry: async () => undefined,
      emptyTreeSha: async () => "empty",
      firstParent: async () => "base",
      parentShas: async () => ["base"],
      checkIgnored: async () => new Set()
    };

    const { decisions } = await filterDiffFiles(
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        baseRef: "base",
        headRef: "head",
        mergeBase: "base",
        headSha: "head",
        commits: [],
        rawDiff: ""
      },
      {
        files: [
          {
            path: "src/generated.go",
            status: "modified",
            language: "go",
            hunks: []
          }
        ]
      },
      defaultConfig,
      nullTelemetry(),
      { git: gitClient }
    );

    expect(prefixRead).toBe(true);
    expect(decisions).toEqual([
      expect.objectContaining({ path: "src/generated.go", action: "skip", reason: "generated file" })
    ]);
  });

  it("batches ignored checks and skips generated content reads after decisive cheap filters", async () => {
    const ignoredCheckBatches: string[][] = [];
    const prefixReadPaths: string[] = [];
    const gitClient: InternalGitClient = {
      revParse: async () => "head",
      catFile: async () => {
        throw new Error("full catFile should not be used by detectors");
      },
      catFilePrefix: async (_ref, filePath) => {
        prefixReadPaths.push(filePath);
        return "export const value = 1;\n";
      },
      lsTree: async () => [],
      lsFiles: async () => [],
      grep: async () => [],
      mergeBase: async () => "base",
      log: async () => [],
      diff: async () => "",
      fetch: async () => undefined,
      isShallow: async () => false,
      currentBranch: async () => "feature",
      isInsideWorktree: async () => true,
      repoRoot: async () => "/tmp/repo",
      commitExists: async () => true,
      resolveBranch: async () => undefined,
      remotes: async () => [],
      fetchFrom: async () => undefined,
      deleteRef: async () => undefined,
      listRefs: async () => [],
      lsTreeEntry: async () => undefined,
      emptyTreeSha: async () => "empty",
      firstParent: async () => "base",
      parentShas: async () => ["base"],
      checkIgnored: async (paths) => {
        ignoredCheckBatches.push(paths);
        return new Set();
      }
    };

    const { decisions } = await filterDiffFiles(
      {
        mode: "branch",
        repoRoot: "/tmp/repo",
        baseRef: "base",
        headRef: "head",
        mergeBase: "base",
        headSha: "head",
        commits: [],
        rawDiff: ""
      },
      {
        files: [
          {
            path: "pnpm-lock.yaml",
            status: "modified",
            language: "yaml",
            hunks: []
          },
          {
            path: "src/a.ts",
            status: "modified",
            language: "typescript",
            hunks: []
          }
        ]
      },
      defaultConfig,
      nullTelemetry(),
      { git: gitClient }
    );

    expect(ignoredCheckBatches).toEqual([["pnpm-lock.yaml", "src/a.ts"]]);
    expect(prefixReadPaths).toEqual(["src/a.ts"]);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "pnpm-lock.yaml", action: "skip", reason: "lockfile" }),
        expect.objectContaining({ path: "src/a.ts", action: "keep" })
      ])
    );
  });

  it("treats the last matching configured processing mode as decisive for skips", async () => {
    const config: CodegenieConfig = {
      ...defaultConfig,
      classification: {
        pathRules: [
          { pattern: "src/**", processingMode: "skip", reason: "skip broad source tree" },
          { pattern: "src/payments/**", processingMode: "whole-file", reason: "review payments deeply" }
        ]
      }
    };
    const { kept } = await filterDiffFiles(
      resolvedFixture(),
      {
        files: [
          {
            path: "src/payments/charge.ts",
            status: "modified",
            language: "typescript",
            hunks: []
          }
        ]
      },
      config,
      nullTelemetry(),
      { git: fakeGitClient() }
    );

    expect(kept.map((file) => file.path)).toEqual(["src/payments/charge.ts"]);
  });

  it("a narrower later skip rule overrides a broad earlier per-hunk rule", async () => {
    const config: CodegenieConfig = {
      ...defaultConfig,
      classification: {
        pathRules: [
          { pattern: "**", processingMode: "per-hunk", reason: "review everything" },
          { pattern: "src/legacy/**", processingMode: "skip", reason: "legacy code is frozen" }
        ]
      }
    };
    const { kept, decisions } = await filterDiffFiles(
      resolvedFixture(),
      {
        files: [
          { path: "src/legacy/old.ts", status: "modified", language: "typescript", hunks: [] },
          { path: "src/app.ts", status: "modified", language: "typescript", hunks: [] }
        ]
      },
      config,
      nullTelemetry(),
      { git: fakeGitClient() }
    );

    expect(kept.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/legacy/old.ts", action: "skip", reason: "configured skip rule" })
    ]));
  });

  it("keeps deleted reviewable source files but skips deleted lock files", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "src/deleted.ts", "export const oldValue = 1;\n");
    writeRepoFile(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    git(repo, ["rm", "src/deleted.ts", "pnpm-lock.yaml"]);
    git(repo, ["commit", "-m", "delete files"]);
    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);

    const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, nullTelemetry());
    const facts = await classifyChangedFiles(resolved, kept, decisions, defaultConfig, nullTelemetry());

    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/deleted.ts", action: "keep" }),
        expect.objectContaining({ path: "pnpm-lock.yaml", action: "skip", reason: "lockfile" })
      ])
    );
    expect(facts).toEqual([
      expect.objectContaining({
        path: "src/deleted.ts",
        language: "typescript",
        processingMode: "per-hunk"
      })
    ]);
    expect(facts[0]?.degraded).toBeUndefined();
  });

  it("marks deleted reviewable files degraded when base content cannot be read", async () => {
    const diff = {
      files: [
        {
          path: "src/deleted.ts",
          status: "deleted" as const,
          language: "typescript",
          hunks: [
            {
              id: "h1",
              hunkHash: "0000000000000000000000000000000000000000000000000000000000000000",
              path: "src/deleted.ts",
              oldStart: 1,
              oldLines: 1,
              newStart: 0,
              newLines: 0,
              header: "@@ -1 +0,0 @@",
              lines: [{ kind: "delete" as const, oldLineNumber: 1, content: "export const oldValue = 1;" }]
            }
          ]
        }
      ]
    };
    const gitClient = fakeGitClient({
      catFilePrefix: async () => {
        throw new Error("base missing");
      }
    });

    const { kept, decisions } = await filterDiffFiles(resolvedFixture(), diff, defaultConfig, nullTelemetry(), { git: gitClient });
    const facts = await classifyChangedFiles(resolvedFixture(), kept, decisions, defaultConfig, nullTelemetry(), { git: gitClient });

    expect(kept.map((file) => file.path)).toEqual(["src/deleted.ts"]);
    expect(facts[0]).toMatchObject({
      path: "src/deleted.ts",
      degraded: { reason: "base content unavailable for deleted file" }
    });
  });
});

function resolvedFixture() {
  return {
    mode: "branch" as const,
    repoRoot: "/tmp/repo",
    baseRef: "base",
    headRef: "head",
    mergeBase: "base",
    headSha: "head",
    commits: [],
    rawDiff: ""
  };
}

function fakeGitClient(overrides: Partial<InternalGitClient> = {}): InternalGitClient {
  return {
    revParse: async () => "head",
    catFile: async () => "",
    catFilePrefix: async () => "export const value = 1;\n",
    lsTree: async () => [],
    lsFiles: async () => [],
    grep: async () => [],
    mergeBase: async () => "base",
    log: async () => [],
    diff: async () => "",
    fetch: async () => undefined,
    isShallow: async () => false,
    currentBranch: async () => "feature",
    isInsideWorktree: async () => true,
    repoRoot: async () => "/tmp/repo",
    commitExists: async () => true,
    resolveBranch: async () => undefined,
    remotes: async () => [],
    fetchFrom: async () => undefined,
    deleteRef: async () => undefined,
    listRefs: async () => [],
    lsTreeEntry: async () => undefined,
    emptyTreeSha: async () => "empty",
    firstParent: async () => "base",
    parentShas: async () => ["base"],
    checkIgnored: async () => new Set(),
    ...overrides
  };
}
