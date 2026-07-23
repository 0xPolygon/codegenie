import type {
  ChangedSymbol,
  DiffHunk,
  LanguageAdapter,
  ParseInput,
  ParsedFile,
  SymbolInfo
} from "../../types.js";
import { importLikeScan } from "../language-adapter.js";
import { TreeSitterService, type GrammarId } from "./tree-sitter-service.js";

/**
 * Shared registration seam for grammars whose semantic adapters land in a
 * later vertical slice. It proves parsing and canonical routing without
 * pretending that generic node kinds satisfy the SymbolInfo contract.
 */
export class GrammarAdapter implements LanguageAdapter {
  constructor(
    private readonly service: TreeSitterService,
    readonly id: Extract<GrammarId, "rust" | "python" | "solidity">,
    readonly extensions: string[]
  ) {}

  async init(): Promise<void> {
    return undefined;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    return this.service.parse({ ...input, language: this.id });
  }

  listSymbols(): SymbolInfo[] {
    return [];
  }

  getEnclosingSymbol(): SymbolInfo | undefined {
    return undefined;
  }

  getImports(file: ParsedFile): string[] {
    return importLikeScan(file.content);
  }

  getChangedSymbols(_file: ParsedFile, _hunk: DiffHunk): ChangedSymbol[] {
    return [];
  }
}
