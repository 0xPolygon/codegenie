import { rmSync } from "node:fs";
import { createGitClient } from "../../src/git/git-client.js";
import { assertRepositoryToolArguments, buildRepositoryToolDefinitions } from "../../src/llm/tool-definitions.js";
import { LanguageAdapterRegistry } from "../../src/repo/language-adapter.js";
import { RepositoryToolsFacade } from "../../src/repo/repository-index.js";
import { SourceResolver } from "../../src/repo/source-resolver.js";
import { TreeSitterService } from "../../src/repo/tree-sitter/tree-sitter-service.js";
import { commitAll, initRepo, nullTelemetry, writeRepoFile } from "./git.js";
import { validateToolCall } from "./pi-validation.js";

/** Real committed snapshots, real Git grep and production tool schemas; no model. */
export async function textRepository(baseFiles: Record<string, string>, headChanges: Record<string, string> = {}) {
  const repo = initRepo();
  for (const [path, text] of Object.entries(baseFiles)) writeRepoFile(repo, path, text);
  const base = commitAll(repo, "base");
  for (const [path, text] of Object.entries(headChanges)) writeRepoFile(repo, path, text);
  const head = Object.keys(headChanges).length ? commitAll(repo, "head") : base;
  const resolver = await SourceResolver.create({ mode: "commit_range", repoRoot: repo, startCommit: base,
    endCommit: head, mergeBase: base, headSha: head, commits: [], rawDiff: "" }, createGitClient(repo));
  const tools = new RepositoryToolsFacade({ resolver, diff: { files: [] },
    registry: new LanguageAdapterRegistry(new TreeSitterService()), telemetry: nullTelemetry() });
  const definitions = buildRepositoryToolDefinitions(tools);
  return { repo, tools, definitions, dispose: () => rmSync(repo, { recursive: true, force: true }),
    async call(name: string, args: Record<string, unknown>) {
      const tool = definitions.find(tool => tool.name === name);
      if (!tool) throw new Error(`Unknown fixture tool ${name}`);
      assertRepositoryToolArguments(tool, args);
      const validated = validateToolCall(definitions, { type: "toolCall", id: "synthetic", name, arguments: args });
      return tool.execute(validated as Record<string, unknown>, new AbortController().signal);
    }
  };
}
