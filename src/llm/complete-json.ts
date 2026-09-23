// JSON.parse validates the entire document. The second pass rejects duplicate
// keys (including escaped spellings), which JSON.parse would silently overwrite.
export function parseCompleteJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/gu;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (text.slice(match.index + token.length).trimStart().startsWith(":")) {
      const keys = stack.at(-1);
      const key = JSON.parse(token) as string;
      if (keys?.has(key)) throw new SyntaxError("Duplicate JSON key");
      keys?.add(key);
    }
  }
  return value;
}
