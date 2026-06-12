import type {
  ChangedSymbol,
  DiffHunk,
  LanguageAdapter,
  ParseInput,
  ParsedFile,
  SymbolInfo
} from "../../types.js";
import { importLikeScan } from "../language-adapter.js";

export class GenericAdapter implements LanguageAdapter {
  readonly id = "generic";
  readonly extensions: string[] = [];

  async init(): Promise<void> {
    return undefined;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    return {
      path: input.path,
      language: input.language,
      adapterId: this.id,
      source: input.source,
      content: input.content,
      ...(input.contentSha !== undefined ? { contentSha: input.contentSha } : {}),
      hasErrors: false
    };
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
