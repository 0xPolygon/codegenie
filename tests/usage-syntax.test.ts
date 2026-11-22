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
    expect(rows.every(row => row.packageName === "pkg")).toBe(true);
    expect(rows[0]?.bindingEvidence).toMatchObject({ localName: "service", moduleSpecifier: "example.org/service", binding: "unresolved" });
    expect(rows[1]?.bindingEvidence).toBeUndefined();
    expect(rows.every(r => r.enclosing.name === "handler")).toBe(true);
    expect(classifyUsageSyntax(file, "worker.Run")).toEqual([rows[1]]);
  });

  it("exposes imported aliases as lexical evidence without asserting a binding through shadowing", async () => {
    const file = await parse("src/caller.ts", "typescript", 'import { run as invoke } from "./worker";\nfunction caller(invoke: () => void) { invoke(); }\n');
    const rows = classifyUsageSyntax(file, "run")!;
    expect(rows.find(row => row.role === "import" && row.spelling === "run")?.bindingEvidence).toMatchObject({ importedName: "run", localName: "invoke" });
    expect(rows.find(row => row.role === "call")).toMatchObject({ spelling: "invoke", bindingEvidence: {
      importedName: "run", localName: "invoke", moduleSpecifier: "./worker", binding: "unresolved" } });
  });

  it("reports re-export spellings and their source without claiming a resolved binding", async () => {
    const file = await parse("src/barrel.ts", "typescript", 'export { run as execute } from "./worker";\n');
    expect(classifyUsageSyntax(file, "run")).toContainEqual(expect.objectContaining({ role: "re_export",
      bindingEvidence: { kind: "re_export_spelling", importedName: "run", localName: "execute", moduleSpecifier: "./worker", line: 1, binding: "unresolved" } }));
  });

  it("shows namespace import spelling on a member call without asserting its target", async () => {
    const file = await parse("src/caller.ts", "typescript", 'import * as util from "./worker.js";\nfunction caller() { util.run(); }\n');
    expect(classifyUsageSyntax(file, "run")).toContainEqual(expect.objectContaining({ role: "member_call", receiver: "util",
      bindingEvidence: expect.objectContaining({ importedName: "*", localName: "util", moduleSpecifier: "./worker.js", binding: "unresolved" }) }));
  });

  it("reports anonymous callbacks and their nearest named declaration without inventing a name", async () => {
    const file = await parse("src/caller.ts", "typescript", "class Runner { execute() { queue(() => run()); } }\n");
    const row = classifyUsageSyntax(file, "run")![0]!;
    expect(row.enclosing).toMatchObject({ kind: "anonymous", nearestNamed: { name: "Runner.execute" } });
    expect(row.enclosing.name).toBeUndefined();
    expect(row.enclosing.lineRange).toEqual([1, 1]);
  });

  it("keeps the source position of a call after non-ASCII text on the same line", async () => {
    const file = await parse("src/unicode.ts", "typescript", 'const text = "é😀"; run();\n');
    const row = classifyUsageSyntax(file, "run")![0]!;
    expect(row.line).toBe(1);
    expect(row.column).toBe('const text = "é😀"; '.length + 1);
  });

  it("recognizes generic and parenthesized direct calls without treating arguments as calls", async () => {
    const file = await parse("src/generics.ts", "typescript", "run<number>();\n(run)();\nother(run);\n");
    expect(classifyUsageSyntax(file, "run")!.map(row => row.role)).toEqual(["call", "call", "reference"]);
  });

  it("keeps same-named Go receiver methods and interface calls lexical", async () => {
    const file = await parse("pkg/ambiguous.go", "go", ["package pkg", "type A struct{}", "type B struct{}",
      "func (a A) Run() {}", "func (b B) Run() {}", "type Runner interface { Run() }", "type Embedded struct { A }",
      "func call(value Runner, embedded Embedded) { value.Run(); embedded.Run() }"].join("\n"));
    const rows = classifyUsageSyntax(file, "Run")!;
    expect(rows.filter(row => row.role === "declaration")).toHaveLength(3);
    expect(rows.find(row => row.role === "member_call")).toMatchObject({ receiver: "value", packageName: "pkg" });
    expect(rows.filter(row => row.role === "member_call").map(row => row.receiver)).toEqual(["value", "embedded"]);
    expect(rows.every(row => !row.bindingEvidence || row.bindingEvidence.binding === "unresolved")).toBe(true);
  });

  it("does not turn an unsupported or unavailable parse into an empty verified result", async () => {
    const file = await parse("notes.md", "markdown", "run()");
    expect(classifyUsageSyntax(file, "run")).toBeUndefined();
  });
});
