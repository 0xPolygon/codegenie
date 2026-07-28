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
