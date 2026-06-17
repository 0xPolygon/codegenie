import type { ReviewStage, TelemetryEvent } from "../types.js";

type ProgressEvent = Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">;

type ProgressOptions = {
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
  stream?: NodeJS.WriteStream;
};

export type ReviewProgress = {
  onTelemetryEvent(event: ProgressEvent): void;
  stop(): void;
};

const FRAMES = ["-", "\\", "|", "/"] as const;

const STAGE_LABELS: Record<ReviewStage | 0, string> = {
  0: "setup",
  1: "resolving input",
  2: "parsing diff",
  3: "classifying files",
  4: "indexing symbols",
  5: "planning review",
  6: "building review packets",
  7: "reviewing packets",
  8: "checking follow-ups",
  9: "verifying findings",
  10: "composing review",
  11: "publishing"
};

export function createReviewProgress(options: ProgressOptions): ReviewProgress | undefined {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;
  if (!shouldShowProgress({ ...options, stream, env })) {
    return undefined;
  }

  let frameIndex = 0;
  let currentText = "Reviewing ...";
  let rendered = false;
  let stopped = false;

  const render = () => {
    if (stopped) {
      return;
    }
    try {
      const frame = FRAMES[frameIndex % FRAMES.length] ?? "-";
      frameIndex += 1;
      clearLine(stream);
      stream.write(`${frame} ${currentText}`);
      rendered = true;
    } catch {
      stopped = true;
      clearInterval(timer);
    }
  };

  const timer = setInterval(render, 120);
  timer.unref?.();
  render();

  return {
    onTelemetryEvent(event) {
      if (event.message === "stage_started") {
        currentText = `Reviewing (stage ${event.stage}: ${stageLabel(event)}) ...`;
        render();
        return;
      }
      if (event.message === "stage_completed") {
        currentText = `Reviewing (stage ${event.stage}: complete) ...`;
        render();
      }
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      if (rendered) {
        clearLine(stream);
      }
    }
  };
}

function shouldShowProgress(options: Required<ProgressOptions>): boolean {
  if (!options.enabled) {
    return false;
  }
  if (options.env.CI !== undefined && options.env.CI !== "" && options.env.CI !== "false" && options.env.CI !== "0") {
    return false;
  }
  return options.stream.isTTY === true;
}

function stageLabel(event: ProgressEvent): string {
  const name = isRecord(event.data) && typeof event.data.name === "string"
    ? event.data.name
    : STAGE_LABELS[event.stage] ?? "working";
  return name.replace(/_/gu, " ");
}

function clearLine(stream: NodeJS.WriteStream): void {
  stream.clearLine?.(0);
  stream.cursorTo?.(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
