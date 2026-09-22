import { describe, expect, it, vi } from "vitest";
import { createWorkerRunner } from "../src/pipeline/worker-runner.js";

describe("worker repair allowance and cancellation cleanup", () => {
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
