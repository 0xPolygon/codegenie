import { CodegenieError } from "../src/util/errors.js";
import { isRecoverableWorkerError } from "../src/pipeline/pipeline-utils.js";
import { describe, expect, it, vi } from "vitest";
import { createWorkerRunner } from "../src/pipeline/worker-runner.js";

describe("worker repair allowance and cancellation cleanup", () => {
  it.each(["timeout", "llm_schema_invalid"] as const)("records the scheduler decision for %s", async (failure) => {
    const event = vi.fn();
    const runner = createWorkerRunner({ concurrency: 1, telemetry: { event }, isRetriableError: isRecoverableWorkerError });
    let calls = 0;
    const result = await runner.schedule([{
      stage: 7, priority: "normal", timeoutMs: 1000, retryOnTransient: true,
      run: async () => {
        if (++calls === 1) throw new CodegenieError(failure === "timeout" ? "llm_call_failed" : failure,
          "failed", { recoverable: true, context: { reason: failure } });
        return "recovered";
      }
    }]);
    expect(calls).toBe(failure === "timeout" ? 1 : 2);
    expect(event).toHaveBeenCalledWith(expect.objectContaining({
      message: "worker_retry_decision", data: expect.objectContaining({
        retry: failure !== "timeout", scope: "full_worker",
        reason: failure === "timeout" ? "pass_deadline_exhausted" : "restart_after_schema_failure"
      })
    }));
    expect(result[0]?.outcome).toBe(failure === "timeout" ? "failed" : "completed");
    if (failure !== "timeout") expect(event).toHaveBeenCalledWith(expect.objectContaining({ message: "worker_retry_recovered" }));
  });

  it("allows repair past the investigation deadline without timing out the worker", async () => {
    vi.useFakeTimers();
    try {
      const runner = createWorkerRunner({ concurrency: 1 });
      const result = runner.schedule([{
        stage: 9, priority: "normal", timeoutMs: 1000, repairAllowanceMs: 180_000,
        awaitCancellation: true, retryOnTransient: false,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          return "repaired";
        }
      }]);
      await vi.advanceTimersByTimeAsync(2500);
      expect(await result).toMatchObject([{ outcome: "completed", value: "repaired" }]);
    } finally { vi.useRealTimers(); }
  });

  it.each(["cancel", "timeout"] as const)("waits for cooperative cleanup on %s", async (mode) => {
    vi.useFakeTimers();
    try {
      const root = new AbortController();
      const runner = createWorkerRunner({ concurrency: 1, signal: root.signal });
      const events: string[] = [];
      const result = runner.schedule([{
        stage: 9, priority: "normal", timeoutMs: 1000, repairAllowanceMs: 180_000,
        awaitCancellation: true, retryOnTransient: false,
        run: async (signal) => {
          try {
            await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          } finally {
            await Promise.resolve();
            await Promise.resolve();
            events.push("cleanup");
          }
        }
      }]).then((outcomes) => { events.push("stage-closed"); return outcomes; });
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "cancel") root.abort();
      else await vi.advanceTimersByTimeAsync(182_000);
      expect(await result).toMatchObject([{ outcome: mode === "cancel" ? "cancelled" : "timed_out" }]);
      expect(events).toEqual(["cleanup", "stage-closed"]);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(events).toEqual(["cleanup", "stage-closed"]);
    } finally { vi.useRealTimers(); }
  });
});
