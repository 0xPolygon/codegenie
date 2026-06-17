import { describe, expect, it } from "vitest";
import { createReviewProgress } from "../src/cli/review-progress.js";

describe("review progress", () => {
  it("does not render when disabled, in CI, or on non-TTY streams", () => {
    expect(createReviewProgress({ enabled: false, env: {}, stream: fakeStream(true) })).toBeUndefined();
    expect(createReviewProgress({ enabled: true, env: { CI: "true" }, stream: fakeStream(true) })).toBeUndefined();
    expect(createReviewProgress({ enabled: true, env: {}, stream: fakeStream(false) })).toBeUndefined();
  });

  it("renders stage updates and clears before stopping", () => {
    const stream = fakeStream(true);
    const progress = createReviewProgress({ enabled: true, env: {}, stream });

    expect(progress).toBeDefined();
    expect(stream.writes.at(-1)).toContain("Reviewing");

    progress?.onTelemetryEvent({
      stage: 7,
      level: "info",
      message: "stage_started",
      data: { name: "packet_review" }
    });

    expect(stream.writes.at(-1)).toContain("stage 7: packet review");
    progress?.stop();
    expect(stream.clearCount).toBeGreaterThan(0);
    expect(stream.cursorCount).toBeGreaterThan(0);
  });

  it("does not throw when the progress stream rejects writes", () => {
    const stream = fakeStream(true);
    stream.write = () => {
      throw new Error("stream closed");
    };

    expect(() => createReviewProgress({ enabled: true, env: {}, stream })).not.toThrow();
  });
});

type FakeProgressStream = NodeJS.WriteStream & {
  writes: string[];
  clearCount: number;
  cursorCount: number;
};

function fakeStream(isTTY: boolean): FakeProgressStream {
  const stream = {
    isTTY,
    writes: [] as string[],
    clearCount: 0,
    cursorCount: 0,
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    clearLine() {
      this.clearCount += 1;
      return true;
    },
    cursorTo() {
      this.cursorCount += 1;
      return true;
    }
  };
  return stream as FakeProgressStream;
}
