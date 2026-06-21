import { describe, expect, it } from "vitest";
import { resolveCodegenieRuntimeProvenance } from "../src/util/runtime-provenance.js";

describe("runtime provenance", () => {
  it("prefers build environment metadata over runtime git metadata", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const provenance = resolveCodegenieRuntimeProvenance({
      env: {
        CODEGENIE_BUILD_VERSION: "2.3.4",
        CODEGENIE_BUILD_COMMIT: commit,
        CODEGENIE_BUILD_BRANCH: "release",
        CODEGENIE_BUILD_DIRTY: "true"
      },
      projectRoot: "/repo",
      packageVersion: "0.1.0",
      runGit: () => {
        throw new Error("git should not be inspected when build metadata is present");
      }
    });

    expect(provenance).toEqual({
      packageVersion: "2.3.4",
      commit,
      shortCommit: commit.slice(0, 12),
      branch: "release",
      dirty: true,
      source: "build_env"
    });
  });

  it("falls back to runtime git metadata when build metadata is absent", () => {
    const commit = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const calls: string[] = [];
    const provenance = resolveCodegenieRuntimeProvenance({
      env: {},
      projectRoot: "/repo",
      packageVersion: "0.1.0",
      runGit: (_cwd, args) => {
        calls.push(args.join(" "));
        if (args.join(" ") === "rev-parse HEAD") {
          return commit;
        }
        if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
          return "next";
        }
        if (args.join(" ") === "status --porcelain") {
          return " M src/app.ts\n";
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
      }
    });

    expect(calls).toEqual(["rev-parse HEAD", "rev-parse --abbrev-ref HEAD", "status --porcelain"]);
    expect(provenance).toEqual({
      packageVersion: "0.1.0",
      commit,
      shortCommit: commit.slice(0, 12),
      branch: "next",
      dirty: true,
      source: "git"
    });
  });

  it("returns package-only metadata when git metadata is unavailable", () => {
    const provenance = resolveCodegenieRuntimeProvenance({
      env: {},
      projectRoot: "/repo",
      packageVersion: "0.1.0",
      runGit: () => {
        throw new Error("git unavailable");
      }
    });

    expect(provenance).toEqual({
      packageVersion: "0.1.0",
      source: "package"
    });
  });

  it("keeps commit metadata when optional git metadata is unavailable", () => {
    const commit = "1234567890abcdef1234567890abcdef12345678";
    const provenance = resolveCodegenieRuntimeProvenance({
      env: {},
      projectRoot: "/repo",
      packageVersion: "0.1.0",
      runGit: (_cwd, args) => {
        if (args.join(" ") === "rev-parse HEAD") {
          return commit;
        }
        throw new Error("optional git command unavailable");
      }
    });

    expect(provenance).toEqual({
      packageVersion: "0.1.0",
      commit,
      shortCommit: commit.slice(0, 12),
      source: "git"
    });
  });

  it("returns unknown metadata without throwing when no source is available", () => {
    const provenance = resolveCodegenieRuntimeProvenance({
      env: {},
      projectRoot: "/repo",
      runGit: () => {
        throw new Error("git unavailable");
      }
    });

    expect(provenance).toEqual({
      packageVersion: "unknown",
      source: "unknown"
    });
  });
});
