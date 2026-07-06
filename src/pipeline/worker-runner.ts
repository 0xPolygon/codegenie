import pLimit from "p-limit";
import type { CoverageLevel, ReviewPriority, ReviewStage } from "../types.js";
import { finalizeGraceMs } from "../util/budget.js";

export type WorkerTask<T> = {
  workerId?: string;
  stage: ReviewStage;
  priority: ReviewPriority;
  coverage?: Exclude<CoverageLevel, "skip">;
  packetId?: string;
  candidateId?: string;
  // Which ensemble pass this task represents (plan 84). Outcomes are
  // returned in DISPATCH order (sorted by priority/coverage), not input
  // order, so pass identity must ride on the task itself.
  ensemblePass?: number;
  timeoutMs: number;
  retryOnTransient: boolean;
  run: (signal: AbortSignal, task: AssignedWorkerTask<T>) => Promise<T>;
};

export type AssignedWorkerTask<T> = WorkerTask<T> & { workerId: string };

export type WorkerOutcome<T> = {
  task: AssignedWorkerTask<T>;
  outcome: "completed" | "failed" | "cancelled" | "timed_out" | "not_dispatched";
  value?: T;
  error?: unknown;
  attempts: number;
};

export interface WorkerRunner {
  schedule<T>(tasks: Array<WorkerTask<T>>): Promise<Array<WorkerOutcome<T>>>;
  cancelAll(reason: string): void;
}

type WorkerRunnerOptions = {
  concurrency: number;
  checkpoint?: (stage: ReviewStage) => "ok" | "exhausted";
  signal?: AbortSignal | undefined;
  isRetriableError?: (error: unknown) => boolean;
};

const PRIORITY_ORDER: Record<ReviewPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
};

const COVERAGE_ORDER: Record<Exclude<CoverageLevel, "skip">, number> = {
  deep: 0,
  normal: 1,
  light: 2
};

export function createWorkerRunner(opts: WorkerRunnerOptions): WorkerRunner {
  const root = new AbortController();
  const limit = pLimit(Math.max(1, opts.concurrency));
  if (opts.signal) {
    if (opts.signal.aborted) {
      root.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener("abort", () => root.abort(opts.signal?.reason), { once: true });
    }
  }

  return {
    schedule: async <T>(tasks: Array<WorkerTask<T>>): Promise<Array<WorkerOutcome<T>>> => {
      const ordered = tasks
        .map((task, index) => ({ task, index }))
        .sort((a, b) =>
          PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority] ||
          coverageRank(a.task.coverage) - coverageRank(b.task.coverage) ||
          a.index - b.index
        )
        .map(({ task }, dispatchIndex) => ({ task: assignWorkerId(task, dispatchIndex + 1) }));
      let exhausted = false;
      const outcomes = await Promise.all(
        ordered.map(({ task }) =>
          limit(async (): Promise<WorkerOutcome<T>> => {
            if (root.signal.aborted) {
              return { task, outcome: "cancelled", error: root.signal.reason, attempts: 0 };
            }
            if (exhausted || opts.checkpoint?.(task.stage) === "exhausted") {
              exhausted = true;
              return { task, outcome: "not_dispatched", attempts: 0 };
            }
            return runTask(task, root.signal, opts.isRetriableError ?? (() => false), opts.checkpoint);
          })
        )
      );
      return outcomes;
    },
    cancelAll: (reason) => root.abort(new Error(reason))
  };
}

function assignWorkerId<T>(task: WorkerTask<T>, dispatchNumber: number): AssignedWorkerTask<T> {
  return {
    ...task,
    workerId: `w${String(task.stage)}-${String(dispatchNumber).padStart(3, "0")}`
  };
}

function coverageRank(coverage: Exclude<CoverageLevel, "skip"> | undefined): number {
  return coverage === undefined ? COVERAGE_ORDER.normal : COVERAGE_ORDER[coverage];
}

async function runTask<T>(
  task: AssignedWorkerTask<T>,
  rootSignal: AbortSignal,
  isRetriableError: (error: unknown) => boolean,
  checkpoint: ((stage: ReviewStage) => "ok" | "exhausted") | undefined
): Promise<WorkerOutcome<T>> {
  const maxAttempts = task.retryOnTransient ? 2 : 1;
  let lastOutcome: WorkerOutcome<T> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && checkpoint?.(task.stage) === "exhausted") {
      return { task, outcome: "not_dispatched", attempts: attempt - 1, error: lastOutcome?.error };
    }
    const outcome = await runTaskOnce(task, rootSignal, attempt);
    if (outcome.outcome === "completed") {
      return outcome;
    }
    lastOutcome = outcome;
    if (!task.retryOnTransient || outcome.outcome !== "failed" || !isRetriableError(outcome.error)) {
      return outcome;
    }
  }
  if (lastOutcome) {
    return lastOutcome;
  }
  return { task, outcome: "failed", attempts: 0 };
}

async function runTaskOnce<T>(task: AssignedWorkerTask<T>, rootSignal: AbortSignal, attempt: number): Promise<WorkerOutcome<T>> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(rootSignal.reason);
  if (rootSignal.aborted) {
    return { task, outcome: "cancelled", error: rootSignal.reason, attempts: attempt - 1 };
  }
  rootSignal.addEventListener("abort", onAbort, { once: true });
  // Hard deadline: the pass's soft budget plus the finalize grace window. The
  // soft deadline itself is enforced cooperatively inside the LLM runner loop
  // (no new investigation calls after it); this timer is the backstop.
  const timeout = setTimeout(
    () => controller.abort(new Error("worker timed out")),
    task.timeoutMs + finalizeGraceMs(task.timeoutMs)
  );
  const abortWaiter = abortPromise(controller.signal);

  try {
    const value = await Promise.race([task.run(controller.signal, task), abortWaiter.promise]);
    return { task, outcome: "completed", value, attempts: attempt };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        task,
        outcome: rootSignal.aborted ? "cancelled" : "timed_out",
        error,
        attempts: attempt
      };
    }
    return { task, outcome: "failed", error, attempts: attempt };
  } finally {
    abortWaiter.cleanup();
    clearTimeout(timeout);
    rootSignal.removeEventListener("abort", onAbort);
  }
}

function abortPromise(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let cleanup = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    cleanup = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cleanup };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("worker aborted");
}
