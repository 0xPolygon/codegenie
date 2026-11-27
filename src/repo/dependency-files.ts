import { constants } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { CodegenieError } from "../util/errors.js";

export function withinDependencyRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

export async function dependencyRealpath(root: string, path: string): Promise<string> {
  const physical = await realpath(path);
  if (!withinDependencyRoot(root, physical)) {
    throw new CodegenieError("path_outside_module", "Dependency path resolves outside its expected root.");
  }
  return physical;
}

export async function withDependencyFile<T>(
  root: string, path: string, read: (file: FileHandle, size: number) => Promise<T>
): Promise<T> {
  const physical = await dependencyRealpath(root, path);
  const file = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new CodegenieError("binary_or_too_large", "Dependency source must be a regular file.");
    const current = await stat(await dependencyRealpath(root, physical));
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new CodegenieError("path_outside_module", "Dependency file changed while it was opened.");
    }
    return await read(file, opened.size);
  } finally {
    await file.close();
  }
}

export async function readDependencyBytes(file: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > limit) throw new CodegenieError("binary_or_too_large", "Dependency file exceeded its byte limit.");
  return buffer.subarray(0, offset);
}

export async function* dependencyPaths(root: string, prefix = ""): AsyncGenerator<string> {
  const directory = prefix ? await dependencyRealpath(root, join(root, prefix)) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const entry of entries) {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) yield* dependencyPaths(root, path);
    else yield path;
  }
}
