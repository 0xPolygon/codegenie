/** Wrap text in a GitHub-flavored Markdown inline code span, using a backtick
 * fence longer than any run inside the text so embedded backticks render. */
export function inlineCode(text: string): string {
  if (text.length === 0) {
    return "``";
  }
  const longestRun = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Wrap code in a fenced Markdown code block, using a fence longer than any
 * backtick run inside the code so embedded fences render. */
export function codeBlock(code: string, lang = ""): string {
  const longestRun = Math.max(2, ...(code.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${lang}\n${code}\n${fence}`;
}

const FENCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  go: "go",
  py: "python",
  rs: "rust",
  sol: "solidity",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  md: "md",
  vue: "vue",
  proto: "proto",
  tf: "hcl"
};

/** GitHub fence info-string for a file path's extension; empty when unknown. */
export function fenceLanguageForPath(filePath: string): string {
  const extension = /\.([^.\\/]+)$/u.exec(filePath)?.[1]?.toLowerCase() ?? "";
  return FENCE_LANGUAGE_BY_EXTENSION[extension] ?? "";
}
