// Status-comment marker: a sibling of the findings fingerprint marker
// (src/github/duplicate-detector.ts), never a change to it. The status
// comment is the one explicitly-mutable comment class (plan 97); the marker
// is how reruns find and reclaim it. Appended after sanitization — the
// sanitizer strips HTML comments, so ordering is load-bearing.
export const STATUS_COMMENT_MARKER = "<!-- codegenie:status-comment -->";

const STATUS_COMMENT_MARKER_PATTERN = /<!--\s*codegenie:status-comment\s*-->/u;

export function hasStatusCommentMarker(body: string): boolean {
  return STATUS_COMMENT_MARKER_PATTERN.test(body);
}

export function appendStatusCommentMarker(body: string): string {
  return `${body.trimEnd()}\n\n${STATUS_COMMENT_MARKER}\n`;
}
