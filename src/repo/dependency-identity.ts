import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, posix, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { CodegenieError } from "../util/errors.js";
import { dependencyRealpath, readDependencyBytes, withDependencyFile } from "./dependency-files.js";
import type { SourceResolver } from "./source-resolver.js";

export type DependencyIdentity = {
  root: string;
  location: string;
  version: string;
  lockfile: string;
  lockEntry: string;
  integrity: string;
  identity: "lockfile-matched; bytes as installed" | "go.sum verified";
  fileHashes?: Map<string, string>;
};

type RecordValue = Record<string, unknown>;
const lockGroups = ["dependencies", "devDependencies", "optionalDependencies"];
const metadataLimit = 20_000_000;
const manifestLimit = 2_000_000;
const GO_IDENTITY_MAX_ENTRIES = 5_000;
const GO_IDENTITY_MAX_BYTES = 20_000_000;

const asRecord = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const field = (value: unknown, key: string): unknown => {
  const object = asRecord(value);
  return object && Object.hasOwn(object, key) ? object[key] : undefined;
};

export function dependencyUnavailable(reason: string): never {
  throw new CodegenieError("dependency_unavailable", reason);
}

async function installedJson(root: string, path: string, limit: number): Promise<unknown> {
  return JSON.parse(await installedText(root, path, limit, "Installed package record is missing or unreadable."));
}

async function installedText(root: string, path: string, limit: number, missing: string): Promise<string> {
  try {
    return await withDependencyFile(root, path, async (file, size) => {
      if (size > limit) dependencyUnavailable("Installed package record exceeds the metadata limit.");
      return (await readDependencyBytes(file, limit)).toString("utf8");
    });
  } catch (error) {
    if (error instanceof CodegenieError) throw error;
    dependencyUnavailable(missing);
  }
}

function parentPaths(path: string): string[] {
  const parents: string[] = [];
  for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
    parents.push(dir);
    if (dir === ".") return parents;
  }
}

function pnpmImporterEntry(lock: unknown, importer: string, module: string): unknown {
  const entry = field(field(lock, "importers"), importer);
  for (const group of lockGroups) {
    const dependency = field(field(entry, group), module);
    if (dependency !== undefined) return dependency;
  }
  return undefined;
}

export class NodeDependencyIdentity {
  private readonly packageManifests = new Map<string, Promise<unknown>>();
  private readonly localRecords = new Map<string, Promise<unknown>>();

  constructor(
    private readonly resolver: SourceResolver,
    private readonly repoRoot: string,
    private readonly paths: ReadonlySet<string>
  ) {}

  async resolve(importer: string, module: string): Promise<DependencyIdentity> {
    const parents = parentPaths(importer);
    const owner = parents.find(dir => this.paths.has(posix.join(dir, "package.json")));
    if (owner === undefined) dependencyUnavailable("No tracked package.json owns this importer.");
    const rootManifest = this.paths.has("package.json") ? await this.packageManifest(".") : undefined;
    const manifest = owner === "." ? rootManifest : await this.packageManifest(owner);
    const manager = field(manifest, "packageManager") ?? field(rootManifest, "packageManager");
    if (typeof manager === "string" && !/^(?:pnpm|npm)@/u.test(manager)) {
      dependencyUnavailable("Only installed npm or pnpm dependencies are supported.");
    }
    if (this.paths.has("pnpm-lock.yaml") && !(typeof manager === "string" && manager.startsWith("npm@"))) {
      return this.resolvePnpm(owner, module);
    }
    if (this.paths.has("package-lock.json") && !(typeof manager === "string" && manager.startsWith("pnpm@"))) {
      return this.resolveNpm(parents, module);
    }
    return dependencyUnavailable("No supported tracked npm or pnpm lockfile.");
  }

  private packageManifest(dir: string): Promise<unknown> {
    let pending = this.packageManifests.get(dir);
    if (!pending) {
      pending = this.tracked(posix.join(dir, "package.json"), JSON.parse);
      this.packageManifests.set(dir, pending);
    }
    return pending;
  }

  private async tracked(path: string, parseRecord: (text: string) => unknown): Promise<unknown> {
    const file = await this.resolver.readFile(path, { kind: "head" });
    if (!file) dependencyUnavailable("Tracked dependency record is missing.");
    return parseRecord(file.content);
  }

  private record(name: string, read: () => Promise<unknown>): Promise<unknown> {
    let pending = this.localRecords.get(name);
    if (!pending) {
      pending = read();
      this.localRecords.set(name, pending);
    }
    return pending;
  }

  private async resolvePnpm(importer: string, module: string): Promise<DependencyIdentity> {
    const lockfile = "pnpm-lock.yaml";
    const expected = await this.record(lockfile, () => this.tracked(lockfile, parse));
    const lockVersion = field(expected, "lockfileVersion");
    if (lockVersion !== 9 && lockVersion !== "9.0" && lockVersion !== "9") {
      dependencyUnavailable("Only pnpm lockfile v9 is supported.");
    }
    const importerEntry = pnpmImporterEntry(expected, importer, module);
    const versionSpec = field(importerEntry, "version");
    const version = typeof versionSpec === "string" ? versionSpec.split("(", 1)[0] : undefined;
    if (!version || !/^[0-9][0-9A-Za-z.+-]*$/u.test(version)) {
      dependencyUnavailable("No versioned pnpm lock entry for this importer and module.");
    }
    const packageKey = `${module}@${version}`;
    const packageEntry = field(field(expected, "packages"), packageKey);
    const integrity = field(field(packageEntry, "resolution"), "integrity");
    if (typeof integrity !== "string" || !integrity) dependencyUnavailable("The pnpm package is missing its integrity.");
    const installedName = "node_modules/.pnpm/lock.yaml";
    const installed = await this.record(installedName, async () => parse(await installedText(
      this.repoRoot, join(this.repoRoot, installedName), metadataLimit, "pnpm installed lock record is missing or unreadable."
    )));
    if (
      !isDeepStrictEqual(pnpmImporterEntry(installed, importer, module), importerEntry) ||
      !isDeepStrictEqual(field(field(installed, "packages"), packageKey), packageEntry)
    ) dependencyUnavailable("The pnpm installed record differs from the tracked importer or package.");
    const physical = await dependencyRealpath(join(this.repoRoot, "node_modules", ".pnpm"),
      join(this.repoRoot, importer, "node_modules", module));
    return this.verifyManifest(module, physical, version, lockfile, `importers[${importer}], packages[${packageKey}]`, integrity);
  }

  private async resolveNpm(parents: string[], module: string): Promise<DependencyIdentity> {
    const lockfile = "package-lock.json";
    const expected = await this.record(lockfile, () => this.tracked(lockfile, JSON.parse));
    const lockVersion = field(expected, "lockfileVersion");
    if (lockVersion !== 2 && lockVersion !== 3) dependencyUnavailable("Only npm lockfile v2 and v3 are supported.");
    for (const dir of parents) {
      const key = posix.join(dir, "node_modules", module);
      const candidate = join(this.repoRoot, key);
      if (!await pathExists(candidate)) continue;
      const physical = await dependencyRealpath(join(this.repoRoot, dir, "node_modules"), candidate);
      const entry = field(field(expected, "packages"), key);
      const version = field(entry, "version");
      const integrity = field(entry, "integrity");
      if (typeof version !== "string" || typeof integrity !== "string" || !version || !integrity) {
        dependencyUnavailable("The nearest installed npm copy has no version and integrity in the tracked lockfile.");
      }
      const installedName = "node_modules/.package-lock.json";
      const installed = await this.record(installedName, () =>
        installedJson(this.repoRoot, join(this.repoRoot, installedName), metadataLimit));
      const actual = field(field(installed, "packages"), key);
      if (field(actual, "version") !== version || field(actual, "integrity") !== integrity) {
        dependencyUnavailable("The nearest installed npm copy does not match its tracked lock entry.");
      }
      return this.verifyManifest(module, physical, version, lockfile, `packages[${key}]`, integrity);
    }
    return dependencyUnavailable("No installed copy found for this npm importer.");
  }

  private async verifyManifest(module: string, root: string, version: string, lockfile: string, lockEntry: string, integrity: string): Promise<DependencyIdentity> {
    const pkg = await installedJson(root, join(root, "package.json"), manifestLimit);
    if (field(pkg, "name") !== module || field(pkg, "version") !== version) {
      dependencyUnavailable("The installed package name or version does not match its lock entry.");
    }
    return { root, location: relative(this.repoRoot, root).split(sep).join("/"), version, lockfile, lockEntry, integrity,
      identity: "lockfile-matched; bytes as installed" };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export type GoDependencies = { requires: Map<string, string>; replaces: Map<string, Set<string>> };

export function goDependencies(content: string): GoDependencies {
  const requires = new Map<string, string>();
  const replaces = new Map<string, Set<string>>();
  let block: "require" | "replace" | undefined;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.split("//", 1)[0]!.trim();
    if (!line) continue;
    if (line === ")") { block = undefined; continue; }
    const [directive, rest] = block ? [block, line] : /^(require|replace)\s+(.+)$/u.exec(line)?.slice(1) ?? [];
    if (!rest || (directive !== "require" && directive !== "replace")) continue;
    if (rest === "(") { block = directive; continue; }
    const [name, value] = rest.match(/"[^"]+"|\S+/gu) ?? [];
    if (!name || !value) continue;
    const module = name.replace(/^"|"$/gu, "");
    const version = value.replace(/^"|"$/gu, "");
    if (directive === "require") requires.set(module, version);
    else {
      const versions = replaces.get(module) ?? new Set<string>();
      versions.add(version === "=>" ? "*" : version);
      replaces.set(module, versions);
    }
  }
  return { requires, replaces };
}

function goEscape(value: string): string {
  return value.replace(/[A-Z]/gu, letter => "!" + letter.toLowerCase());
}

async function hashGoTree(root: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const directories = [""];
  let entries = 0;
  let remaining = GO_IDENTITY_MAX_BYTES;
  while (directories.length > 0) {
    signal?.throwIfAborted();
    const dir = directories.pop()!;
    const physical = dir ? await dependencyRealpath(root, join(root, dir)) : root;
    for await (const entry of await opendir(physical)) {
      signal?.throwIfAborted();
      if (++entries > GO_IDENTITY_MAX_ENTRIES) dependencyUnavailable("Go module exceeds the 5,000-entry identity scan limit.");
      const path = dir ? dir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile()) dependencyUnavailable("Go module tree contains a symlink or a special file.");
      const digest = await withDependencyFile(root, join(root, path), async (handle, size) => {
        if (size > remaining) dependencyUnavailable("Go module exceeds the 20 MB identity scan limit.");
        const hash = createHash("sha256");
        // Read one byte past the allowance to detect a file that grew after stat.
        for await (const chunk of handle.createReadStream({ autoClose: false, end: remaining, signal })) {
          remaining -= chunk.length;
          if (remaining < 0) dependencyUnavailable("Go module exceeds the 20 MB identity scan limit.");
          hash.update(chunk);
        }
        return hash.digest("hex");
      });
      hashes.set(path, digest);
    }
  }
  return hashes;
}

export async function resolveGoDependency(
  module: string, go: GoDependencies, sum: string, signal?: AbortSignal
): Promise<DependencyIdentity> {
  const version = go.requires.get(module);
  if (!version || !/^v[0-9][0-9A-Za-z.+-]*$/u.test(version) ||
      module.split("/").some(part => !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(part))) {
    dependencyUnavailable("No valid pinned version in the tracked go.mod.");
  }
  const replaced = go.replaces.get(module);
  if (replaced?.has("*") || replaced?.has(version)) dependencyUnavailable("The tracked go.mod replaces this module.");
  const entries = sum.split(/\r?\n/u).map(line => line.trim().split(/\s+/u));
  // Go writes the original module path to go.sum. It escapes case only in cache paths.
  const integrity = entries.find(([name, at]) => name === module && at === version)?.[2];
  if (!integrity?.startsWith("h1:")) dependencyUnavailable("No module integrity in the tracked go.sum.");
  const gopath = process.env.GOPATH?.split(delimiter)[0] || join(homedir(), "go");
  const cache = await realpath(resolve(process.env.GOMODCACHE || join(gopath, "pkg", "mod")));
  const prefix = `${module}@${version}`;
  const path = goEscape(prefix);
  const root = await dependencyRealpath(cache, join(cache, path));
  const fileHashes = await hashGoTree(root, signal);
  const names = [...fileHashes.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const hash = createHash("sha256");
  for (const name of names) hash.update(`${fileHashes.get(name)}  ${prefix}/${name}\n`);
  if ("h1:" + hash.digest("base64") !== integrity) dependencyUnavailable("The installed Go module does not match go.sum.");
  return { root, location: `module-cache/${path}`, version, lockfile: "go.sum", lockEntry: prefix, integrity,
    identity: "go.sum verified", fileHashes };
}
