import { describe, expect, it } from "vitest";
import { changedModuleBinding } from "../src/pipeline/module-binding-change.js";
import type { DiffHunk, DiffLine } from "../src/types.js";

function hunk(rows: string[]): DiffHunk {
  const lines: DiffLine[] = rows.map(row => ({
    kind: row[0] === "+" ? "add" : row[0] === "-" ? "delete" : "context",
    content: row.slice(1)
  }));
  return { id: "h1", hunkHash: "h1", path: "module", header: "@@", oldStart: 1, newStart: 1,
    oldLines: lines.filter(line => line.kind !== "add").length,
    newLines: lines.filter(line => line.kind !== "delete").length, lines };
}

describe("module binding changes in diff rows", () => {
  it.each([
    { language: "typescript", rows: ['-import { one, two } from "./values";', '+import { one } from "./values";'], rule: "ecma_import" },
    { language: "tsx", rows: ['+import type { Shape } from "./render";'], rule: "ecma_import" },
    { language: "javascript", rows: ['+import "./polyfill.js";'], rule: "ecma_import" },
    { language: "typescript", rows: ['+import value = require("./values");'], rule: "ecma_import" },
    { language: "typescript", rows: ['-export { oldName };', '+export { newName };'], rule: "ecma_export" },
    { language: "javascript", rows: ['+export * as client from "./client";'], rule: "ecma_export" },
    { language: "typescript", rows: [' export {', '-  original,', '+  next as renamed,', ' } from "./values";'], rule: "ecma_export" },
    { language: "go", rows: ['-import prior "example.org/service"', '+import updated "example.org/service"'], rule: "go_import" },
    { language: "go", rows: [' import (', '-  "fmt"', '   "io"', ' )'], rule: "go_import" },
    { language: "go", rows: ['   "fmt"', '+  "io"', ' )'], rule: "go_import" },
    { language: "go", rows: ['   "fmt"', '   // driver registration', '+  _ "example.org/driver"', '   "io"'], rule: "go_import" },
    { language: "go", rows: ['   "fmt"', '-  prior "example.org/driver"', '+  next "example.org/driver"'], rule: "go_import" },
    { language: "go", rows: ['   first "example.org/first"', '+  next "example.org/second"', ' )'], rule: "go_import" },
    { language: "python", rows: ['-from .database import prepare', '+from .database import prepare as start'], rule: "python_import" }
  ])("recognizes $rule in $language", ({ language, rows, rule }) => {
    expect(changedModuleBinding([hunk(rows)], language)).toEqual({ hunkId: "h1", rule });
  });

  it.each([
    { language: "typescript", rows: ['+import("./values");', '+require("./polyfill");', '+// import "./fake";'] },
    { language: "typescript", rows: [' /*', '+ import "./not-code";', ' */'] },
    { language: "typescript", rows: ["-import { one } from './values';", '+import {', '+  one,', '+} from "./values" // style'] },
    { language: "go", rows: ['-import "fmt"', '+import (', '+ "fmt"', '+)'] },
    { language: "go", rows: ['+  "looks/like/a/path"'] },
    { language: "go", rows: ['   "first",', '-  "second",', '+  "third",'] },
    { language: "go", rows: ['   Embedded "first"', '-  Feature "second"', '+  Feature "third"', ' }'] },
    { language: "go", rows: ['   "fmt"', '+  // adjacent comment', '   "io"'] },
    { language: "python", rows: ['+# from .database import prepare', '+'] }
  ])("keeps unrelated and formatting-only $language changes outside the rule", ({ language, rows }) => {
    expect(changedModuleBinding([hunk(rows)], language)).toBeUndefined();
  });
});
