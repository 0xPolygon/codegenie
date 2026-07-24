import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { classifyChangedFiles, filterDiffFiles } from "../src/git/file-classifier.js";
import { resolveReviewInput } from "../src/git/review-input-resolver.js";
import { buildReviewPackets } from "../src/pipeline/packet-builder.js";
import { buildPlannerDossier, defaultPlan } from "../src/pipeline/planner.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { candidateTestPaths } from "../src/repo/likely-tests.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { buildLensRegistry, skillsCompatibleWithLanguage } from "../src/skills/lens-registry.js";
import { BUNDLED_SKILL_WHY_LEDGER, createPromptBuilder } from "../src/skills/prompt-builder.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { CandidateFinding, DiffHunk, Logger } from "../src/types.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("Plan 98 Solidity vertical slice", () => {
  it("builds clean Solidity structural context, Foundry tests, lens selection, and Stage 7/9 prompts", async () => {
    const repo = initRepo();
    const featureSource = fixture("Vault.sol");
    const baseSource = featureSource.replace('amount <= totalAssets, "insufficient"', 'amount < totalAssets, "insufficient"');
    expect(baseSource).not.toBe(featureSource);
    writeRepoFile(repo, "foundry.toml", "[profile.default]\nsrc = 'contracts'\ntest = 'test'\n");
    writeRepoFile(repo, "contracts/Vault.sol", baseSource);
    writeRepoFile(repo, "test/Vault.t.sol", fixture("Vault.t.sol"));
    writeRepoFile(repo, "test/VaultTest.t.sol", fixture("VaultTest.t.sol"));
    writeRepoFile(repo, "custom-test/Vault.t.sol", fixture("Vault.t.sol"));
    writeRepoFile(repo, "test/Vault.ts", "describe('Vault', () => {});\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "contracts/Vault.sol", featureSource);
    commitAll(repo, "allow full withdrawal");

    const telemetry = nullTelemetry();
    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      telemetry,
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);
    const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, telemetry);
    const facts = await classifyChangedFiles(resolved, kept, decisions, defaultConfig, telemetry);
    const index = await buildRepositoryIndex(resolved, kept, facts, defaultConfig, telemetry);
    const { skills, failures } = await loadSkills({
      repoRoot: repo,
      extraSkillPaths: [],
      logger: silentLogger(),
      telemetry
    });
    expect(failures).toEqual([]);
    const lenses = buildLensRegistry(skills, defaultConfig.lenses, silentLogger(), telemetry);
    const dossier = await buildPlannerDossier(
      resolved,
      kept,
      facts,
      decisions,
      index,
      defaultConfig,
      telemetry,
      { lenses: lenses.enabledLenses() }
    );
    const plan = defaultPlan(dossier, lenses.enabledLenses(), "Solidity structural fixture");
    const packets = await buildReviewPackets(plan, kept, facts, index, telemetry, {
      config: defaultConfig,
      enabledLenses: lenses.enabledLenses().map((lens) => lens.id)
    });

    expect(diff.files).toEqual([expect.objectContaining({ path: "contracts/Vault.sol", language: "solidity" })]);
    expect(facts).toEqual([expect.objectContaining({ path: "contracts/Vault.sol", language: "solidity", testStatus: "source" })]);
    expect(index.symbolFacts).toEqual([
      expect.objectContaining({
        path: "contracts/Vault.sol",
        enclosingSymbol: "Vault.withdraw",
        symbolKind: "method",
        symbolNativeKind: "abstract contract function",
        symbolRange: [36, 45],
        source: "tree-sitter",
        confidence: "syntactic"
      })
    ]);

    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("contracts/Vault.sol");
    const parsed = await adapter.parse({
      path: "contracts/Vault.sol",
      language: "solidity",
      content: featureSource,
      source: { kind: "head" }
    });
    expect(adapter.id).toBe("solidity");
    expect(parsed).toMatchObject({ language: "solidity", adapterId: "solidity", hasErrors: false });
    expect(parsed.tree).toBeDefined();
    expect(adapter.getImports(parsed)).toEqual(["./Access.sol", "./Math.sol", "./Token.sol"]);

    const symbols = adapter.listSymbols(parsed);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Vault", kind: "type", nativeKind: "abstract contract", lineRange: [9, 53] }),
      expect.objectContaining({ name: "totalAssets", kind: "value", nativeKind: "state variable", ownerType: "Vault", lineRange: [10, 10] }),
      expect.objectContaining({ name: "MAX_WITHDRAWAL", kind: "value", nativeKind: "constant", ownerType: "Vault" }),
      expect.objectContaining({ name: "asset", kind: "value", nativeKind: "immutable state variable", ownerType: "Vault" }),
      expect.objectContaining({ name: "Position", kind: "type", nativeKind: "struct", ownerType: "Vault", lineRange: [14, 17] }),
      expect.objectContaining({ name: "Status", kind: "type", nativeKind: "enum", ownerType: "Vault" }),
      expect.objectContaining({ name: "Shares", kind: "type", nativeKind: "user-defined value type", ownerType: "Vault" }),
      expect.objectContaining({ name: "Withdrawal", kind: "other", nativeKind: "event", ownerType: "Vault" }),
      expect.objectContaining({ name: "InsufficientAssets", kind: "other", nativeKind: "custom error", ownerType: "Vault" }),
      expect.objectContaining({ name: "onlyOwner", kind: "method", nativeKind: "modifier", ownerType: "Vault" }),
      expect.objectContaining({ name: "constructor", kind: "method", nativeKind: "constructor", ownerType: "Vault" }),
      expect.objectContaining({
        name: "withdraw",
        kind: "method",
        ownerType: "Vault",
        lineRange: [36, 45],
        signature: "function withdraw( uint256 amount, address payable recipient ) external onlyOwner returns (uint256 remaining)"
      }),
      expect.objectContaining({ name: "withdraw", kind: "method", ownerType: "Vault", lineRange: [47, 49] }),
      expect.objectContaining({ name: "fallback", kind: "method", nativeKind: "fallback", ownerType: "Vault" }),
      expect.objectContaining({ name: "receive", kind: "method", nativeKind: "receive", ownerType: "Vault" }),
      expect.objectContaining({ name: "IVault", kind: "interface", nativeKind: "interface", lineRange: [55, 57] }),
      expect.objectContaining({ name: "totalAssets", kind: "method", ownerType: "IVault", lineRange: [56, 56] }),
      expect.objectContaining({ name: "VaultMath", kind: "type", nativeKind: "library", lineRange: [59, 63] }),
      expect.objectContaining({ name: "scale", kind: "method", ownerType: "VaultMath", lineRange: [60, 62] }),
      expect.objectContaining({ name: "normalize", kind: "function", nativeKind: "free function", lineRange: [65, 67] })
    ]));
    expect(symbols.find((symbol) => symbol.name === "FILE_LIMIT")).toBeUndefined();
    expect(symbols.every((symbol) => symbol.exported === undefined)).toBe(true);

    for (const line of [36, 39, 42, 45]) {
      expect(adapter.getEnclosingSymbol(parsed, line), String(line)).toMatchObject({ name: "withdraw", lineRange: [36, 45] });
    }
    expect(adapter.getEnclosingSymbol(parsed, 9)).toMatchObject({ name: "Vault", lineRange: [9, 53] });
    expect(adapter.getEnclosingSymbol(parsed, 10)).toMatchObject({ name: "totalAssets", kind: "value" });
    expect(adapter.getEnclosingSymbol(parsed, 15)).toMatchObject({ name: "Position", lineRange: [14, 17] });
    expect(adapter.getEnclosingSymbol(parsed, 51)).toMatchObject({ name: "fallback" });

    const identityHunk: DiffHunk = {
      id: "solidity-overloads",
      path: parsed.path,
      oldStart: 36,
      oldLines: 0,
      newStart: 36,
      newLines: 14,
      header: "",
      lines: [36, 42, 48].map((line) => ({ kind: "add" as const, content: "+", newLineNumber: line }))
    };
    expect(adapter.getChangedSymbols(parsed, identityHunk)).toEqual([
      expect.objectContaining({ name: "withdraw", lineRange: [36, 45], changedLines: [36, 42] }),
      expect.objectContaining({ name: "withdraw", lineRange: [47, 49], changedLines: [48] })
    ]);

    const parsedTests = await adapter.parse({
      path: "test/Vault.t.sol",
      language: "solidity",
      source: { kind: "head" },
      content: fixture("Vault.t.sol")
    });
    const testSymbols = adapter.listSymbols(parsedTests);
    expect(testSymbols.filter((symbol) => symbol.nativeKind === "test case").map((symbol) => symbol.name)).toEqual([
      "testWithdrawRejectsExcess",
      "invariantTotalAssetsBounded"
    ]);
    for (const name of ["setUp", "helperWithdraw", "testFreeFunctionIsNotFoundryTest", "testInterfaceMethodIsNotFoundryTest", "testLibraryMethodIsNotFoundryTest"]) {
      expect(testSymbols.find((symbol) => symbol.name === name)?.nativeKind, name).not.toBe("test case");
    }

    const outline = await index.tools.readFileOutline("contracts/Vault.sol");
    expect(outline.meta).toMatchObject({ backend: "tree-sitter", precision: "syntactic", degraded: false });
    expect(outline.outline).toMatchObject({
      path: "contracts/Vault.sol",
      language: "solidity",
      imports: ["./Access.sol", "./Math.sol", "./Token.sol"]
    });

    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet).toMatchObject({
      path: "contracts/Vault.sol",
      language: "solidity",
      lenses: expect.arrayContaining(["lang/solidity"]),
      context: {
        path: "contracts/Vault.sol",
        enclosingMethod: expect.objectContaining({ name: "withdraw", ownerType: "Vault", lineRange: [36, 45] }),
        enclosingType: expect.objectContaining({ name: "Vault", kind: "type", nativeKind: "abstract contract" })
      }
    });
    expect(packet.contextText).toContain("function withdraw( uint256 amount, address payable recipient )");
    expect(packet.packetSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "withdraw", ownerType: "Vault", lineRange: [36, 45] })
    ]));
    expect(packet.relevantTests).toEqual([
      expect.objectContaining({ path: "test/Vault.t.sol", name: "testWithdrawRejectsExcess", nativeKind: "test case", lineRange: [6, 8] }),
      expect.objectContaining({ path: "test/Vault.t.sol", name: "invariantTotalAssetsBounded", nativeKind: "test case", lineRange: [10, 12] }),
      expect.objectContaining({ path: "test/VaultTest.t.sol", name: "testWithdrawTransfersAssets", nativeKind: "test case", lineRange: [4, 6] })
    ]);
    const publicLikelyTests = await index.tools.findLikelyTests({ path: "contracts/Vault.sol" });
    expect(publicLikelyTests.meta).toMatchObject({ backend: "tree-sitter", precision: "heuristic", degraded: false });
    expect(publicLikelyTests.tests).toEqual(packet.relevantTests);

    const compatibleSkills = skillsCompatibleWithLanguage(
      packet.lenses.flatMap((lensId) => lenses.skillsForLens(lensId)),
      packet.language
    );
    expect(compatibleSkills.map((skill) => skill.id)).toContain("lang/solidity");
    const promptBuilder = createPromptBuilder(lenses);
    const stage7 = promptBuilder.buildPacketReviewPrompt({ packet, skills: compatibleSkills });
    expect(stage7.prompt).toContain("Repeated full `msg.value`");
    expect(stage7.prompt).toContain("typed reverting calls");
    expect(stage7.prompt).not.toContain("Mutable defaults");
    expect(stage7.prompt).not.toContain("Reachable panic paths");
    expect(stage7.projection?.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0)).toBe(true);
    expect(stage7.projection?.totalChars).toBeLessThanOrEqual(12_000);

    const stage9 = promptBuilder.buildVerifierPrompt({
      candidate: fixtureCandidate(packet.id),
      originContext: packet.contextText,
      hunksText: packet.hunks.map((hunk) => hunk.contentWithLineNumbers).join("\n"),
      skills: compatibleSkills
    });
    expect(stage9.prompt).toContain("documented compatible delegatecall layouts");
    expect(stage9.prompt).toContain("validate oracle data");
    expect(stage9.prompt).not.toContain("integer minor units");
    expect(stage9.prompt).not.toContain("mere presence of `unsafe`");
    expect(stage9.projection?.perSkill.every((entry) => !entry.omitted && entry.truncatedChars === 0)).toBe(true);
    expect(stage9.projection?.totalChars).toBeLessThanOrEqual(12_000);
  });

  it("keeps partial output and signatures bounded and limits tests to default Foundry conventions", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("contracts/Partial.sol");
    const parameters = Array.from({ length: 100 }, (_value, index) => `uint256 value${String(index)}`).join(", ");
    const parsed = await adapter.parse({
      path: "contracts/Partial.sol",
      language: "solidity",
      source: { kind: "head" },
      content: [
        "contract Partial {",
        `function bounded(${parameters}) external returns (uint256) {`,
        "return 1;",
        "}",
        "function intact() external {}",
        "function broken() external { uint256 value = ; }",
        "}"
      ].join("\n")
    });
    const symbols = adapter.listSymbols(parsed);
    expect(parsed.hasErrors).toBe(true);
    expect(parsed.tree).toBeDefined();
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Partial", kind: "type" }),
      expect.objectContaining({ name: "bounded", kind: "method", ownerType: "Partial" }),
      expect.objectContaining({ name: "intact", kind: "method", ownerType: "Partial" })
    ]));
    expect(symbols.every((symbol) => (symbol.signature?.length ?? 0) <= 600)).toBe(true);
    expect(symbols.find((symbol) => symbol.name === "bounded")?.signature).not.toContain("return 1");

    const paths = [
      "foundry.toml",
      "contracts/Vault.sol",
      "test/Vault.t.sol",
      "test/VaultTest.t.sol",
      "custom-test/Vault.t.sol",
      "test/Vault.ts"
    ];
    expect(candidateTestPaths("contracts/Vault.sol", paths, "solidity")).toEqual([
      "test/Vault.t.sol",
      "test/VaultTest.t.sol"
    ]);
    expect(candidateTestPaths("contracts/Vault.sol", paths.filter((entry) => entry !== "foundry.toml"), "solidity")).toEqual([]);

    const nestedPaths = [
      "foundry.toml",
      "test/Vault.t.sol",
      "packages/payments/foundry.toml",
      "packages/payments/contracts/Vault.sol",
      "packages/payments/test/Vault.t.sol",
      "packages/payments/test/VaultTest.t.sol"
    ];
    expect(candidateTestPaths("packages/payments/contracts/Vault.sol", nestedPaths, "solidity")).toEqual([
      "packages/payments/test/Vault.t.sol",
      "packages/payments/test/VaultTest.t.sol"
    ]);
  });

  it("keeps Unicode declaration signatures exact and file-level constants deferred", async () => {
    const adapter = new LanguageAdapterRegistry(new TreeSitterService()).forPath("contracts/UnicodeVault.sol");
    const parsed = await adapter.parse({
      path: "contracts/UnicodeVault.sol",
      language: "solidity",
      content: fixture("UnicodeVault.sol"),
      source: { kind: "head" }
    });

    expect(parsed).toMatchObject({ adapterId: "solidity", hasErrors: false });
    const symbols = adapter.listSymbols(parsed);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "UnicodeVault",
        kind: "type",
        signature: "contract UnicodeVault"
      }),
      expect.objectContaining({
        name: "MAX_DEPOSIT",
        kind: "value",
        nativeKind: "constant",
        ownerType: "UnicodeVault"
      }),
      expect.objectContaining({
        name: "quote",
        ownerType: "UnicodeVault",
        signature: "function quote( uint256 amount ) external pure returns (uint256 quoted)"
      })
    ]));
    expect(symbols.find((symbol) => symbol.name === "FILE_LIMIT")).toBeUndefined();
  });

  it("holds every Solidity skill check to an independently enforced owner matrix", async () => {
    const { skills } = await loadSkills({
      repoRoot: process.cwd(),
      extraSkillPaths: [],
      logger: silentLogger(),
      telemetry: nullTelemetry()
    });
    const solidity = skills.find((skill) => skill.id === "lang/solidity");
    expect(solidity).toMatchObject({
      languages: ["solidity"],
      lenses: ["lang/solidity"],
      enabledByDefault: true
    });
    for (const section of ["checks", "falsePositives", "safePatterns", "examples"] as const) {
      expect(solidity?.sections[section]?.trim().length, section).toBeGreaterThan(0);
    }

    const checks = solidity?.sections.checks?.split(/\n(?=\d+\. \*\*)/u) ?? [];
    expect(checks).toHaveLength(9);
    for (const check of checks) {
      const matrix = parseOwnerMatrix(check);
      expect(matrix.failure.length, check).toBeGreaterThan(15);
      expect(matrix.materiality, check).toMatch(/require/iu);
      expect(matrix.materiality, check).toMatch(/severity/iu);
      expect(matrix.unsafe, check).toMatch(/^`[^`]+`/u);
      expect(matrix.safe, check).toMatch(/^`[^`]+`/u);
      expect(matrix.safe, check).not.toBe(matrix.unsafe);
      expect(matrix.mitigation.length, check).toBeGreaterThan(20);
      expect(matrix.mitigation, check).not.toBe(matrix.safe);
      expect(matrix.unsafe, check).not.toContain("...");
      expect(matrix.safe, check).not.toContain("...");
    }
    const repeatedValue = checks.find((check) => check.includes("Repeated full `msg.value`")) ?? "";
    expect(repeatedValue).toContain("function creditAll");
    expect(repeatedValue).toContain("uint256 i");
    expect(repeatedValue).toContain("each * users.length");
    const delegatecall = checks.find((check) => check.includes("Delegatecall storage hazard")) ?? "";
    expect(delegatecall).toContain("contract Proxy");
    expect(delegatecall).toContain("contract Impl");
    expect(delegatecall).toContain("delegatecall");
    expect(delegatecall).toContain("ProxyStorage");
    const delegatecallMatrix = parseOwnerMatrix(delegatecall);
    expect(delegatecallMatrix.safe).toContain("contract Proxy is ProxyStorage");
    expect(delegatecallMatrix.safe).toContain("address immutable impl");
    expect(delegatecallMatrix.safe).toContain("impl.delegatecall(msg.data)");
    expect(delegatecallMatrix.safe).toContain("require(ok)");
    expect(delegatecallMatrix.safe).toContain("contract Impl is ProxyStorage");
    const oracle = checks.find((check) => check.includes("Invalid oracle data")) ?? "";
    expect(oracle).toContain("latestRoundData");
    expect(oracle).toContain("answeredInRound >= roundId");
    expect(oracle).toContain("updatedAt + 1 hours >= block.timestamp");
    const event = checks.find((check) => check.includes("Required event omitted")) ?? "";
    expect(event).toContain("function transferOwnership");
    expect(event).toContain("emit OwnershipTransferred");
    expect(solidity?.sections.falsePositives).toContain("CEI/guards");
    expect(solidity?.sections.falsePositives).toContain("typed reverting calls");
    expect(solidity?.sections.falsePositives).toContain("deliberate permissionless effects");
    expect(solidity?.sections.falsePositives).toContain("documented compatible delegatecall layouts");
    expect(solidity?.sections.falsePositives).toContain("events no external correctness/audit contract requires");

    const ledger = BUNDLED_SKILL_WHY_LEDGER["lang/solidity"];
    expect(ledger?.length).toBeGreaterThanOrEqual(3);
    expect(ledger?.every((entry) => entry.surface.length > 0 && entry.reason.length > 0 && entry.evidence.length > 0)).toBe(true);
  });
});

function parseOwnerMatrix(check: string): Record<"failure" | "materiality" | "unsafe" | "safe" | "mitigation", string> {
  const match = /Failure: (?<failure>.*?) Materiality: (?<materiality>.*?) Unsafe: (?<unsafe>.*?) Safe: (?<safe>.*?) Mitigation: (?<mitigation>.*)$/u.exec(check);
  expect(match?.groups, check).toBeDefined();
  return match!.groups as Record<"failure" | "materiality" | "unsafe" | "safe" | "mitigation", string>;
}

function fixture(fileName: string): string {
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "tree-sitter", "solidity", fileName), "utf8");
}

function silentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function fixtureCandidate(packetId: string): CandidateFinding {
  return {
    id: "solidity-structural-candidate",
    title: "Full vault withdrawal is now permitted",
    severity: "medium",
    confidence: "high",
    path: "contracts/Vault.sol",
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: 'require(amount <= totalAssets, "insufficient")' },
    failureMode: "The withdrawal boundary now permits the entire available balance.",
    whyThisMatters: "The vault withdrawal contract changes.",
    verification: "Compare the old and new withdrawal predicates.",
    producedBy: {
      kind: "packet",
      stage: 7,
      packetId,
      lensId: "lang/solidity",
      skillIds: ["lang/solidity"]
    }
  };
}
