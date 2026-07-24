import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderVersion } from "../src/cli/version.js";

const APPROVED_DEPENDENCY_BUILDS = ["esbuild"];
const DENIED_DEPENDENCY_BUILDS = [
  "@google/genai",
  "protobufjs",
  "tree-sitter-go",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-rust",
  "tree-sitter-solidity",
  "tree-sitter-typescript",
  "yarn"
];

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

  it("pins the shared language grammar assets and pnpm 10/11 install policy", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const workspacePolicy = readFileSync("pnpm-workspace.yaml", "utf8");
    const parsedPolicy = parseYaml(workspacePolicy) as {
      allowBuilds: Record<string, boolean>;
      onlyBuiltDependencies: string[];
      ignoredBuiltDependencies: string[];
    };
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
    expect(parsedPolicy.allowBuilds).toEqual(Object.fromEntries([
      ...APPROVED_DEPENDENCY_BUILDS.map((name) => [name, true]),
      ...DENIED_DEPENDENCY_BUILDS.map((name) => [name, false])
    ]));
    expect(parsedPolicy.onlyBuiltDependencies).toEqual(APPROVED_DEPENDENCY_BUILDS);
    expect(parsedPolicy.ignoredBuiltDependencies).toEqual(DENIED_DEPENDENCY_BUILDS);
  });

  it("loads all skills and grammars under an explicit consumer build-script policy", () => {
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
        "bundled-skills/core/code-review.md",
        "bundled-skills/core/tests.md",
        "bundled-skills/lang/go.md",
        "bundled-skills/lang/python.md",
        "bundled-skills/lang/rust.md",
        "bundled-skills/lang/solidity.md",
        "bundled-skills/lang/typescript.md",
        "dist/repo/tree-sitter/python-adapter.js",
        "dist/repo/tree-sitter/rust-adapter.js",
        "dist/repo/tree-sitter/solidity-adapter.js",
        "package.json"
      ]));
      const tarballPath = path.join(packageDirectory, artifact!.filename);
      const parserPackages = new Set([
        "tree-sitter-go",
        "tree-sitter-javascript",
        "tree-sitter-python",
        "tree-sitter-rust",
        "tree-sitter-solidity",
        "tree-sitter-typescript",
        "web-tree-sitter"
      ]);
      const parserTarballs = new Map([...parserPackages].map((packageName) => {
        // These are already-published package contents. Repacking them must not run
        // source-repository prepack hooks; the consumer install below still runs
        // dependency lifecycle scripts under its explicit allowBuilds policy.
        const dependencyPack = JSON.parse(execFileSync("npm", [
          "pack",
          "--ignore-scripts",
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
      const consumerWorkspacePolicy = [
        "overrides:",
        ...locallyLinkedDependencies,
        ...parserOverrides,
        `  'node-addon-api': 'link:${path.resolve("node_modules/node-addon-api")}'`,
        `  'node-gyp-build': 'link:${path.resolve("node_modules/node-gyp-build")}'`,
        `  'yarn': 'link:${path.resolve("node_modules/yarn")}'`,
        "onlyBuiltDependencies:",
        ...APPROVED_DEPENDENCY_BUILDS.map((name) => `  - '${name}'`),
        "ignoredBuiltDependencies:",
        ...DENIED_DEPENDENCY_BUILDS.map((name) => `  - '${name}'`),
        "allowBuilds:",
        ...APPROVED_DEPENDENCY_BUILDS.map((name) => `  '${name}': true`),
        ...DENIED_DEPENDENCY_BUILDS.map((name) => `  '${name}': false`),
        ""
      ].join("\n");
      writeFileSync(path.join(consumerDirectory, "pnpm-workspace.yaml"), consumerWorkspacePolicy);
      expect(consumerWorkspacePolicy).toContain("onlyBuiltDependencies:\n  - 'esbuild'");
      for (const packageName of DENIED_DEPENDENCY_BUILDS) {
        expect(consumerWorkspacePolicy).toContain(`  - '${packageName}'`);
        expect(consumerWorkspacePolicy).toContain(`  '${packageName}': false`);
      }
      expect(consumerWorkspacePolicy).toContain("allowBuilds:\n  'esbuild': true");
      const effectiveOnlyBuiltDependencies = JSON.parse(execFileSync("pnpm", [
        "config",
        "get",
        "only-built-dependencies",
        "--json"
      ], {
        cwd: consumerDirectory,
        encoding: "utf8"
      })) as string[];
      const effectiveIgnoredBuiltDependencies = JSON.parse(execFileSync("pnpm", [
        "config",
        "get",
        "ignored-built-dependencies",
        "--json"
      ], {
        cwd: consumerDirectory,
        encoding: "utf8"
      })) as string[];
      const effectiveAllowBuilds = JSON.parse(execFileSync("pnpm", [
        "config",
        "get",
        "allow-builds",
        "--json"
      ], {
        cwd: consumerDirectory,
        encoding: "utf8"
      })) as Record<string, boolean>;
      expect(effectiveOnlyBuiltDependencies).toEqual(APPROVED_DEPENDENCY_BUILDS);
      expect(effectiveIgnoredBuiltDependencies).toEqual(DENIED_DEPENDENCY_BUILDS);
      expect(effectiveAllowBuilds).toEqual(Object.fromEntries([
        ...APPROVED_DEPENDENCY_BUILDS.map((name) => [name, true]),
        ...DENIED_DEPENDENCY_BUILDS.map((name) => [name, false])
      ]));
      const installArgs = [
        "install",
        "--offline",
        "--prod",
        "--no-frozen-lockfile",
        "--config.ignore-scripts=false"
      ];
      const effectiveIgnoreScripts = execFileSync("pnpm", [
        "config",
        "get",
        "ignore-scripts",
        "--config.ignore-scripts=false"
      ], {
        cwd: consumerDirectory,
        encoding: "utf8"
      }).trim();
      expect(effectiveIgnoreScripts).toBe("false");
      expect(installArgs).toContain("--config.ignore-scripts=false");
      execFileSync("pnpm", installArgs, {
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
const bundledIds = skills.filter((skill) => skill.source === "bundled").map((skill) => skill.id).sort();
const expectedBundledIds = ["core/code-review", "core/tests", "lang/go", "lang/python", "lang/rust", "lang/solidity", "lang/typescript"];
if (JSON.stringify(bundledIds) !== JSON.stringify(expectedBundledIds)) throw new Error("installed bundled skills differ: " + JSON.stringify(bundledIds));
const rust = skills.find((skill) => skill.id === "lang/rust");
if (!rust) throw new Error("installed Rust skill is missing");
const python = skills.find((skill) => skill.id === "lang/python");
if (!python) throw new Error("installed Python skill is missing");
const solidity = skills.find((skill) => skill.id === "lang/solidity");
if (!solidity) throw new Error("installed Solidity skill is missing");

const serviceUrl = import.meta.resolve("@0xsequence/codegenie/dist/repo/tree-sitter/tree-sitter-service.js");
const installedRequire = createRequire(serviceUrl);
const goGrammarPath = installedRequire.resolve("tree-sitter-go/tree-sitter-go.wasm");
const typescriptGrammarPath = installedRequire.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm");
const tsxGrammarPath = installedRequire.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm");
const javascriptGrammarPath = installedRequire.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm");
const rustGrammarPath = installedRequire.resolve("tree-sitter-rust/tree-sitter-rust.wasm");
const pythonGrammarPath = installedRequire.resolve("tree-sitter-python/tree-sitter-python.wasm");
const solidityGrammarPath = installedRequire.resolve("tree-sitter-solidity/tree-sitter-solidity.wasm");
const service = new TreeSitterService();
const grammarInputs = [
  ["go", "package fixture\\nfunc value() int { return 1 }"],
  ["typescript", "export function value(): number { return 1 }"],
  ["tsx", "export function View() { return <div /> }"],
  ["javascript", "export function value() { return 1 }"],
  ["rust", "pub fn value() -> i32 { 1 }"],
  ["python", "def value():\\n    return 1"],
  ["solidity", "pragma solidity ^0.8.20; contract Value { function value() external pure returns (uint256) { return 1; } }"]
];
const parsedGrammars = [];
for (const [grammarId, content] of grammarInputs) {
  const grammarParse = await service.parse({
    path: "installed-" + grammarId,
    language: grammarId,
    source: { kind: "head" },
    content
  });
  if (grammarParse.hasErrors || !grammarParse.tree || grammarParse.adapterId !== grammarId) {
    throw new Error("installed grammar parse failed: " + grammarId);
  }
  parsedGrammars.push(grammarId);
}
const registry = new LanguageAdapterRegistry(service);
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
const solidityAdapter = registry.forPath("contracts/Vault.sol");
const solidityParsed = await solidityAdapter.parse({
  path: "contracts/Vault.sol",
  language: "solidity",
  source: { kind: "head" },
  content: "contract Vault { uint256 public total; function withdraw(uint256 amount) external { total -= amount; } }"
});
const solidityValue = solidityAdapter.listSymbols(solidityParsed).find((symbol) => symbol.name === "total");
const solidityMethod = solidityAdapter.listSymbols(solidityParsed).find((symbol) => symbol.name === "withdraw");
if (solidityParsed.hasErrors || !solidityParsed.tree || solidityValue?.kind !== "value" || solidityValue.ownerType !== "Vault" || solidityMethod?.ownerType !== "Vault") {
  throw new Error("installed Solidity parser smoke failed");
}
console.log(JSON.stringify({
  rustSkillPath: rust.filePath,
  pythonSkillPath: python.filePath,
  soliditySkillPath: solidity.filePath,
  grammarPaths: [
    goGrammarPath,
    typescriptGrammarPath,
    tsxGrammarPath,
    javascriptGrammarPath,
    rustGrammarPath,
    pythonGrammarPath,
    solidityGrammarPath
  ],
  parsedGrammars,
  rustLanguage: parsed.language,
  rustOwnerType: method.ownerType,
  pythonLanguage: pythonParsed.language,
  pythonOwnerType: pythonMethod.ownerType,
  solidityLanguage: solidityParsed.language,
  solidityOwnerType: solidityMethod.ownerType,
  solidityValueKind: solidityValue.kind
}));
`);
      const smoke = JSON.parse(execFileSync(process.execPath, [smokePath], {
        cwd: consumerDirectory,
        encoding: "utf8"
      })) as {
        rustSkillPath: string;
        pythonSkillPath: string;
        soliditySkillPath: string;
        grammarPaths: string[];
        parsedGrammars: string[];
        rustLanguage: string;
        rustOwnerType: string;
        pythonLanguage: string;
        pythonOwnerType: string;
        solidityLanguage: string;
        solidityOwnerType: string;
        solidityValueKind: string;
      };

      expect(smoke).toMatchObject({
        rustLanguage: "rust",
        rustOwnerType: "(u8, u8)",
        pythonLanguage: "python",
        pythonOwnerType: "Service",
        solidityLanguage: "solidity",
        solidityOwnerType: "Vault",
        solidityValueKind: "value",
        parsedGrammars: ["go", "typescript", "tsx", "javascript", "rust", "python", "solidity"]
      });
      for (const installedPath of [
        smoke.rustSkillPath,
        smoke.pythonSkillPath,
        smoke.soliditySkillPath,
        ...smoke.grammarPaths
      ]) {
        expect(installedPath.startsWith(`${consumerDirectory}${path.sep}`)).toBe(true);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 20_000);
});
