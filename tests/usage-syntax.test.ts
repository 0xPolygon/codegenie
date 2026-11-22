import { describe, expect, it } from "vitest";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { classifyUsageSyntax } from "../src/repo/usage-syntax.js";

const parser = new TreeSitterService();
async function parse(path: string, language: string, content: string) {
  return parser.parse({ path, language, content, source: { kind: "head" } });
}

describe("usage syntax", () => {
  it("distinguishes TypeScript imports, direct calls, member calls and references", async () => {
    const file = await parse("src/caller.ts", "typescript", [
      'import { run } from "./worker";',
      'export function caller() {',
      '  run();',
      '  object.run();',
      '  const saved = run;',
      '  const callback = () => run();',
      '}',
      '// run() is only a comment',
      'const text = "run()";'
    ].join("\n"));
    const rows = classifyUsageSyntax(file, "run")!;
    expect(rows.map(r => r.role)).toEqual(["import", "call", "member_call", "reference", "call"]);
    expect(rows[2]).toMatchObject({ line: 4, spelling: "object.run", receiver: "object", enclosing: { name: "caller", lineRange: [2, 7] } });
    expect(rows[4]?.enclosing).toMatchObject({ name: "callback", kind: "declaration" });
    expect(classifyUsageSyntax(file, "object.run")).toEqual([rows[2]]);
  });

  it("identifies Go package selectors and direct calls without claiming receiver types", async () => {
    const file = await parse("pkg/handler.go", "go", [
      'package pkg',
      'import service "example.org/service"',
      'func handler() {',
      '  service.Run()',
      '  worker.Run()',
      '  Run()',
      '}'
    ].join("\n"));
    const rows = classifyUsageSyntax(file, "Run")!;
    expect(rows.map(r => r.role)).toEqual(["member_call", "member_call", "call"]);
    expect(rows.map(r => r.receiver)).toEqual(["service", "worker", undefined]);
    expect(rows[0]?.bindingEvidence).toMatchObject({ localName: "service", moduleSpecifier: "example.org/service", binding: "unresolved" });
    expect(rows[1]?.bindingEvidence).toBeUndefined();
    expect(rows.every(r => r.enclosing.name === "handler")).toBe(true);
    expect(classifyUsageSyntax(file, "worker.Run")).toEqual([rows[1]]);
  });

  it("exposes imported aliases as lexical evidence without asserting a binding through shadowing", async () => {
    const file = await parse("src/caller.ts", "typescript", 'import { run as invoke } from "./worker";\nfunction caller(invoke: () => void) { invoke(); }\n');
    const rows = classifyUsageSyntax(file, "run")!;
    expect(rows.find(row => row.role === "call")).toMatchObject({ spelling: "invoke", bindingEvidence: {
      importedName: "run", localName: "invoke", moduleSpecifier: "./worker", binding: "unresolved" } });
  });

  it("reports re-export spellings and their source without claiming a resolved binding", async () => {
    const file = await parse("src/barrel.ts", "typescript", 'export { run as execute } from "./worker";\n');
    expect(classifyUsageSyntax(file, "run")).toContainEqual(expect.objectContaining({ role: "re_export",
      bindingEvidence: { kind: "re_export_spelling", importedName: "run", localName: "execute", moduleSpecifier: "./worker", line: 1, binding: "unresolved" } }));
  });

  it("reports anonymous callbacks and their nearest named declaration without inventing a name", async () => {
    const file = await parse("src/caller.ts", "typescript", "class Runner { execute() { queue(() => run()); } }\n");
    const row = classifyUsageSyntax(file, "run")![0]!;
    expect(row.enclosing).toMatchObject({ kind: "anonymous", nearestNamed: { name: "Runner.execute" } });
    expect(row.enclosing.name).toBeUndefined();
    expect(row.enclosing.lineRange).toEqual([1, 1]);
  });

  it("does not turn an unsupported or unavailable parse into an empty verified result", async () => {
    const file = await parse("notes.md", "markdown", "run()");
    expect(classifyUsageSyntax(file, "run")).toBeUndefined();
  });
});
