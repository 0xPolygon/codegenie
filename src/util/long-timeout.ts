export const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export type LongTimeout = {
  cancel(): void;
};

export function scheduleLongTimeout(callback: () => void, delayMs: number): LongTimeout {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    throw new RangeError("timeout delay must be positive and finite");
  }

  const startedAt = Date.now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    if (cancelled) {
      return;
    }
    const remainingMs = delayMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      callback();
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, MAX_TIMEOUT_DELAY_MS));
    timer.unref?.();
  };

  arm();
  return {
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
}
