import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderVersion } from "../src/cli/version.js";

describe("package build scaffold", () => {
  it("emits the installed CLI at the package bin path", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const buildConfig = JSON.parse(readFileSync("tsconfig.build.json", "utf8"));

    expect(packageJson.bin.codegenie).toBe("./dist/cli/main.js");
    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.build.json && node scripts/write-version.mjs");
    expect(buildConfig.compilerOptions.rootDir).toBe("src");
    expect(buildConfig.compilerOptions.outDir).toBe("dist");
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
  });

  it("renders the CLI version from package metadata", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(renderVersion()).toMatch(new RegExp(`^codegenie v${packageJson.version} / (unknown|[a-f0-9]{40})\\n$`));
  });

  it("pins the shared language grammar assets and install policy", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const workspacePolicy = readFileSync("pnpm-workspace.yaml", "utf8");
    const grammars: Array<[string, string, string]> = [
      ["tree-sitter-rust", "0.24.0", "tree-sitter-rust.wasm"],
      ["tree-sitter-python", "0.25.0", "tree-sitter-python.wasm"],
      ["tree-sitter-solidity", "1.2.13", "tree-sitter-solidity.wasm"]
    ];

    for (const [packageName, version, wasm] of grammars) {
      expect(packageJson.dependencies[packageName]).toBe(version);
      expect(workspacePolicy).toContain(`  - ${packageName}`);
      expect(existsSync(`node_modules/${packageName}/${wasm}`)).toBe(true);
    }
    expect(workspacePolicy).toContain("peerDependencyRules:");
    expect(workspacePolicy).toContain("  ignoreMissing:\n    - tree-sitter");
  });

  it("loads the Rust and Python skills and grammars from an installed package tarball", () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "codegenie-package-smoke-"));
    try {
      const packageDirectory = path.join(sandbox, "package");
      const consumerDirectory = path.join(sandbox, "consumer");
      mkdirSync(packageDirectory);
      mkdirSync(consumerDirectory);
      execFileSync("pnpm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });
      const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packageDirectory], {
        cwd: process.cwd(),
        encoding: "utf8"
      })) as Array<{ filename: string; files: Array<{ path: string }> }>;
      const artifact = packed[0];
      expect(artifact?.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "bundled-skills/lang/python.md",
        "bundled-skills/lang/rust.md",
        "dist/repo/tree-sitter/python-adapter.js",
        "dist/repo/tree-sitter/rust-adapter.js",
        "package.json"
      ]));
      const tarballPath = path.join(packageDirectory, artifact!.filename);
      const parserPackages = new Set(["tree-sitter-python", "tree-sitter-rust", "web-tree-sitter"]);
      const parserTarballs = new Map([...parserPackages].map((packageName) => {
        const dependencyPack = JSON.parse(execFileSync("npm", [
          "pack",
          path.resolve(`node_modules/${packageName}`),
          "--json",
          "--pack-destination",
          packageDirectory
        ], { encoding: "utf8" })) as Array<{ filename: string }>;
        return [packageName, path.join(packageDirectory, dependencyPack[0]!.filename)] as const;
      }));
      writeFileSync(path.join(consumerDirectory, "package.json"), JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          "@0xsequence/codegenie": `file:${tarballPath}`
        }
      }));
      const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
      const locallyLinkedDependencies = Object.keys(packageJson.dependencies)
        .filter((name) => !parserPackages.has(name))
        .sort()
        .map((name) => `  '${name}': 'link:${path.resolve(`node_modules/${name}`)}'`);
      const parserOverrides = [...parserTarballs]
        .map(([name, tarball]) => `  '${name}': 'file:${tarball}'`);
      // Keep unrelated product dependencies offline while installing packed parser dependencies into the consumer.
      writeFileSync(path.join(consumerDirectory, "pnpm-workspace.yaml"), [
        "overrides:",
        ...locallyLinkedDependencies,
        ...parserOverrides,
        `  'node-addon-api': 'link:${path.resolve("node_modules/node-addon-api")}'`,
        `  'node-gyp-build': 'link:${path.resolve("node_modules/node-gyp-build")}'`,
        ""
      ].join("\n"));
      execFileSync("pnpm", ["install", "--offline", "--ignore-scripts", "--prod", "--no-frozen-lockfile"], {
        cwd: consumerDirectory,
        stdio: "pipe"
      });

      const smokePath = path.join(consumerDirectory, "smoke.mjs");
      writeFileSync(smokePath, `
import { createRequire } from "node:module";
import { LanguageAdapterRegistry } from "@0xsequence/codegenie/dist/repo/language-adapter.js";
import { TreeSitterService } from "@0xsequence/codegenie/dist/repo/tree-sitter/tree-sitter-service.js";
import { loadSkills } from "@0xsequence/codegenie/dist/skills/skill-loader.js";

const noop = () => undefined;
const { skills, failures } = await loadSkills({
  repoRoot: process.cwd(),
  extraSkillPaths: [],
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  telemetry: { event: noop }
});
if (failures.length > 0) throw new Error(JSON.stringify(failures));
const rust = skills.find((skill) => skill.id === "lang/rust");
if (!rust) throw new Error("installed Rust skill is missing");
const python = skills.find((skill) => skill.id === "lang/python");
if (!python) throw new Error("installed Python skill is missing");

const serviceUrl = import.meta.resolve("@0xsequence/codegenie/dist/repo/tree-sitter/tree-sitter-service.js");
const installedRequire = createRequire(serviceUrl);
const rustGrammarPath = installedRequire.resolve("tree-sitter-rust/tree-sitter-rust.wasm");
const pythonGrammarPath = installedRequire.resolve("tree-sitter-python/tree-sitter-python.wasm");
const registry = new LanguageAdapterRegistry(new TreeSitterService());
const rustAdapter = registry.forPath("src/lib.rs");
const parsed = await rustAdapter.parse({
  path: "src/lib.rs",
  language: "rust",
  source: { kind: "head" },
  content: "trait Local { fn tuple(&self); }\\nimpl Local for (u8, u8) { fn tuple(&self) {} }"
});
const method = rustAdapter.listSymbols(parsed).find((symbol) => symbol.name === "tuple" && symbol.nativeKind === "impl method");
if (parsed.hasErrors || !parsed.tree || !method) throw new Error("installed Rust parser smoke failed");
const pythonAdapter = registry.forPath("src/service.py");
const pythonParsed = await pythonAdapter.parse({
  path: "src/service.py",
  language: "python",
  source: { kind: "head" },
  content: "@route(1)\\nclass Service:\\n    @audit\\n    async def authorize(self, amount: int) -> bool:\\n        return amount > 0\\n"
});
const pythonMethod = pythonAdapter.listSymbols(pythonParsed).find((symbol) => symbol.name === "authorize");
if (pythonParsed.hasErrors || !pythonParsed.tree || pythonMethod?.ownerType !== "Service" || pythonMethod.lineRange[0] !== 3) {
  throw new Error("installed Python parser smoke failed");
}
console.log(JSON.stringify({
  rustSkillPath: rust.filePath,
  pythonSkillPath: python.filePath,
  rustGrammarPath,
  pythonGrammarPath,
  rustLanguage: parsed.language,
  rustOwnerType: method.ownerType,
  pythonLanguage: pythonParsed.language,
  pythonOwnerType: pythonMethod.ownerType
}));
`);
      const smoke = JSON.parse(execFileSync(process.execPath, [smokePath], {
        cwd: consumerDirectory,
        encoding: "utf8"
      })) as {
        rustSkillPath: string;
        pythonSkillPath: string;
        rustGrammarPath: string;
        pythonGrammarPath: string;
        rustLanguage: string;
        rustOwnerType: string;
        pythonLanguage: string;
        pythonOwnerType: string;
      };

      expect(smoke).toMatchObject({
        rustLanguage: "rust",
        rustOwnerType: "(u8, u8)",
        pythonLanguage: "python",
        pythonOwnerType: "Service"
      });
      for (const installedPath of [
        smoke.rustSkillPath,
        smoke.pythonSkillPath,
        smoke.rustGrammarPath,
        smoke.pythonGrammarPath
      ]) {
        expect(installedPath.startsWith(`${consumerDirectory}${path.sep}`)).toBe(true);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 20_000);
});
