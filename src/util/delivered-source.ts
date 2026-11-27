import type { DeliveredSourceRange } from "../types.js";

/** Group only complete, adjacent source lines on the same file and revision. */
export function mergeDeliveredRanges(ranges: readonly DeliveredSourceRange[]): DeliveredSourceRange[] {
  const files = new Map<string, DeliveredSourceRange[]>();
  for (const range of ranges) {
    const key = JSON.stringify([range.path, range.side]);
    const group = files.get(key);
    if (group) group.push(range);
    else files.set(key, [range]);
  }
  return [...files.values()].flatMap(group => {
    const merged: DeliveredSourceRange[] = [];
    for (const range of group.sort((a, b) => a.lineRange[0] - b.lineRange[0])) {
      const previous = merged.at(-1);
      if (previous && range.lineRange[0] <= previous.lineRange[1] + 1) {
        previous.lineRange[1] = Math.max(previous.lineRange[1], range.lineRange[1]);
      } else {
        merged.push({ ...range, lineRange: [...range.lineRange] });
      }
    }
    return merged;
  });
}

export function diffRowRanges(path: string, oldPath: string | undefined, oldLine?: number, newLine?: number): DeliveredSourceRange[] {
  const ranges: DeliveredSourceRange[] = [];
  if (oldLine !== undefined) ranges.push({ path: oldPath ?? path, side: "base", lineRange: [oldLine, oldLine] });
  if (newLine !== undefined) ranges.push({ path, side: "head", lineRange: [newLine, newLine] });
  return ranges;
}
