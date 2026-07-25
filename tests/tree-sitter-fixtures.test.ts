import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { renderGoSymbolName } from "../src/repo/tree-sitter/go-adapter.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import type { DiffFile, DiffHunk, FileFacts, RepositoryToolsHost, TelemetryEvent, ToolCallRecord } from "../src/types.js";
import type { LlmCallRecord, TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("parser-derived fixture summaries", () => {
  it("derives Go summaries from fixture source without treating raw parser nodes as product output", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);
    const adapter = registry.forPath("httpbin_client.go");
    const parsed = await parseFixture(registry, "httpbin_client.go", fixture("go/httpbin_client.go"));
    const symbols = adapter.listSymbols(parsed);

    expect(service.routePath("httpbin_client.go")).toBe("go");
    expect(adapter.getImports(parsed)).toEqual(expect.arrayContaining(["context", "encoding/json", "io", "net/http", "net/url"]));
    expect(symbols.find((symbol) => symbol.name === "Doer")?.signature).toContain("Do(req *http.Request) (*http.Response, error)");
    expect(symbols.find((symbol) => symbol.name === "Client")?.signature).toContain("baseURL string");
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Doer", kind: "interface", nativeKind: "interface", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "Client", kind: "type", nativeKind: "struct", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "NewClient", kind: "function", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "GetJSON", kind: "method", ownerType: "Client", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "Status", kind: "method", ownerType: "Client", exported: true, packageName: "httpbin" }),
        expect.objectContaining({
          name: "Version",
          kind: "method",
          ownerType: "Client",
          exported: true,
          signature: expect.stringContaining("func (*Client) Version() string")
        }),
        expect.objectContaining({ name: "newRequest", kind: "method", ownerType: "Client", exported: false, packageName: "httpbin" })
      ])
    );
    const statusSymbol = symbols.find((symbol) => symbol.name === "Status");
    const versionSymbol = symbols.find((symbol) => symbol.name === "Version");
    expect(statusSymbol).toBeDefined();
    expect(versionSymbol).toBeDefined();
    expect(renderGoSymbolName(statusSymbol!)).toBe("(Client).Status");
    expect(renderGoSymbolName(versionSymbol!)).toBe("(*Client).Version");

    const testParsed = await parseFixture(registry, "httpbin_client_test.go", fixture("go/httpbin_client_test.go"));
    const testSymbols = registry.forPath("httpbin_client_test.go").listSymbols(testParsed);
    expect(testSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "TestClientBuildsGetRequest", kind: "function" })]));
  });

  it("derives TypeScript summaries from fixture source without treating raw parser nodes as product output", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);
    const adapter = registry.forPath("src/httpbinClient.ts");
    const parsed = await parseFixture(registry, "src/httpbinClient.ts", fixture("ts/httpbinClient.ts"));
    const symbols = adapter.listSymbols(parsed);

    expect(service.routePath("src/httpbinClient.ts")).toBe("typescript");
    expect(service.routePath("src/httpbinClient.mts")).toBe("typescript");
    expect(service.routePath("src/httpbinClient.cjs")).toBe("javascript");
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "HttpTransport",
          kind: "interface",
          exported: true,
          signature: expect.stringContaining("fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>")
        }),
        expect.objectContaining({
          name: "RequestOptions",
          kind: "type",
          exported: true,
          signature: expect.stringContaining("onRetry?: (attempt: { count: number; status?: number }) => void")
        }),
        expect.objectContaining({
          name: "Decoder",
          kind: "type",
          exported: true,
          signature: expect.stringContaining("shape: { expectJson: boolean; endpoint: string }")
        }),
        expect.objectContaining({ name: "HttpBinClient", kind: "type", nativeKind: "class", exported: true }),
        expect.objectContaining({ name: "RetryClock", kind: "type", nativeKind: "class", exported: true }),
        expect.objectContaining({ name: "default", kind: "function", nativeKind: "arrow function", exported: true }),
        expect.objectContaining({ name: "status", ownerType: "HttpBinEndpoint", kind: "function", exported: true }),
        expect.objectContaining({ name: "anything", ownerType: "HttpBinEndpoint", kind: "function", exported: true }),
        expect.objectContaining({ name: "buildRequest", ownerType: "HttpBinClient", nativeKind: "method", exported: false }),
        expect.objectContaining({ name: "createHeaders", ownerType: "HttpBinClient", nativeKind: "method", exported: false }),
        expect.objectContaining({
          name: "decorateRequest",
          ownerType: "HttpBinClient",
          nativeKind: "class field function",
          exported: true,
          signature: "decorateRequest = (request: Request, metadata: { endpoint: string; attempt: number }) =>"
        })
      ])
    );
    expect(symbols).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "baseUrl", ownerType: "HttpBinClient" })]));
    expect(symbols).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "retryCount", ownerType: "HttpBinClient" })]));

    const testParsed = await parseFixture(registry, "src/httpbinClient.test.ts", fixture("ts/httpbinClient.test.fixture.ts"));
    expect(adapter.getImports(testParsed)).toEqual(expect.arrayContaining(["./httpbinClient.js"]));
    expect(adapter.listSymbols(testParsed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "builds endpoint paths", nativeKind: "test case" }),
        expect.objectContaining({ name: "uses injected transport without network calls", nativeKind: "test case" })
      ])
    );
  });

  it("derives Rust declarations, ownership, attributes, imports, and test symbols from fixtures", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);
    const adapter = registry.forPath("src/payment.rs");
    const parsed = await parseFixture(registry, "src/payment.rs", fixture("rust/payment.rs"));
    const symbols = adapter.listSymbols(parsed);

    expect(adapter.id).toBe("rust");
    expect(parsed).toMatchObject({ language: "rust", adapterId: "rust", hasErrors: false });
    expect(adapter.getImports(parsed)).toEqual([
      "std::{fmt::Debug as StdDebug, sync::*}",
      "anyhow::Result",
      "alloc"
    ]);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Payment", kind: "type", nativeKind: "struct", lineRange: [6, 10] }),
      expect.objectContaining({ name: "PaymentBits", kind: "type", nativeKind: "union" }),
      expect.objectContaining({ name: "PaymentState", kind: "type", nativeKind: "enum" }),
      expect.objectContaining({ name: "PaymentId", kind: "type", nativeKind: "type alias" }),
      expect.objectContaining({ name: "DEFAULT_LIMIT", kind: "value", nativeKind: "constant" }),
      expect.objectContaining({ name: "NEXT_ID", kind: "value", nativeKind: "static" }),
      expect.objectContaining({ name: "Gateway", kind: "interface", nativeKind: "trait" }),
      expect.objectContaining({ name: "Receipt", kind: "type", nativeKind: "associated type", ownerType: "Gateway" }),
      expect.objectContaining({ name: "MAX_RETRIES", kind: "value", nativeKind: "associated constant", ownerType: "Gateway" }),
      expect.objectContaining({ name: "capture", kind: "method", ownerType: "Payment", lineRange: [60, 63] }),
      expect.objectContaining({ name: "payment_id", kind: "other", nativeKind: "macro definition", lineRange: [66, 71] }),
      expect.objectContaining({ name: "audit", kind: "container", nativeKind: "module" }),
      expect.objectContaining({ name: "record", kind: "function", nativeKind: "function" })
    ]));

    const authorizeMethods = symbols.filter((symbol) => symbol.name === "authorize");
    expect(authorizeMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerType: "Gateway", nativeKind: "trait method", lineRange: [26, 30] }),
      expect.objectContaining({ ownerType: "BackupGateway", nativeKind: "trait method", lineRange: [37, 37] }),
      expect.objectContaining({
        ownerType: "Payment",
        nativeKind: "impl method",
        lineRange: [44, 50],
        signature: expect.stringContaining("impl<T> Gateway for Payment<T> :: #[track_caller] fn authorize")
      }),
      expect.objectContaining({
        ownerType: "Payment",
        nativeKind: "impl method",
        lineRange: [54, 56],
        signature: expect.stringContaining("impl<T> BackupGateway for Payment<T> :: fn authorize")
      })
    ]));
    expect(symbols.every((symbol) => symbol.exported === undefined)).toBe(true);
    expect(adapter.getEnclosingSymbol(parsed, 44)).toMatchObject({ name: "authorize", lineRange: [44, 50] });
    expect(adapter.getEnclosingSymbol(parsed, 45)).toMatchObject({ name: "authorize", lineRange: [44, 50] });
    expect(adapter.getEnclosingSymbol(parsed, 49)).toMatchObject({ name: "authorize", lineRange: [44, 50] });
    expect(adapter.getEnclosingSymbol(parsed, 51)).toBeUndefined();

    const hunk: DiffHunk = {
      id: "rust-identity",
      hunkHash: "0000000000000000000000000000000000000000000000000000000000000000",
      path: parsed.path,
      oldStart: 44,
      oldLines: 0,
      newStart: 44,
      newLines: 12,
      header: "",
      lines: [44, 49, 55].map((line) => ({ kind: "add" as const, content: "+", newLineNumber: line }))
    };
    expect(adapter.getChangedSymbols(parsed, hunk)).toEqual([
      expect.objectContaining({ name: "authorize", lineRange: [44, 50], changedLines: [44, 49] }),
      expect.objectContaining({ name: "authorize", lineRange: [54, 56], changedLines: [55] })
    ]);

    const testsParsed = await parseFixture(registry, "src/payment_test.rs", fixture("rust/payment_test.rs"));
    const testSymbols = adapter.listSymbols(testsParsed);
    expect(testSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "authorize_rejects_zero", nativeKind: "test case", lineRange: [3, 7] }),
      expect.objectContaining({ name: "authorize_async", nativeKind: "test case", lineRange: [9, 13] }),
      expect.objectContaining({ name: "helper_is_not_a_test_case", nativeKind: "function", lineRange: [15, 18] })
    ]));
  });

  it("keeps Rust partial output and signatures bounded without enabling deferred inline tests", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/lib.rs");
    const parsed = await adapter.parse({
      path: "src/lib.rs",
      language: "rust",
      source: { kind: "head" },
      content: `#[cfg(test)]\n#[test]\nfn inline_test() {}\n\ntype Long = ${"Result<".repeat(150)}u8${">".repeat(150)};\nfn intact() {}\nfn broken(`
    });
    const symbols = adapter.listSymbols(parsed);

    expect(parsed.hasErrors).toBe(true);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "inline_test", nativeKind: "function" }),
      expect.objectContaining({ name: "intact", nativeKind: "function" })
    ]));
    expect(symbols.find((symbol) => symbol.name === "Long")?.signature?.length).toBeLessThanOrEqual(600);
    expect(symbols.some((symbol) => symbol.nativeKind === "test case")).toBe(false);
  });

  it("retains non-nominal Rust impl methods and prefers inner declarations on shared lines", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/lib.rs");
    const parsed = await adapter.parse({
      path: "src/lib.rs",
      language: "rust",
      source: { kind: "head" },
      content: [
        "trait Inline { fn f(); }",
        "mod nested { fn g() {} }",
        "trait Local { fn tuple(&self); }",
        "trait Marker {}",
        "impl Local for (u8, u8) { fn tuple(&self) {} }",
        "impl Local for [u8; 4] { fn array(&self) {} }",
        "impl Local for [u8] { fn slice(&self) {} }",
        "impl Local for () { fn unit(&self) {} }",
        "impl Local for dyn Marker { fn dynamic(&self) {} }",
        "impl Local for fn(u8) -> u8 { fn function(&self) {} }",
        "impl Local for &Foo { fn reference(&self) {} }",
        "impl Local for <Foo as Other>::Assoc { fn projection(&self) {} }",
        "impl Local for <Foo as Other>::Assoc::Nested { fn nested_projection(&self) {} }",
        "impl<T> Local for T::Assoc { fn generic_projection(&self) {} }",
        "impl Local for Self::Assoc { fn self_projection(&self) {} }",
        "impl Local for module::Concrete { fn nominal_path(&self) {} }",
        "impl Local for ::module::Absolute { fn absolute_path(&self) {} }",
        "impl Local for ::module::Generic<u8> { fn absolute_generic(&self) {} }",
        "impl Local for ::RootAbsolute { fn root_absolute(&self) {} }",
        "impl Local for ::RootGeneric<u8> { fn root_absolute_generic(&self) {} }",
        "impl Local for crate::r#Type<u8> { fn raw_path(&self) {} }",
        "impl Local for r#Raw { fn raw_nominal(&self) {} }",
        "impl Local for crate::東京 { fn unicode_qualified(&self) {} }",
        "impl<T> Local for crate::東京<T> { fn unicode_qualified_generic(&self) {} }",
        "impl Local for ::東京 { fn unicode_root_absolute(&self) {} }",
        "impl<T> Local for ::東京<T> { fn unicode_root_absolute_generic(&self) {} }",
        "impl Local for crate::r#東京 { fn unicode_raw_qualified(&self) {} }",
        "impl<T> Local for crate::r#東京<T> { fn unicode_raw_qualified_generic(&self) {} }"
      ].join("\n")
    });
    const symbols = adapter.listSymbols(parsed);

    expect(parsed.hasErrors).toBe(false);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tuple", kind: "method", ownerType: "(u8, u8)" }),
      expect.objectContaining({ name: "array", kind: "method", ownerType: "[u8; 4]" }),
      expect.objectContaining({ name: "slice", kind: "method", ownerType: "[u8]" }),
      expect.objectContaining({ name: "unit", kind: "method", ownerType: "()" }),
      expect.objectContaining({ name: "dynamic", kind: "method", ownerType: "dyn Marker" }),
      expect.objectContaining({ name: "function", kind: "method", ownerType: "fn(u8) -> u8" }),
      expect.objectContaining({ name: "reference", kind: "method", ownerType: "&Foo" }),
      expect.objectContaining({ name: "projection", kind: "method", ownerType: "<Foo as Other>::Assoc" }),
      expect.objectContaining({
        name: "nested_projection",
        kind: "method",
        ownerType: "<Foo as Other>::Assoc::Nested"
      }),
      expect.objectContaining({ name: "generic_projection", kind: "method", ownerType: "T::Assoc" }),
      expect.objectContaining({ name: "self_projection", kind: "method", ownerType: "Self::Assoc" }),
      expect.objectContaining({ name: "nominal_path", kind: "method", ownerType: "Concrete" }),
      expect.objectContaining({ name: "absolute_path", kind: "method", ownerType: "Absolute" }),
      expect.objectContaining({ name: "absolute_generic", kind: "method", ownerType: "Generic" }),
      expect.objectContaining({ name: "root_absolute", kind: "method", ownerType: "RootAbsolute" }),
      expect.objectContaining({ name: "root_absolute_generic", kind: "method", ownerType: "RootGeneric" }),
      expect.objectContaining({ name: "raw_path", kind: "method", ownerType: "r#Type" }),
      expect.objectContaining({ name: "raw_nominal", kind: "method", ownerType: "r#Raw" }),
      expect.objectContaining({ name: "unicode_qualified", kind: "method", ownerType: "東京" }),
      expect.objectContaining({ name: "unicode_qualified_generic", kind: "method", ownerType: "東京" }),
      expect.objectContaining({ name: "unicode_root_absolute", kind: "method", ownerType: "東京" }),
      expect.objectContaining({ name: "unicode_root_absolute_generic", kind: "method", ownerType: "東京" }),
      expect.objectContaining({ name: "unicode_raw_qualified", kind: "method", ownerType: "r#東京" }),
      expect.objectContaining({ name: "unicode_raw_qualified_generic", kind: "method", ownerType: "r#東京" })
    ]));
    expect(adapter.getEnclosingSymbol(parsed, 1)).toMatchObject({
      name: "f",
      kind: "method",
      ownerType: "Inline"
    });
    expect(adapter.getEnclosingSymbol(parsed, 2)).toMatchObject({ name: "g", kind: "function" });
  });

  it("removes Rust import comment trivia before semantic deduplication", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/lib.rs");
    const parsed = await adapter.parse({
      path: "src/lib.rs",
      language: "rust",
      source: { kind: "head" },
      content: [
        "use crate::{",
        "    alpha, // line comment between use-tree entries",
        "    beta::{self, /* block comment before an entry */ Item},",
        "};",
        "use crate::{alpha, beta::{self, Item}};",
        "use crate::{gamma, /* unique block comment */ delta};",
        "use crate::{gamma, delta,};"
      ].join("\n")
    });

    expect(parsed.hasErrors).toBe(false);
    expect(adapter.getImports(parsed)).toEqual([
      "crate::{alpha, beta::{self, Item},}",
      "crate::{gamma, delta}"
    ]);
    expect(adapter.getImports(parsed).join(" ")).not.toMatch(/comment|\/\*|\/\//u);
  });

  it("keeps Rust outer attributes attached across comment trivia", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("tests/commented.rs");
    const parsed = await adapter.parse({
      path: "tests/commented.rs",
      language: "rust",
      source: { kind: "head" },
      content: [
        "#[test]",
        "// Documents why this test exists.",
        "fn commented_test() {}",
        "#[tokio::test]",
        "/* This comment is also declaration trivia. */",
        "async fn commented_async_test() {}"
      ].join("\n")
    });

    expect(parsed.hasErrors).toBe(false);
    expect(adapter.listSymbols(parsed)).toEqual([
      expect.objectContaining({
        name: "commented_test",
        nativeKind: "test case",
        lineRange: [1, 3],
        signature: "#[test] fn commented_test()"
      }),
      expect.objectContaining({
        name: "commented_async_test",
        nativeKind: "test case",
        lineRange: [4, 6],
        signature: "#[tokio::test] async fn commented_async_test()"
      })
    ]);
  });

  it("extracts local Rust items and resets method ownership inside callable bodies", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/lib.rs");
    const sourceLines = [
      "struct Foo;",
      "impl Foo {",
      "    fn outer(&self) {",
      "        fn local_function() {",
      "            struct LocalType;",
      "            let _local = 1;",
      "        }",
      "        if true {",
      "            type LocalAlias = u8;",
      "            struct Inner;",
      "            impl Inner {",
      "                fn local_method(&self) {",
      "                    let _nested = 2;",
      "                }",
      "            }",
      "        }",
      "    }",
      "}"
    ];
    const parsed = await adapter.parse({
      path: "src/lib.rs",
      language: "rust",
      source: { kind: "head" },
      content: sourceLines.join("\n")
    });
    const symbols = adapter.listSymbols(parsed);

    expect(parsed.hasErrors).toBe(false);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "outer", kind: "method", ownerType: "Foo" }),
      expect.objectContaining({ name: "local_function", kind: "function", nativeKind: "function" }),
      expect.objectContaining({ name: "LocalType", kind: "type", nativeKind: "struct" }),
      expect.objectContaining({ name: "LocalAlias", kind: "type", nativeKind: "type alias" }),
      expect.objectContaining({ name: "Inner", kind: "type", nativeKind: "struct" }),
      expect.objectContaining({ name: "local_method", kind: "method", ownerType: "Inner" })
    ]));
    expect(symbols.find((symbol) => symbol.name === "local_function")?.ownerType).toBeUndefined();
    expect(symbols.find((symbol) => symbol.name === "LocalType")?.ownerType).toBeUndefined();
    expect(adapter.getEnclosingSymbol(parsed, sourceLines.indexOf("            struct LocalType;") + 1)).toMatchObject({
      name: "LocalType"
    });
    expect(adapter.getEnclosingSymbol(parsed, sourceLines.indexOf("            let _local = 1;") + 1)).toMatchObject({
      name: "local_function"
    });
    expect(adapter.getEnclosingSymbol(parsed, sourceLines.indexOf("                    let _nested = 2;") + 1)).toMatchObject({
      name: "local_method",
      ownerType: "Inner"
    });
  });

  it("keeps Rust macro signatures body-free at the first rule boundary", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/lib.rs");
    const parsed = await adapter.parse({
      path: "src/lib.rs",
      language: "rust",
      source: { kind: "head" },
      content: [
        "#[macro_export]",
        "macro_rules! traced {",
        "    // Body trivia must not leak into the signature.",
        "    ($value:expr) => {{ println!(\"{}\", $value); $value }};",
        "    () => { 0 };",
        "}",
        "macro_rules! empty {}"
      ].join("\n")
    });
    const symbols = adapter.listSymbols(parsed);
    const macro = symbols.find((symbol) => symbol.name === "traced");

    expect(parsed.hasErrors).toBe(false);
    expect(macro).toMatchObject({
      kind: "other",
      nativeKind: "macro definition",
      lineRange: [1, 6],
      signature: "#[macro_export] macro_rules! traced {"
    });
    expect(macro?.signature).not.toContain("$value");
    expect(macro?.signature).not.toContain("println!");
    expect(symbols.find((symbol) => symbol.name === "empty")?.signature).toBe("macro_rules! empty {");
  });

  it("derives decorator-aware Python declarations, immediate owners, imports, and test symbols", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/payment.py");
    const parsed = await parseFixture(registry, "src/payment.py", fixture("python/payment.py"));
    const symbols = adapter.listSymbols(parsed);

    expect(adapter.id).toBe("python");
    expect(parsed).toMatchObject({ language: "python", adapterId: "python", hasErrors: false });
    expect(adapter.getImports(parsed)).toEqual([
      "__future__",
      "decimal",
      "asyncio",
      "os.path",
      ".gateways",
      "..shared.money",
      "."
    ]);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "BaseService", kind: "type", nativeKind: "class", lineRange: [11, 12] }),
      expect.objectContaining({
        name: "module_helper",
        kind: "function",
        nativeKind: "function",
        lineRange: [15, 21],
        signature: "def module_helper( value: Decimal, ) -> str:"
      }),
      expect.objectContaining({ name: "local_formatter", kind: "function", lineRange: [18, 19] }),
      expect.objectContaining({
        name: "PaymentService",
        kind: "type",
        nativeKind: "class",
        lineRange: [24, 46],
        signature: "@service_registry.register( \"payments\", ) class PaymentService(BaseService):"
      }),
      expect.objectContaining({
        name: "authorize",
        kind: "method",
        nativeKind: "async method",
        ownerType: "PaymentService",
        lineRange: [28, 41],
        signature: "@staticmethod @audit( \"authorize\", ) async def authorize( self, amount: Decimal, ) -> bool:"
      }),
      expect.objectContaining({ name: "normalized", kind: "function", lineRange: [36, 37] }),
      expect.objectContaining({
        name: "Receipt",
        kind: "type",
        nativeKind: "nested class",
        ownerType: "PaymentService",
        lineRange: [43, 46]
      }),
      expect.objectContaining({ name: "code", kind: "method", ownerType: "Receipt", lineRange: [44, 46] }),
      expect.objectContaining({ name: "CachedService", kind: "type", lineRange: [49, 52] }),
      expect.objectContaining({ name: "read", kind: "method", ownerType: "CachedService", lineRange: [51, 52] })
    ]));
    expect(symbols.every((symbol) => symbol.exported === undefined)).toBe(true);
    expect(symbols.find((symbol) => symbol.name === "local_formatter")?.ownerType).toBeUndefined();
    expect(symbols.find((symbol) => symbol.name === "normalized")?.ownerType).toBeUndefined();

    expect(adapter.getEnclosingSymbol(parsed, 24)).toMatchObject({ name: "PaymentService", lineRange: [24, 46] });
    expect(adapter.getEnclosingSymbol(parsed, 28)).toMatchObject({ name: "authorize", lineRange: [28, 41] });
    expect(adapter.getEnclosingSymbol(parsed, 33)).toMatchObject({ name: "authorize", lineRange: [28, 41] });
    expect(adapter.getEnclosingSymbol(parsed, 36)).toMatchObject({ name: "normalized", lineRange: [36, 37] });
    expect(adapter.getEnclosingSymbol(parsed, 39)).toMatchObject({ name: "authorize", lineRange: [28, 41] });
    expect(adapter.getEnclosingSymbol(parsed, 43)).toMatchObject({ name: "Receipt", lineRange: [43, 46] });
    expect(adapter.getEnclosingSymbol(parsed, 44)).toMatchObject({ name: "code", ownerType: "Receipt" });

    const hunk: DiffHunk = {
      id: "python-identity",
      hunkHash: "0000000000000000000000000000000000000000000000000000000000000000",
      path: parsed.path,
      oldStart: 24,
      oldLines: 0,
      newStart: 24,
      newLines: 23,
      header: "",
      lines: [28, 33, 39, 43].map((line) => ({ kind: "add" as const, content: "+", newLineNumber: line }))
    };
    expect(adapter.getChangedSymbols(parsed, hunk)).toEqual([
      expect.objectContaining({ name: "authorize", lineRange: [28, 41], changedLines: [28, 33, 39] }),
      expect.objectContaining({ name: "Receipt", lineRange: [43, 46], changedLines: [43] })
    ]);

    const testsParsed = await parseFixture(registry, "src/payment_test.py", fixture("python/payment_test.py"));
    expect(adapter.listSymbols(testsParsed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "test_authorize_rejects_zero", kind: "function", nativeKind: "test case", lineRange: [9, 13] }),
      expect.objectContaining({
        name: "test_authorize_accepts_positive",
        kind: "method",
        ownerType: "TestPaymentService",
        nativeKind: "test case",
        lineRange: [17, 19]
      }),
      expect.objectContaining({ name: "test_nested_is_not_collected", nativeKind: "function" }),
      expect.objectContaining({ name: "test_authorize_not_collected", nativeKind: "method", ownerType: "PaymentExamples" })
    ]));
    expect(adapter.listSymbols(testsParsed).find((symbol) => symbol.name === "test_nested_is_not_collected")?.ownerType).toBeUndefined();
  });

  it("keeps Python partial declarations and AST-derived signatures bounded", async () => {
    const registry = new LanguageAdapterRegistry(new TreeSitterService());
    const adapter = registry.forPath("src/partial.py");
    const parameters = Array.from({ length: 140 }, (_value, index) => `value_${String(index)}: int`).join(", ");
    const parsed = await adapter.parse({
      path: "src/partial.py",
      language: "python",
      source: { kind: "head" },
      content: [
        "@decorator",
        `def bounded(${parameters}) -> int:`,
        "    return 1",
        "",
        "def intact() -> bool:",
        "    return True",
        "",
        "def broken("
      ].join("\n")
    });
    const symbols = adapter.listSymbols(parsed);

    expect(parsed.hasErrors).toBe(true);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "bounded", lineRange: [1, 3] }),
      expect.objectContaining({ name: "intact", signature: "def intact() -> bool:" })
    ]));
    expect(symbols.find((symbol) => symbol.name === "bounded")?.signature?.length).toBeLessThanOrEqual(600);
    expect(symbols.find((symbol) => symbol.name === "bounded")?.signature).not.toContain("return 1");
  });

  it("serves parser-derived summaries and source snippets through repository tools", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "httpbin_client.go", fixture("go/httpbin_client.go"));
    writeRepoFile(repo, "httpbin_client_test.go", fixture("go/httpbin_client_test.go"));
    writeRepoFile(repo, "src/httpbinClient.ts", fixture("ts/httpbinClient.ts"));
    writeRepoFile(repo, "src/httpbinClient.test.ts", fixture("ts/httpbinClient.test.fixture.ts"));
    const head = commitAll(repo, "fixtures");
    const { tools } = await buildIndexForRange(repo, head, head);

    const goOutline = await tools.readFileOutline("httpbin_client.go");
    expectNoAstPayload(goOutline);
    expect(goOutline.outline).toMatchObject({
      path: "httpbin_client.go",
      language: "go",
      packageName: "httpbin"
    });
    expect(goOutline.outline.topLevelSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Client", nativeKind: "struct" }),
        expect.objectContaining({ name: "GetJSON", ownerType: "Client", kind: "method" })
      ])
    );

    const goSymbol = await tools.readSymbol("httpbin_client.go", { symbolName: "(*Client).GetJSON" });
    expectNoAstPayload(goSymbol);
    expect(goSymbol.symbol).toMatchObject({ name: "GetJSON", ownerType: "Client", kind: "method" });
    expect(goSymbol.text).toContain("context.Context");

    const unnamedDefinition = await tools.findDefinition("(*Client).Version");
    expectNoAstPayload(unnamedDefinition);
    expect(unnamedDefinition.definitions[0]?.symbol).toMatchObject({ name: "Version", ownerType: "Client", kind: "method" });
    expect(unnamedDefinition.definitions[0]?.text).toContain("func (*Client) Version() string");

    const tsNamespaceSymbol = await tools.readSymbol("src/httpbinClient.ts", { symbolName: "HttpBinEndpoint.status" });
    expectNoAstPayload(tsNamespaceSymbol);
    expect(tsNamespaceSymbol.symbol).toMatchObject({ name: "status", ownerType: "HttpBinEndpoint", kind: "function", exported: true });

    const tsOutline = await tools.readFileOutline("src/httpbinClient.ts");
    expectNoAstPayload(tsOutline);
    expect(tsOutline.outline.topLevelSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "HttpBinClient", nativeKind: "class", exported: true }),
        expect.objectContaining({ name: "default", nativeKind: "arrow function", exported: true })
      ])
    );

    const mentions = await tools.findSymbolMentions("HttpBinClient", { pathGlob: "src/**/*.ts" });
    expectNoAstPayload(mentions);
    expect(mentions.results.map((result) => result.path)).toContain("src/httpbinClient.ts");

    const goTests = await tools.findLikelyTests({ path: "httpbin_client.go" });
    const tsTests = await tools.findLikelyTests({ path: "src/httpbinClient.ts" });
    expectNoAstPayload(goTests);
    expectNoAstPayload(tsTests);
    expect(goTests.tests.map((test) => test.path)).toContain("httpbin_client_test.go");
    expect(tsTests.tests.map((test) => test.path)).toContain("src/httpbinClient.test.ts");
  });

  it("disposes evicted cached parse trees", async () => {
    const service = new TreeSitterService();
    const first = await service.parse({
      path: "cache-0.ts",
      language: "typescript",
      source: { kind: "head" },
      content: "export const value0 = 0;\n"
    });
    expect(first.tree).toBeDefined();
    const tree = first.tree as unknown as { delete: () => void };
    const deleteSpy = vi.spyOn(tree, "delete");

    for (let index = 1; index <= 128; index += 1) {
      await service.parse({
        path: `cache-${index}.ts`,
        language: "typescript",
        source: { kind: "head" },
        content: `export const value${index} = ${index};\n`
      });
    }

    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("builds packet context from fixture diffs as summaries and test references", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "httpbin_client.go", fixture("go/httpbin_client.go"));
    writeRepoFile(repo, "httpbin_client_test.go", fixture("go/httpbin_client_test.go"));
    const base = commitAll(repo, "fixtures");
    writeRepoFile(
      repo,
      "httpbin_client.go",
      fixture("go/httpbin_client.go").replace(
        'req, err := c.newRequest(ctx, http.MethodGet, "/get", query, nil)',
        'req, err := c.newRequest(ctx, http.MethodGet, "/get", query, nil)\n\treq.Header.Set("X-Fixture", "true")'
      )
    );
    const head = commitAll(repo, "change get request");
    const { diff, index, tools } = await buildIndexForRange(repo, base, head);
    const file = diff.files.find((item) => item.path === "httpbin_client.go");
    expect(file).toBeDefined();

    const packetContext = await tools.buildPacketContext(
      file!,
      file!.hunks,
      index.symbolFacts.filter((fact) => fact.path === "httpbin_client.go")
    );

    expectNoAstPayload(packetContext);
    expect(packetContext.context).toMatchObject({
      path: "httpbin_client.go",
      packageName: "httpbin",
      enclosingMethod: expect.objectContaining({ name: "GetJSON", ownerType: "Client" })
    });
    expect(packetContext.outline?.topLevelSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Client" })]));
    expect(packetContext.relevantTests.map((test) => test.path)).toContain("httpbin_client_test.go");
  });

  it("matches enclosing symbol suffixes only on segment boundaries", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "cache.go", [
      "package pkg",
      "",
      "type Cache struct{}",
      "",
      "func loadUserCache() int {",
      "\treturn 1",
      "}"
    ].join("\n"));
    const base = commitAll(repo, "base");
    writeRepoFile(repo, "cache.go", [
      "package pkg",
      "",
      "type Cache struct{}",
      "",
      "func loadUserCache() int {",
      "\treturn 2",
      "}"
    ].join("\n"));
    const head = commitAll(repo, "change cache loader");
    const { diff, tools } = await buildIndexForRange(repo, base, head);
    const file = diff.files.find((item) => item.path === "cache.go");
    expect(file).toBeDefined();

    const packetContext = await tools.buildPacketContext(
      file!,
      file!.hunks,
      [{
        path: "cache.go",
        hunkId: file!.hunks[0]!.id,
        enclosingSymbol: "pkg.loadUserCache",
        symbolKind: "function",
        symbolRange: [5, 7],
        changedLines: [6],
        changedLinesSide: "new",
        source: "tree-sitter",
        confidence: "syntactic"
      }]
    );

    expect(packetContext.context.enclosingFunction?.name).toBe("loadUserCache");
    expect(packetContext.context.enclosingType?.name).not.toBe("Cache");
  });

  it("reports Go exported struct and interface shape changes as API changes", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "api/doer.go",
      `package api

type Doer interface {
	Do(name string) error
}
`
    );
    writeRepoFile(
      repo,
      "api/client.go",
      `package api

type Client struct {
	Timeout int
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "api/doer.go",
      `package api

type Doer interface {
	Do(name string, retry bool) error
}
`
    );
    writeRepoFile(
      repo,
      "api/client.go",
      `package api

type Client struct {
	Timeout int64
}
`
    );
    const head = commitAll(repo, "change go api shape");
    const { index } = await buildIndexForRange(repo, base, head);
    const apiSignals = index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change");

    expect(apiSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "api/doer.go", snippet: expect.stringContaining("Do(name string, retry bool) error") }),
        expect.objectContaining({ path: "api/client.go", snippet: expect.stringContaining("Timeout int64") })
      ])
    );
  });

  it("reports TypeScript exported API changes when balanced type literal shapes change", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `export function decode(input: { id: string; meta: { retry: boolean } }): { ok: boolean } {
  return { ok: input.meta.retry }
}

export type RequestShape = {
  id: string
  meta: { retry: boolean }
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/api.ts",
      `export function decode(input: { id: number; meta: { retry: boolean } }): { ok: boolean } {
  return { ok: input.meta.retry }
}

export type RequestShape = {
  id: number
  meta: { retry: boolean }
}
`
    );
    const head = commitAll(repo, "change api shape");
    const { index } = await buildIndexForRange(repo, base, head);
    const apiSignals = index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/api.ts");

    expect(apiSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snippet: expect.stringContaining("input: { id: number; meta: { retry: boolean } }")
        }),
        expect.objectContaining({
          snippet: expect.stringContaining("id: number")
        })
      ])
    );
  });

  it("marks public class members exported when the class is exported through an export clause", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);
    const symbols = registry
      .forPath("src/api.ts")
      .listSymbols(
        await parseFixture(
          registry,
          "src/api.ts",
          `class Api {
  run(value: string): string {
    return value
  }

  private secret(value: string): string {
    return value
  }
}

export { Api }
`
        )
      );

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Api", exported: true }),
        expect.objectContaining({ name: "run", ownerType: "Api", exported: true }),
        expect.objectContaining({ name: "secret", ownerType: "Api", exported: false })
      ])
    );

    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `class Api {
  run(value: string): string {
    return value
  }
}

export { Api }
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/api.ts",
      `class Api {
  run(value: number): number {
    return value
  }
}

export { Api }
`
    );
    const head = commitAll(repo, "change exported method");
    const { index } = await buildIndexForRange(repo, base, head);

    expect(index.staticSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/api.ts",
          snippet: expect.stringContaining("run(value: number): number")
        })
      ])
    );
  });

  it("searches tracked ignored files without traversing ignored untracked directories", async () => {
    const repo = initRepo();
    writeRepoFile(repo, ".ignore", "ignored*.txt\nignored-dir/\n");
    writeRepoFile(repo, "ignored-tracked.txt", "IgnoredTrackedFixtureNeedle\n");
    writeRepoFile(repo, "src/app.ts", "export const visible = 'VisibleFixtureNeedle'\n");
    git(repo, ["add", "-f", "ignored-tracked.txt"]);
    const head = commitAll(repo, "base");
    writeRepoFile(repo, "ignored-untracked.txt", "IgnoredDirtyFixtureNeedle\n");
    writeFixtureFile(repo, "ignored-dir/secret.txt", "IgnoredDirectoryFixtureNeedle\n");
    const { tools } = await buildIndexForRange(repo, head, head);

    expect((await tools.searchFiles("VisibleFixtureNeedle")).results.map((result) => result.path)).toContain("src/app.ts");
    expect((await tools.searchFiles("IgnoredTrackedFixtureNeedle")).results.map((result) => result.path)).toContain("ignored-tracked.txt");
    expect((await tools.searchFiles("IgnoredDirtyFixtureNeedle")).results).toEqual([]);
    expect((await tools.searchFiles("IgnoredDirectoryFixtureNeedle")).results).toEqual([]);
  });
});

function fixture(relPath: string): string {
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "tree-sitter", relPath), "utf8");
}

async function parseFixture(registry: LanguageAdapterRegistry, filePath: string, content: string) {
  const adapter = registry.forPath(filePath);
  return adapter.parse({
    path: filePath,
    language: registry.languageForPath(filePath),
    content,
    source: { kind: "head" },
    contentSha: `fixture:${filePath}`
  });
}

async function buildIndexForRange(
  repo: string,
  base: string,
  head: string
): Promise<{
  diff: ReturnType<typeof parseDiff>;
  index: Awaited<ReturnType<typeof buildRepositoryIndex>>;
  tools: RepositoryToolsHost;
  telemetry: TelemetryRecorder & { events: TelemetryEvent[]; toolCalls: ToolCallRecord[] };
}> {
  const telemetry = recordingTelemetry();
  const rawDiff = git(repo, ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", base, head]);
  const diff = parseDiff(rawDiff);
  const index = await buildRepositoryIndex(
    {
      mode: "commit_range",
      repoRoot: repo,
      startCommit: base,
      endCommit: head,
      mergeBase: base,
      headSha: head,
      commits: [],
      rawDiff
    },
    diff.files,
    diff.files.map((file) => fileFacts(file)),
    defaultConfig,
    telemetry
  );
  return { diff, index, tools: index.tools as RepositoryToolsHost, telemetry };
}

function fileFacts(file: DiffFile): FileFacts {
  return {
    path: file.path,
    language: file.language,
    processingMode: "per-hunk",
    testStatus: file.path.endsWith("_test.go") || /\.(?:test|spec)\.[cm]?[tj]sx?$/u.test(file.path) ? "test" : "source",
    isGenerated: false,
    isVendored: false,
    isLockfile: false,
    isBinary: false,
    changedLines: file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add" || line.kind === "delete")).length,
    hunkCount: file.hunks.length,
    labels: [],
    reviewPriority: "normal",
    reasons: [],
    provenance: []
  };
}

function writeFixtureFile(repo: string, relPath: string, content: string): void {
  const fullPath = path.join(repo, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function expectNoAstPayload(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(/"(?:tree|rootNode|node|children)"\s*:/u);
}

function recordingTelemetry(): TelemetryRecorder & { events: TelemetryEvent[]; toolCalls: ToolCallRecord[] } {
  const events: TelemetryEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  return {
    runId: "tree-sitter-fixture-test",
    runDir: undefined,
    events,
    toolCalls,
    event: (event) => {
      events.push({
        ...event,
        runId: "tree-sitter-fixture-test",
        eventId: `ev-${events.length}`,
        timestamp: new Date(0).toISOString()
      });
    },
    recordModelCall: (_record: Omit<LlmCallRecord, "runId">) => undefined,
    recordToolCall: (record) => {
      const id = `tc-${toolCalls.length}`;
      toolCalls.push({
        ...record,
        toolCallId: id,
        runId: "tree-sitter-fixture-test",
        timestamp: new Date(0).toISOString()
      });
      return id;
    },
    writeArtifact: async () => undefined,
    writeDebug: async () => undefined,
    flush: async () => undefined
  };
}
