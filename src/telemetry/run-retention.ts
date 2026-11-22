import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { getCodegeniePaths } from "../config/paths.js";
import { defaultConfig } from "../config/schema.js";

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/u;
const SEAL_NAME = ".codegenie-run";
const SEAL_MAX_BYTES = 1024;
const KEY_BYTES = 32;

type RunSeal = {
  v: 1;
  runId: string;
  liveUntil: number;
  mac: string;
};

export type PruneResult = {
  deleted: string[];
  failures: Array<{ path: string; error: string }>;
};

export function sealAndPruneRuns(options: {
  runsRoot: string;
  runId: string;
  retainRuns: number;
  startedAtMs: number;
  maxTimeMs: number;
  nowMs: number;
}): PruneResult {
  const result: PruneResult = { deleted: [], failures: [] };
  const { runId, startedAtMs, maxTimeMs, nowMs } = options;
  if (!RUN_ID_RE.test(runId)) {
    return result;
  }

  let root: string;
  let key: Buffer;
  let names: string[];
  try {
    root = realpathSync(options.runsRoot);
    key = loadRetentionKey();
    const runDir = path.join(root, runId);
    const stats = lstatSync(runDir, { bigint: true });
    if (!stats.isDirectory() || stats.ino === 0n) {
      return result;
    }
    const liveUntil = startedAtMs + 3 * Math.max(maxTimeMs, defaultConfig.review.maxTimeMs);
    const seal: RunSeal = {
      v: 1, runId, liveUntil, mac: sign(key, root, runId, liveUntil, stats.ino.toString()).toString("hex")
    };
    writeFileSync(path.join(runDir, SEAL_NAME), JSON.stringify(seal), { flag: "wx", mode: 0o600 });
    names = readdirSync(root);
  } catch (error) {
    result.failures.push({ path: options.runsRoot, error: errorMessage(error) });
    return result;
  }

  const keepCount = Math.max(1, options.retainRuns);
  if (names.length <= keepCount + 1) {
    return result;
  }
  // The UTC timestamp prefix sorts by run creation time.
  let kept = 0;
  for (const name of names.sort().reverse()) {
    if (name === runId || !RUN_ID_RE.test(name)) {
      continue;
    }
    const entry = path.join(root, name);
    try {
      const seal = verifySeal(entry, name, root, key);
      if (!seal) {
        continue;
      }
      if (kept < keepCount) {
        kept += 1;
        continue;
      }
      if (nowMs > seal.liveUntil) {
        const current = lstatSync(entry, { bigint: true, throwIfNoEntry: false });
        if (!current?.isDirectory() || current.ino !== seal.inode) {
          continue;
        }
        rmSync(entry, { recursive: true });
        result.deleted.push(name);
      }
    } catch (error) {
      // A concurrent review may have already pruned this run.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        result.failures.push({ path: entry, error: errorMessage(error) });
      }
    }
  }

  return result;
}

function loadRetentionKey(): Buffer {
  const { home } = getCodegeniePaths();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const realHome = realpathSync(home);
  for (let dir = realHome; ; dir = path.dirname(dir)) {
    if (lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false })) {
      throw new Error("the retention key must be outside a Git worktree");
    }
    if (path.dirname(dir) === dir) {
      break;
    }
  }
  const keyPath = path.join(realHome, "retention.key");
  try {
    const key = randomBytes(KEY_BYTES);
    writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const key = readRegularFile(keyPath, KEY_BYTES, process.platform === "win32" ? 0 : 0o077);
  if (key?.length !== KEY_BYTES) {
    throw new Error("the retention key must be a regular 32-byte file");
  }
  return key;
}

function verifySeal(
  entry: string, name: string, root: string, key: Buffer
): { liveUntil: number; inode: bigint } | undefined {
  const stats = lstatSync(entry, { bigint: true, throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.ino === 0n) {
    return undefined;
  }
  const raw = readRegularFile(path.join(entry, SEAL_NAME), SEAL_MAX_BYTES);
  if (!raw) {
    return undefined;
  }
  let seal: Partial<RunSeal> | null;
  try {
    seal = JSON.parse(raw.toString("utf8")) as Partial<RunSeal> | null;
  } catch {
    return undefined;
  }
  if (
    seal?.v !== 1 || seal.runId !== name ||
    typeof seal.liveUntil !== "number" || !Number.isFinite(seal.liveUntil) ||
    typeof seal.mac !== "string" || !/^[0-9a-f]{64}$/u.test(seal.mac)
  ) {
    return undefined;
  }
  const expected = sign(key, root, name, seal.liveUntil, stats.ino.toString());
  return timingSafeEqual(expected, Buffer.from(seal.mac, "hex"))
    ? { liveUntil: seal.liveUntil, inode: stats.ino }
    : undefined;
}

function readRegularFile(filePath: string, maxBytes: number, disallowedMode = 0): Buffer | undefined {
  const entry = lstatSync(filePath, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.size > maxBytes) {
    return undefined;
  }
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || (stats.mode & disallowedMode) !== 0) {
      return undefined;
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return bytes <= maxBytes ? buffer.subarray(0, bytes) : undefined;
  } finally {
    closeSync(fd);
  }
}

function sign(key: Buffer, root: string, name: string, expiry: number, inode: string): Buffer {
  return createHmac("sha256", key).update(JSON.stringify([1, root, name, expiry, inode])).digest();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
