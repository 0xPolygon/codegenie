import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { GRAMMAR_WASM } from "../dist/repo/tree-sitter/tree-sitter-service.js";

// codegenie parses through web-tree-sitter, so the only thing it needs from the
// tree-sitter-* grammar packages is their published WASM. Every one of those
// packages is a native-build package (`install: node-gyp-build`), and
// tree-sitter-solidity additionally misspells its optional-peer key as
// `tree_sitter` — which makes npm treat native tree-sitter as a *required* peer,
// install it, and compile it from source. Copying the WASM at build time keeps
// the grammar packages as devDependencies, so an installed codegenie has no
// native dependency and no install script for a consumer to run.
const require = createRequire(import.meta.url);
const root = process.cwd();
const outputDirectory = path.join(root, "bundled-grammars");

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const copied = [];
for (const { package: packageName, file } of Object.values(GRAMMAR_WASM)) {
  const destination = path.join(outputDirectory, file);
  if (copied.includes(file)) {
    continue;
  }
  copyFileSync(require.resolve(`${packageName}/${file}`), destination);
  copied.push(file);
}

console.log(`Bundled ${copied.length} grammars: ${copied.join(", ")}`);
