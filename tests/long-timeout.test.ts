import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMEOUT_DELAY_MS, scheduleLongTimeout } from "../src/util/long-timeout.js";

describe("long timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-arms delays above Node's maximum without firing early", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const scheduled: Array<{
      callback: () => void;
      delayMs: number;
      handle: ReturnType<typeof setTimeout>;
      unref: ReturnType<typeof vi.fn>;
    }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delayMs?: number) => {
      const unref = vi.fn();
      const handle = { unref } as unknown as ReturnType<typeof setTimeout>;
      scheduled.push({ callback, delayMs: Number(delayMs), handle, unref });
      return handle;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    const callback = vi.fn();
    const totalDelayMs = MAX_TIMEOUT_DELAY_MS + 10_000;

    const timeout = scheduleLongTimeout(callback, totalDelayMs);

    expect(scheduled[0]?.delayMs).toBe(MAX_TIMEOUT_DELAY_MS);
    expect(scheduled[0]?.unref).toHaveBeenCalledOnce();

    now += MAX_TIMEOUT_DELAY_MS;
    scheduled[0]?.callback();
    expect(callback).not.toHaveBeenCalled();
    expect(scheduled[1]?.delayMs).toBe(10_000);
    expect(scheduled[1]?.unref).toHaveBeenCalledOnce();

    now += 10_000;
    scheduled[1]?.callback();
    expect(callback).toHaveBeenCalledOnce();

    timeout.cancel();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(scheduled[1]?.handle);
  });

  it("rejects non-finite delays", () => {
    expect(() => scheduleLongTimeout(vi.fn(), Number.POSITIVE_INFINITY)).toThrow(
      /timeout delay must be positive and finite/
    );
    expect(() => scheduleLongTimeout(vi.fn(), Number.NaN)).toThrow(
      /timeout delay must be positive and finite/
    );
  });
});
