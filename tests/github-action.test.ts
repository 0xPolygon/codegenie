import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_ALLOWED_ASSOCIATIONS,
  DEFAULT_TRIGGER_PHRASE,
  decideTrigger,
  matchesTriggerPhrase
} from "../src/github-action/event-gate.js";
import {
  applyGenericApiKey,
  executeGitHubActionCommand,
  parseGitHubActionArgs,
  parseModelSpec,
  toRunReviewResult
} from "../src/github-action/entrypoint.js";
import type { IssueComment, IssueCommentClient } from "../src/github-action/issue-comments.js";
import { createIssueCommentClient } from "../src/github-action/issue-comments.js";
import { appendStatusCommentMarker, STATUS_COMMENT_MARKER } from "../src/github-action/marker.js";
import { createStatusCommentController } from "../src/github-action/status-comment.js";
import { ISSUE_COMMENT_MAX_CHARS, TRUNCATION_DISCLOSURE } from "../src/github-action/render.js";
import { createGitHubClient } from "../src/github/github-client.js";
import type { runGh } from "../src/git/subprocess.js";
import type { ReviewResult } from "../src/types.js";
import { CodegenieError } from "../src/util/errors.js";

type RunGh = typeof runGh;

const RULES = {
  triggerPhrase: DEFAULT_TRIGGER_PHRASE,
  onPullRequest: true,
  allowedAssociations: [...DEFAULT_ALLOWED_ASSOCIATIONS],
  allowedUsers: [] as string[]
};

function pullRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    repository: { full_name: "acme/widgets" },
    pull_request: {
      number: 7,
      draft: false,
      author_association: "MEMBER",
      user: { login: "alice", type: "User" },
      head: { repo: { full_name: "acme/widgets" } },
      ...overrides
    }
  };
}

function issueCommentPayload(overrides: { body?: string; association?: string; login?: string; userType?: string } = {}): Record<string, unknown> {
  return {
    action: "created",
    repository: { full_name: "acme/widgets" },
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" } },
    comment: {
      body: overrides.body ?? "codegenie review",
      author_association: overrides.association ?? "COLLABORATOR",
      user: { login: overrides.login ?? "alice", type: overrides.userType ?? "User" }
    }
  };
}

describe("github-action event gate", () => {
  it("runs on pull_request opened and synchronize by allowed associations", () => {
    expect(decideTrigger("pull_request", pullRequestPayload(), RULES)).toMatchObject({
      run: true,
      lane: "pull_request",
      prNumber: 7,
      actor: "alice",
      actorAllowlisted: false
    });
    const payload = pullRequestPayload();
    payload.action = "synchronize";
    expect(decideTrigger("pull_request", payload, RULES)).toMatchObject({ run: true });
    payload.action = "ready_for_review";
    expect(decideTrigger("pull_request", payload, RULES)).toMatchObject({ run: true });
  });

  it("skips comment triggers on closed pull requests", () => {
    const closed = issueCommentPayload();
    (closed.issue as Record<string, unknown>).state = "closed";
    expect(decideTrigger("issue_comment", closed, RULES)).toMatchObject({
      run: false,
      reason: "pull request is closed"
    });
  });

  it("skips unsupported events, actions, drafts, and disabled lane", () => {
    expect(decideTrigger("push", {}, RULES)).toMatchObject({ run: false, reason: expect.stringContaining("unsupported event") });
    const closed = pullRequestPayload();
    closed.action = "closed";
    expect(decideTrigger("pull_request", closed, RULES)).toMatchObject({ run: false });
    expect(decideTrigger("pull_request", pullRequestPayload({ draft: true }), RULES)).toMatchObject({
      run: false,
      reason: "draft pull request"
    });
    expect(decideTrigger("pull_request", pullRequestPayload(), { ...RULES, onPullRequest: false })).toMatchObject({ run: false });
  });

  it("skips fork pull requests with a comment-lane pointer", () => {
    const fork = pullRequestPayload({ head: { repo: { full_name: "mallory/widgets" } } });
    expect(decideTrigger("pull_request", fork, RULES)).toMatchObject({
      run: false,
      reason: expect.stringContaining("comment trigger lane")
    });
  });

  it("gates by association with an allowed-users override that skips the live check", () => {
    const outsider = pullRequestPayload({ author_association: "NONE", user: { login: "mallory", type: "User" } });
    expect(decideTrigger("pull_request", outsider, RULES)).toMatchObject({ run: false });
    expect(decideTrigger("pull_request", outsider, { ...RULES, allowedUsers: ["Mallory"] })).toMatchObject({
      run: true,
      actorAllowlisted: true
    });
  });

  it("runs on matching PR comments and ignores bots, non-PR issues, and non-matching bodies", () => {
    expect(decideTrigger("issue_comment", issueCommentPayload(), RULES)).toMatchObject({
      run: true,
      lane: "issue_comment",
      prNumber: 7
    });
    expect(decideTrigger("issue_comment", issueCommentPayload({ body: "codegenie review please" }), RULES)).toMatchObject({ run: true });
    expect(decideTrigger("issue_comment", issueCommentPayload({ body: "please codegenie review" }), RULES)).toMatchObject({ run: false });
    expect(decideTrigger("issue_comment", issueCommentPayload({ userType: "Bot", login: "otherbot[bot]" }), RULES)).toMatchObject({
      run: false,
      reason: expect.stringContaining("bot actor")
    });
    const notPr = issueCommentPayload();
    notPr.issue = { number: 7 };
    expect(decideTrigger("issue_comment", notPr, RULES)).toMatchObject({ run: false });
  });

  it("matches the trigger phrase exactly, never as a word prefix", () => {
    expect(matchesTriggerPhrase("codegenie review", "codegenie review")).toBe(true);
    expect(matchesTriggerPhrase("  codegenie review \n", "codegenie review")).toBe(true);
    expect(matchesTriggerPhrase("codegenie review --depth deep", "codegenie review")).toBe(true);
    expect(matchesTriggerPhrase("codegenie reviews", "codegenie review")).toBe(false);
    expect(matchesTriggerPhrase("I think codegenie review is neat", "codegenie review")).toBe(false);
    expect(matchesTriggerPhrase("anything", "")).toBe(false);
  });
});

type FakeCommentCall =
  | { kind: "list"; issueNumber: number }
  | { kind: "create"; issueNumber: number; body: string }
  | { kind: "update"; commentId: number; body: string }
  | { kind: "permission"; login: string }
  | { kind: "viewer" };

function createFakeComments(opts: {
  existing?: IssueComment[];
  permission?: string;
  failUpdates?: boolean;
  viewerLogin?: string;
} = {}): { client: IssueCommentClient; calls: FakeCommentCall[] } {
  const calls: FakeCommentCall[] = [];
  let nextId = 100;
  const client: IssueCommentClient = {
    async listComments(issueNumber) {
      calls.push({ kind: "list", issueNumber });
      return opts.existing ?? [];
    },
    async createComment(issueNumber, body) {
      calls.push({ kind: "create", issueNumber, body });
      nextId += 1;
      return { id: nextId, body, author: "codegenie[bot]", authorType: "Bot" };
    },
    async updateComment(commentId, body) {
      calls.push({ kind: "update", commentId, body });
      if (opts.failUpdates === true) {
        throw new CodegenieError("github_post_failed", "boom");
      }
    },
    async getCollaboratorPermission(login) {
      calls.push({ kind: "permission", login });
      return opts.permission ?? "write";
    },
    async getViewerLogin() {
      calls.push({ kind: "viewer" });
      return opts.viewerLogin;
    }
  };
  return { client, calls };
}

const BOT = "codegenie[bot]";

function stageEvent(message: "stage_started" | "stage_completed", stage: number): Parameters<ReturnType<typeof createStatusCommentController>["onTelemetryEvent"]>[0] {
  return { stage: stage as 1, level: "info", message };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("status comment controller", () => {
  it("creates the comment when none exists and reclaims its own marker comment on rerun", async () => {
    const fresh = createFakeComments();
    const controller = createStatusCommentController({ comments: fresh.client, prNumber: 7, ownLogin: BOT });
    const claimed = await controller.claim();
    expect(claimed.author).toBe(BOT);
    expect(fresh.calls[1]).toMatchObject({ kind: "create", issueNumber: 7 });
    expect((fresh.calls[1] as { body: string }).body).toContain(STATUS_COMMENT_MARKER);
    expect(controller.stats().claimed).toBe("created");

    const rerun = createFakeComments({
      existing: [
        { id: 1, body: `spoof ${STATUS_COMMENT_MARKER}`, author: "mallory" },
        { id: 2, body: `old status ${STATUS_COMMENT_MARKER}`, author: "Codegenie[bot]" }
      ]
    });
    const rerunController = createStatusCommentController({ comments: rerun.client, prNumber: 7, ownLogin: BOT });
    const reclaimed = await rerunController.claim();
    expect(reclaimed.commentId).toBe(2);
    expect(rerunController.stats().claimed).toBe("reclaimed");
    expect(rerun.calls[1]).toMatchObject({ kind: "update", commentId: 2 });
  });

  it("never reclaims marker comments from humans or other bots — exact author match only", async () => {
    const human = createFakeComments({
      existing: [{ id: 1, body: `spoof ${STATUS_COMMENT_MARKER}`, author: "mallory" }]
    });
    const humanController = createStatusCommentController({ comments: human.client, prNumber: 7, ownLogin: "codebot" });
    await humanController.claim();
    expect(humanController.stats().claimed).toBe("created");

    const foreignBot = createFakeComments({
      existing: [{ id: 3, body: `other app ${STATUS_COMMENT_MARKER}`, author: "other-app[bot]" }]
    });
    const foreignController = createStatusCommentController({ comments: foreignBot.client, prNumber: 7, ownLogin: "github-actions[bot]" });
    await foreignController.claim();
    expect(foreignController.stats().claimed).toBe("created");
  });

  it("throttles fast events, then flushes the latest state on the trailing edge", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeComments();
      const controller = createStatusCommentController({
        comments: fake.client,
        prNumber: 7,
        ownLogin: BOT,
        minEditIntervalMs: 10_000
      });
      await controller.claim();

      // stages 1-4 complete fast, all inside the throttle window
      controller.onTelemetryEvent(stageEvent("stage_started", 1));
      controller.onTelemetryEvent(stageEvent("stage_completed", 1));
      controller.onTelemetryEvent(stageEvent("stage_started", 5));
      expect(fake.calls.filter((call) => call.kind === "update")).toHaveLength(0);
      expect(controller.stats().throttledCount).toBe(3);

      // the trailing-edge flush lands the LATEST state without another event
      await vi.advanceTimersByTimeAsync(10_100);
      const updates = fake.calls.filter((call) => call.kind === "update") as Array<{ body: string }>;
      expect(updates).toHaveLength(1);
      expect(updates[0]?.body).toContain("☑ resolving input");
      expect(updates[0]?.body).toContain("▸ planning review");
      expect(updates[0]?.body).toContain("☐ verifying findings");
      expect(controller.stats().editCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll while a progress PATCH is in flight and flushes once after it settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const fake = createFakeComments();
      const firstPatch = deferred();
      let patchCount = 0;
      fake.client.updateComment = async (commentId, body) => {
        fake.calls.push({ kind: "update", commentId, body });
        patchCount += 1;
        if (patchCount === 1) {
          await firstPatch.promise;
        }
      };
      const controller = createStatusCommentController({
        comments: fake.client,
        prNumber: 7,
        ownLogin: BOT,
        minEditIntervalMs: 1_000
      });
      await controller.claim();

      await vi.advanceTimersByTimeAsync(1_000);
      controller.onTelemetryEvent(stageEvent("stage_started", 1));
      controller.onTelemetryEvent(stageEvent("stage_completed", 1));
      controller.onTelemetryEvent(stageEvent("stage_started", 2));
      expect(fake.calls.filter((call) => call.kind === "update")).toHaveLength(1);
      expect(controller.stats().throttledCount).toBe(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fake.calls.filter((call) => call.kind === "update")).toHaveLength(1);
      expect(controller.stats().throttledCount).toBe(2);

      firstPatch.resolve();
      await vi.advanceTimersByTimeAsync(50);
      const updates = fake.calls.filter((call) => call.kind === "update") as Array<{ body: string }>;
      expect(updates).toHaveLength(2);
      expect(updates[1]?.body).toContain("▸ parsing diff");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a timer-driven progress failure without blocking the terminal edit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const fake = createFakeComments();
      let failProgress = true;
      fake.client.updateComment = async (commentId, body) => {
        fake.calls.push({ kind: "update", commentId, body });
        if (failProgress) {
          throw new CodegenieError("github_post_failed", "progress failed");
        }
      };
      const controller = createStatusCommentController({
        comments: fake.client,
        prNumber: 7,
        ownLogin: BOT,
        minEditIntervalMs: 1_000
      });
      await controller.claim();
      controller.onTelemetryEvent(stageEvent("stage_started", 1));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(controller.stats().editFailures).toBe(1);

      failProgress = false;
      await controller.finalizeSuccess("# final report");
      expect(controller.stats()).toMatchObject({ terminalState: "report", editCount: 1, editFailures: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("supersedes a pending flush and seals the terminal state against late telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const fake = createFakeComments();
      const controller = createStatusCommentController({
        comments: fake.client,
        prNumber: 7,
        ownLogin: BOT,
        minEditIntervalMs: 1_000
      });
      await controller.claim();
      controller.onTelemetryEvent(stageEvent("stage_started", 1));
      await controller.finalizeSuccess("# final report");
      const updatesBeforeLateEvent = fake.calls.filter((call) => call.kind === "update").length;

      controller.onTelemetryEvent(stageEvent("stage_started", 2));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fake.calls.filter((call) => call.kind === "update")).toHaveLength(updatesBeforeLateEvent);
      expect(updatesBeforeLateEvent).toBe(1);
      expect(controller.stats().terminalState).toBe("report");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes headless after repeated edit failures but still lands the terminal edit", async () => {
    let failUpdates = true;
    const logs: string[] = [];
    const calls: FakeCommentCall[] = [];
    const client: IssueCommentClient = {
      async listComments() {
        return [];
      },
      async createComment(issueNumber, body) {
        calls.push({ kind: "create", issueNumber, body });
        return { id: 9, body, author: BOT };
      },
      async updateComment(commentId, body) {
        calls.push({ kind: "update", commentId, body });
        if (failUpdates) {
          throw new CodegenieError("github_post_failed", "boom");
        }
      },
      async getCollaboratorPermission() {
        return "write";
      },
      async getViewerLogin() {
        return undefined;
      }
    };
    const controller = createStatusCommentController({
      comments: client,
      prNumber: 7,
      ownLogin: BOT,
      minEditIntervalMs: 0,
      maxConsecutiveEditFailures: 2,
      log: (message) => {
        logs.push(message);
      }
    });
    await controller.claim();

    for (const stage of [1, 2, 3, 4]) {
      controller.onTelemetryEvent(stageEvent("stage_started", stage));
      await controller.settle();
    }
    expect(controller.stats().editFailures).toBe(2);
    expect(calls.filter((call) => call.kind === "update")).toHaveLength(2);

    failUpdates = false;
    await controller.finalizeSuccess("# review\n\nall good");
    expect(calls.filter((call) => call.kind === "update")).toHaveLength(3);
    expect(controller.stats().terminalState).toBe("report");
    expect(logs.some((line) => line.includes("progress edit failed"))).toBe(true);
    expect(logs.some((line) => line.includes("headless"))).toBe(true);
  });

  it("sanitizes the terminal report, appends the marker after sanitization, and links the run", async () => {
    const fake = createFakeComments();
    const controller = createStatusCommentController({
      comments: fake.client,
      prNumber: 7,
      ownLogin: BOT,
      runUrl: "https://github.com/acme/widgets/actions/runs/42"
    });
    await controller.claim();
    await controller.finalizeSuccess("# review\n\nUnicode café 🧞; ping @alice <!-- sneaky --> done");
    const terminal = fake.calls.at(-1) as { body: string };
    expect(terminal.body).toContain("`@alice`");
    expect(terminal.body).not.toContain("sneaky");
    expect(terminal.body).toContain(STATUS_COMMENT_MARKER);
    expect(terminal.body).toContain("actions/runs/42");
    expect(terminal.body.indexOf(STATUS_COMMENT_MARKER)).toBeGreaterThan(terminal.body.indexOf("done"));
    expect(controller.stats().terminalState).toBe("report");
    const terminalBytes = Buffer.byteLength(terminal.body, "utf8");
    expect(terminalBytes).toBeGreaterThan(terminal.body.length);
    expect(controller.stats()).toMatchObject({
      finalBodyBytes: terminalBytes,
      finalBodyBytesBeforeCap: terminalBytes
    });
  });

  it("caps oversized terminal reports with a disclosure", async () => {
    const fake = createFakeComments();
    const controller = createStatusCommentController({ comments: fake.client, prNumber: 7, ownLogin: BOT });
    await controller.claim();
    const report = `# review\n\n${"é🧞 finding line\n".repeat(9_000)}`;
    await controller.finalizeSuccess(report);
    const terminal = fake.calls.at(-1) as { body: string };
    expect(terminal.body.length).toBeLessThanOrEqual(ISSUE_COMMENT_MAX_CHARS);
    expect(terminal.body).toContain(TRUNCATION_DISCLOSURE);
    expect(terminal.body).toContain(STATUS_COMMENT_MARKER);
    expect(controller.stats().terminalState).toBe("report_truncated");
    expect(controller.stats().finalBodyBytes).toBe(Buffer.byteLength(terminal.body, "utf8"));
    expect(controller.stats().finalBodyBytesBeforeCap).toBe(
      Buffer.byteLength(appendStatusCommentMarker(report), "utf8")
    );
    expect(controller.stats().finalBodyBytesBeforeCap).toBeGreaterThan(controller.stats().finalBodyBytes ?? 0);
  });

  it("posts a failure terminal state and reports edit failure without throwing", async () => {
    const ok = createFakeComments();
    const controller = createStatusCommentController({ comments: ok.client, prNumber: 7, ownLogin: BOT });
    await controller.claim();
    await expect(controller.finalizeFailure("échec_🧞")).resolves.toBe(true);
    const terminal = ok.calls.at(-1) as { body: string };
    expect(terminal.body).toContain("`échec_🧞`");
    expect(controller.stats().terminalState).toBe("failure");
    const failureBytes = Buffer.byteLength(terminal.body, "utf8");
    expect(failureBytes).toBeGreaterThan(terminal.body.length);
    expect(controller.stats()).toMatchObject({
      finalBodyBytes: failureBytes,
      finalBodyBytesBeforeCap: failureBytes
    });

    const failing = createFakeComments({ failUpdates: true });
    const failingController = createStatusCommentController({ comments: failing.client, prNumber: 7, ownLogin: BOT });
    // claim's initial write is a create, which succeeds even when updates fail
    failing.calls.length = 0;
    await failingController.claim();
    await expect(failingController.finalizeFailure("timeout")).resolves.toBe(false);
    expect(failingController.stats()).toMatchObject({
      terminalState: "failure",
      editFailures: 1,
      finalBodyBytes: expect.any(Number),
      finalBodyBytesBeforeCap: expect.any(Number)
    });
    expect(failingController.stats().finalBodyBytes).toBe(failingController.stats().finalBodyBytesBeforeCap);
  });
});

describe("github-action entrypoint", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "codegenie-gha-"));

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function actionEnv(payload: Record<string, unknown>, eventName: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const eventPath = path.join(scratch, `event-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(eventPath, JSON.stringify(payload));
    return {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_RUN_ID: "42",
      GITHUB_SERVER_URL: "https://github.com",
      ...extra
    };
  }

  it("skips without touching GitHub when the trigger does not match", async () => {
    const fake = createFakeComments();
    let output = "";
    await executeGitHubActionCommand([], {
      env: actionEnv(issueCommentPayload({ body: "nice PR!" }), "issue_comment"),
      issueComments: fake.client,
      writeOutput: (text) => {
        output += text;
      },
      runReview: async () => {
        throw new Error("review must not run");
      }
    });
    expect(output).toContain("skipped");
    expect(fake.calls).toHaveLength(0);
  });

  it("skips when the live permission check denies the actor", async () => {
    const fake = createFakeComments({ permission: "read" });
    let output = "";
    await executeGitHubActionCommand([], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: fake.client,
      writeOutput: (text) => {
        output += text;
      },
      runReview: async () => {
        throw new Error("review must not run");
      }
    });
    expect(output).toContain("lacks repository write access");
    expect(fake.calls).toEqual([{ kind: "permission", login: "alice" }]);
  });

  it("treats a 404 permission response as a skip but surfaces other permission-check errors", async () => {
    const notFound = createFakeComments();
    notFound.client.getCollaboratorPermission = async () => {
      throw new CodegenieError("gh_auth_failed", "gh: Not Found (HTTP 404)");
    };
    let output = "";
    await executeGitHubActionCommand([], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: notFound.client,
      writeOutput: (text) => {
        output += text;
      },
      runReview: async () => {
        throw new Error("review must not run");
      }
    });
    expect(output).toContain("lacks repository write access");

    const badToken = createFakeComments();
    badToken.client.getCollaboratorPermission = async () => {
      throw new CodegenieError("gh_auth_failed", "gh: Bad credentials (HTTP 401)");
    };
    await expect(
      executeGitHubActionCommand([], {
        env: actionEnv(issueCommentPayload(), "issue_comment"),
        issueComments: badToken.client,
        writeOutput: () => undefined,
        runReview: async () => {
          throw new Error("review must not run");
        }
      })
    ).rejects.toMatchObject({ code: "gh_auth_failed" });
  });

  it("uses the authoritative event gate and live permission check in preflight mode", async () => {
    async function preflight(
      payload: Record<string, unknown>,
      comments: ReturnType<typeof createFakeComments>,
      args: string[] = []
    ): Promise<Record<string, string>> {
      const outputPath = path.join(scratch, `output-${Math.random().toString(36).slice(2)}.txt`);
      await executeGitHubActionCommand(["--preflight-only", "true", ...args], {
        env: actionEnv(payload, "issue_comment", { GITHUB_OUTPUT: outputPath, GITHUB_ACTIONS: "true" }),
        issueComments: comments.client,
        writeOutput: () => undefined,
        runReview: async () => {
          throw new Error("preflight must not run a review");
        }
      });
      return Object.fromEntries(
        readFileSync(outputPath, "utf8").trim().split("\n").map((line) => line.split("=", 2) as [string, string])
      );
    }

    const leadingWhitespace = createFakeComments({ permission: "write" });
    await expect(preflight(issueCommentPayload({ body: "  codegenie review\n" }), leadingWhitespace)).resolves.toMatchObject({
      "should-run": "true",
      "pr-number": "7"
    });
    expect(leadingWhitespace.calls).toEqual([{ kind: "permission", login: "alice" }]);

    const prefix = createFakeComments();
    await expect(preflight(issueCommentPayload({ body: "codegenie reviewer" }), prefix)).resolves.toEqual({ "should-run": "false" });
    expect(prefix.calls).toHaveLength(0);

    const customPhrase = createFakeComments();
    await expect(
      preflight(issueCommentPayload({ body: "review now", association: "NONE", login: "release-bot" }), customPhrase, [
        "--trigger-phrase", "review now",
        "--allowed-users", "release-bot"
      ])
    ).resolves.toMatchObject({ "should-run": "true", "pr-number": "7" });
    expect(customPhrase.calls).toHaveLength(0);

    const narrowed = createFakeComments({ permission: "write" });
    await expect(
      preflight(issueCommentPayload({ association: "COLLABORATOR" }), narrowed, ["--allowed-associations", "OWNER,MEMBER"])
    ).resolves.toEqual({ "should-run": "false" });
    expect(narrowed.calls).toHaveLength(0);

    const triageCollaborator = createFakeComments({ permission: "read" });
    await expect(preflight(issueCommentPayload({ association: "COLLABORATOR" }), triageCollaborator)).resolves.toEqual({
      "should-run": "false"
    });
    expect(triageCollaborator.calls).toEqual([{ kind: "permission", login: "alice" }]);
  });

  it("runs the full lifecycle: claim, progress edits, terminal report, identity injection, artifacts", async () => {
    const fake = createFakeComments();
    const runDir = mkdtempSync(path.join(scratch, "run-"));
    const reportPath = path.join(scratch, "report.md");
    const env = actionEnv(issueCommentPayload(), "issue_comment", { CODEGENIE_REPORT_PATH: reportPath });
    let reviewArgv: string[] = [];
    let output = "";

    await executeGitHubActionCommand(["--depth", "deep", "--lens", "security"], {
      env,
      issueComments: fake.client,
      minEditIntervalMs: 0,
      writeOutput: (text) => {
        output += text;
      },
      runReview: async (argv, hooks) => {
        reviewArgv = argv;
        for (const stage of [1, 2, 3]) {
          hooks.onTelemetryEvent(stageEvent("stage_started", stage));
          hooks.onTelemetryEvent(stageEvent("stage_completed", stage));
          await Promise.resolve();
        }
        // stdout carries the short posting summary when inline posting is on
        hooks.writeOutput("codegenie GitHub posting summary\n");
        return { runId: "r1", runDir, reportMarkdown: "# codegenie review\n\nfull report body\n" };
      }
    });

    expect(reviewArgv).toEqual([
      "review", "--pr", "7", "--ci", "--post-github-comments", "--depth", "deep", "--lens", "security"
    ]);
    expect(env.CODEGENIE_GITHUB_LOGIN).toBe("codegenie[bot]");
    expect(fake.calls[0]).toMatchObject({ kind: "permission" });
    expect(fake.calls[1]).toMatchObject({ kind: "viewer" });
    expect(fake.calls[2]).toMatchObject({ kind: "list" });
    expect(fake.calls[3]).toMatchObject({ kind: "create" });
    const terminal = fake.calls.at(-1) as { kind: string; body: string };
    expect(terminal.kind).toBe("update");
    // the comment gets the FULL report, never the stdout posting summary
    expect(terminal.body).toContain("# codegenie review");
    expect(terminal.body).not.toContain("posting summary");
    expect(terminal.body).toContain(STATUS_COMMENT_MARKER);
    expect(output).toContain("posting summary");
    expect(readFileSync(reportPath, "utf8")).toContain("# codegenie review");
    const record = JSON.parse(readFileSync(path.join(runDir, "github-action.json"), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ lane: "issue_comment", prNumber: 7, actor: "alice" });
    expect(output).toContain("review complete");
  });

  it("posts a failure terminal state and rethrows when the review fails", async () => {
    const fake = createFakeComments();
    const runDir = mkdtempSync(path.join(scratch, "failed-run-"));
    let output = "";
    await expect(
      executeGitHubActionCommand([], {
        env: actionEnv(pullRequestPayload(), "pull_request"),
        issueComments: fake.client,
        minEditIntervalMs: 0,
        writeOutput: (text) => {
          output += text;
        },
        runReview: async (_argv, hooks) => {
          hooks.onRunStart({ runId: "failed", runDir });
          throw new CodegenieError("llm_call_failed", "provider down");
        }
      })
    ).rejects.toMatchObject({ code: "llm_call_failed" });
    const terminal = fake.calls.at(-1) as { kind: string; body: string };
    expect(terminal.kind).toBe("update");
    expect(terminal.body).toContain("`llm_call_failed`");
    expect(JSON.parse(readFileSync(path.join(runDir, "github-action.json"), "utf8"))).toMatchObject({
      outcome: "review_failed",
      errorCode: "llm_call_failed",
      statusComment: {
        terminalState: "failure",
        finalBodyBytes: expect.any(Number),
        finalBodyBytesBeforeCap: expect.any(Number)
      }
    });
    expect(output).toContain('"outcome":"review_failed"');
  });

  it("disables inline posting when post-inline-comments is false", async () => {
    const fake = createFakeComments();
    let reviewArgv: string[] = [];
    await executeGitHubActionCommand(["--post-inline-comments", "false"], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: fake.client,
      minEditIntervalMs: 0,
      writeOutput: () => undefined,
      runReview: async (argv) => {
        reviewArgv = argv;
        return { runId: "r1", runDir: "", reportMarkdown: "# report" };
      }
    });
    expect(reviewArgv).not.toContain("--post-github-comments");
  });

  it("publishes the report fallback even when the terminal edit fails", async () => {
    const fake = createFakeComments({ failUpdates: true });
    const reportPath = path.join(scratch, `fallback-${Math.random().toString(36).slice(2)}.md`);
    const stepSummaryPath = path.join(scratch, `summary-${Math.random().toString(36).slice(2)}.md`);
    const runDir = mkdtempSync(path.join(scratch, "post-failed-run-"));
    await expect(
      executeGitHubActionCommand([], {
        env: actionEnv(issueCommentPayload(), "issue_comment", {
          CODEGENIE_REPORT_PATH: reportPath,
          GITHUB_STEP_SUMMARY: stepSummaryPath
        }),
        issueComments: fake.client,
        writeOutput: () => undefined,
        runReview: async () => ({
          runId: "r1",
          runDir,
          reportMarkdown: "# fallback report\n\nping @alice <!-- hidden -->"
        })
      })
    ).rejects.toMatchObject({ code: "github_post_failed" });
    expect(readFileSync(reportPath, "utf8")).toContain("# fallback report");
    const stepSummary = readFileSync(stepSummaryPath, "utf8");
    expect(stepSummary).toContain("`@alice`");
    expect(stepSummary).not.toContain("hidden");
    expect(JSON.parse(readFileSync(path.join(runDir, "github-action.json"), "utf8"))).toMatchObject({
      outcome: "terminal_post_failed",
      errorCode: "github_post_failed",
      statusComment: {
        terminalState: "report",
        editFailures: 1,
        finalBodyBytes: expect.any(Number),
        finalBodyBytesBeforeCap: expect.any(Number)
      }
    });
  });

  it("resolves identity via viewer login (PATs) or the bot-login input, and reclaims only exact matches", async () => {
    // PAT: /user resolves → own prior comment reclaimed
    const pat = createFakeComments({
      viewerLogin: "peter",
      existing: [{ id: 9, body: `old ${STATUS_COMMENT_MARKER}`, author: "peter" }]
    });
    await executeGitHubActionCommand([], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: pat.client,
      minEditIntervalMs: 0,
      writeOutput: () => undefined,
      runReview: async () => ({ runId: "r1", runDir: "", reportMarkdown: "# r" })
    });
    expect(pat.calls.some((call) => call.kind === "create")).toBe(false);
    expect(pat.calls.some((call) => call.kind === "update" && call.commentId === 9)).toBe(true);

    // custom app: --bot-login reclaims case-insensitively
    const app = createFakeComments({
      viewerLogin: "conflicting-pat-login",
      existing: [{ id: 4, body: `old ${STATUS_COMMENT_MARKER}`, author: "My-App[bot]" }]
    });
    await executeGitHubActionCommand(["--bot-login", "my-app[bot]"], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: app.client,
      minEditIntervalMs: 0,
      writeOutput: () => undefined,
      runReview: async () => ({ runId: "r1", runDir: "", reportMarkdown: "# r" })
    });
    expect(app.calls.some((call) => call.kind === "create")).toBe(false);
    expect(app.calls.some((call) => call.kind === "update" && call.commentId === 4)).toBe(true);
    expect(app.calls.some((call) => call.kind === "viewer")).toBe(false);

    // installation token, no input: another app's marker is never adopted
    const foreign = createFakeComments({
      existing: [{ id: 3, body: `other ${STATUS_COMMENT_MARKER}`, author: "other-app[bot]" }]
    });
    await executeGitHubActionCommand([], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: foreign.client,
      minEditIntervalMs: 0,
      writeOutput: () => undefined,
      runReview: async () => ({ runId: "r1", runDir: "", reportMarkdown: "# r" })
    });
    expect(foreign.calls.some((call) => call.kind === "create")).toBe(true);
  });

  it("parses provider/model:reasoning specs with a high default", () => {
    expect(parseModelSpec("anthropic/claude-opus-4-8")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "high"
    });
    expect(parseModelSpec("openai/gpt-5.5:xhigh")).toEqual({ provider: "openai", model: "gpt-5.5", reasoning: "xhigh" });
    expect(parseModelSpec("opus")).toEqual({ model: "opus", reasoning: "high" });
    // a :suffix that is not a reasoning level stays part of the model id
    expect(parseModelSpec("ollama/llama3:8b")).toEqual({ provider: "ollama", model: "llama3:8b", reasoning: "high" });
    expect(() => parseModelSpec("/claude")).toThrow(/provider\/model/u);
    expect(() => parseModelSpec("anthropic/")).toThrow(/provider\/model/u);
  });

  it("adapts the production ReviewResult into a complete secret-scrubbed report", () => {
    const review: ReviewResult = {
      summary: "Review completed; token=super-secret-value",
      coverage: {
        totalHunks: 2,
        reviewedHunks: 2,
        skippedHunks: 0,
        failedHunks: 0,
        coverageByLevel: { deep: 1, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: []
      },
      findings: [],
      summaryOnlyFindings: [],
      needsHumanAttention: [],
      noFindings: true,
      postingPlan: { inline: [], reviewBody: "concise posting summary" }
    };

    const result = toRunReviewResult({ runId: "r1", runDir: "", review });
    expect(result.reportMarkdown).toContain("# codegenie review");
    expect(result.reportMarkdown).toContain("## Coverage");
    expect(result.reportMarkdown).toContain("## No Findings");
    expect(result.reportMarkdown).not.toContain("super-secret-value");
    expect(result.reportMarkdown).toContain("[redacted:secret]");
    expect(result.reportMarkdown).not.toContain("concise posting summary");
  });

  it("routes LLM_API_KEY to the provider's env var without clobbering native vars", () => {
    const env: NodeJS.ProcessEnv = { LLM_API_KEY: "generic-key" };
    applyGenericApiKey(env, parseModelSpec("anthropic/claude-opus-4-8"));
    expect(env.ANTHROPIC_API_KEY).toBe("generic-key");

    const preset: NodeJS.ProcessEnv = { LLM_API_KEY: "generic-key", OPENAI_API_KEY: "native-key" };
    applyGenericApiKey(preset, parseModelSpec("openai/gpt-5.5"));
    expect(preset.OPENAI_API_KEY).toBe("native-key");

    expect(() => applyGenericApiKey({ LLM_API_KEY: "k" }, parseModelSpec("opus"))).toThrow(/provider prefix/u);
    expect(() => applyGenericApiKey({ LLM_API_KEY: "k" }, parseModelSpec("not-a-provider/x"))).toThrow(
      /does not accept an API key/u
    );
    const untouched: NodeJS.ProcessEnv = {};
    applyGenericApiKey(untouched, undefined);
    expect(untouched).toEqual({});
  });

  it("expands the model spec into the synthesized review argv", async () => {
    const fake = createFakeComments();
    let reviewArgv: string[] = [];
    await executeGitHubActionCommand(["--model", "anthropic/claude-opus-4-8:xhigh"], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: fake.client,
      minEditIntervalMs: 0,
      writeOutput: () => undefined,
      runReview: async (argv) => {
        reviewArgv = argv;
        return { runId: "r1", runDir: "", reportMarkdown: "# report" };
      }
    });
    expect(reviewArgv).toEqual([
      "review", "--pr", "7", "--ci", "--post-github-comments",
      "--provider", "anthropic", "--model", "claude-opus-4-8", "--reasoning", "xhigh"
    ]);
  });

  it("rejects unknown flags and invalid booleans", () => {
    expect(() => parseGitHubActionArgs(["--bogus", "x"])).toThrow(/unknown github-action flag/u);
    expect(() => parseGitHubActionArgs(["--on-pull-request", "yes"])).toThrow(/must be/u);
    expect(() => parseGitHubActionArgs(["--trigger-phrase", " "])).toThrow(/must not be empty/u);
    const parsed = parseGitHubActionArgs([
      "--allowed-associations", "OWNER, MEMBER",
      "--allowed-users", "alice,bob",
      "--preflight-only", "true",
      "--depth", ""
    ]);
    expect(parsed.allowedAssociations).toEqual(["OWNER", "MEMBER"]);
    expect(parsed.allowedUsers).toEqual(["alice", "bob"]);
    expect(parsed.preflightOnly).toBe(true);
    expect(parsed.reviewPassthrough).toEqual([]);
  });
});

describe("issue comment client", () => {
  it("paginates listing, creates, updates, and reads collaborator permission", async () => {
    const calls: string[][] = [];
    const gh: RunGh = async (_repoRoot, args, opts) => {
      calls.push(args);
      const endpoint = args[1] ?? "";
      if (endpoint.endsWith("&page=1") && endpoint.includes("/issues/7/comments")) {
        return JSON.stringify(
          Array.from({ length: 100 }, (_value, index) => ({ id: index + 1, body: "x", user: { login: "u" } }))
        );
      }
      if (endpoint.endsWith("&page=2")) {
        return JSON.stringify([{ id: 101, body: "y", user: { login: "u", type: "User" } }]);
      }
      if (args.includes("POST")) {
        expect(JSON.parse(String(opts?.input))).toEqual({ body: "hello" });
        return JSON.stringify({ id: 55, body: "hello", user: { login: "codegenie[bot]", type: "Bot" } });
      }
      if (args.includes("PATCH")) {
        return "{}";
      }
      if (args.join(" ") === "api user --jq .login") {
        return "peter\n";
      }
      if (endpoint.includes("/collaborators/")) {
        return "write\n";
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const client = createIssueCommentClient("/repo", "acme/widgets", { runGh: gh });

    const comments = await client.listComments(7);
    expect(comments).toHaveLength(101);
    const created = await client.createComment(7, "hello");
    expect(created).toMatchObject({ id: 55, author: "codegenie[bot]", authorType: "Bot" });
    await client.updateComment(55, "updated");
    expect(calls.some((args) => args.includes("PATCH") && (args[1] ?? "").endsWith("/issues/comments/55"))).toBe(true);
    await expect(client.getCollaboratorPermission("alice")).resolves.toBe("write");
    await expect(client.getViewerLogin()).resolves.toBe("peter");
  });

  it("handles empty and installation-token /user responses without hiding authentication failures", async () => {
    const empty = createIssueCommentClient("/repo", "acme/widgets", {
      runGh: async () => "\n"
    });
    await expect(empty.getViewerLogin()).resolves.toBeUndefined();

    const installationToken = createIssueCommentClient("/repo", "acme/widgets", {
      runGh: async () => {
        throw new CodegenieError("gh_auth_failed", "gh: Resource not accessible by integration (HTTP 403)");
      }
    });
    await expect(installationToken.getViewerLogin()).resolves.toBeUndefined();

    const badCredentials = createIssueCommentClient("/repo", "acme/widgets", {
      runGh: async () => {
        throw new CodegenieError("gh_auth_failed", "gh: Bad credentials (HTTP 401)");
      }
    });
    await expect(badCredentials.getViewerLogin()).rejects.toMatchObject({ code: "gh_auth_failed" });
  });

  it("rejects malformed repository names", () => {
    expect(() => createIssueCommentClient("/repo", "not-a-repo")).toThrow(/invalid repository name/u);
  });
});

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  needs?: string;
  if?: string;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  steps?: WorkflowStep[];
};

type WorkflowDocument = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean | string };
  jobs: Record<string, WorkflowJob>;
};

describe("GitHub Action and workflow contracts", () => {
  const workflowPaths = [
    ".github/workflows/codegenie-review.yml",
    "examples/workflows/codegenie-review-comment.yml",
    "examples/workflows/codegenie-review-pr.yml"
  ];

  it("forwards preflight and bot identity inputs through the composite action", () => {
    const raw = readFileSync(path.resolve("action.yml"), "utf8");
    const action = parseYaml(raw) as {
      inputs: Record<string, { description?: string }>;
      outputs: Record<string, { value?: string }>;
      runs: { steps: WorkflowStep[] };
    };
    expect(action.inputs["on-pull-request"]?.description).toContain("ready_for_review");
    expect(action.inputs["bot-login"]).toBeDefined();
    expect(action.inputs["preflight-only"]).toBeDefined();
    expect(action.outputs["should-run"]?.value).toContain("steps.run.outputs.should-run");
    expect(action.outputs["pr-number"]?.value).toContain("steps.run.outputs.pr-number");

    const runStep = action.runs.steps.find((step) => step.id === "run");
    expect(runStep?.run).toContain('args+=(--bot-login "$INPUT_BOT_LOGIN")');
    expect(runStep?.run).toContain('args+=(--preflight-only "$INPUT_PREFLIGHT_ONLY")');
  });

  it("keeps authorization in the binary and one newest-event-wins concurrency policy", () => {
    const documents = workflowPaths.map((workflowPath) => {
      const raw = readFileSync(path.resolve(workflowPath), "utf8");
      // Authorization lives only in the codegenie binary; any YAML phrase or
      // association matching is a dual source of truth and forbidden.
      expect(raw, workflowPath).not.toContain("startsWith(");
      expect(raw, workflowPath).not.toContain("author_association");
      const workflow = parseYaml(raw) as WorkflowDocument;
      expect(workflow.jobs.preflight, workflowPath).toBeUndefined();
      expect(workflow.jobs.review, workflowPath).toBeDefined();
      expect(workflow.concurrency?.group, workflowPath).toContain("codegenie-review-pr-");
      // Owner decision: uniform cancel-in-progress — newest event wins.
      expect(workflow.concurrency?.["cancel-in-progress"], workflowPath).toBe(true);
      return workflow;
    });
    const commentExample = documents[1];
    const commentReviewStep = commentExample?.jobs.review?.steps?.find((step) => step.uses?.startsWith("0xPolygon/codegenie@"));
    expect(commentReviewStep?.with?.["trigger-phrase"]).toBe("codegenie review");
  });

  it("pins pull-request jobs to the base SHA and leaves comment jobs on the default branch", () => {
    const dogfood = parseYaml(readFileSync(path.resolve(workflowPaths[0] ?? ""), "utf8")) as WorkflowDocument;
    const prExample = parseYaml(readFileSync(path.resolve(workflowPaths[2] ?? ""), "utf8")) as WorkflowDocument;
    const commentExample = parseYaml(readFileSync(path.resolve(workflowPaths[1] ?? ""), "utf8")) as WorkflowDocument;
    const dogfoodCheckout = dogfood.jobs.review?.steps?.find((step) => step.uses === "actions/checkout@v7");
    expect(dogfoodCheckout?.with?.ref).toContain("github.event.pull_request.base.sha || ''");
    const prCheckout = prExample.jobs.review?.steps?.find((step) => step.uses === "actions/checkout@v7");
    expect(prCheckout?.with?.ref).toContain("github.event.pull_request.base.sha");
    const commentCheckout = commentExample.jobs.review?.steps?.find((step) => step.uses === "actions/checkout@v7");
    expect(commentCheckout?.with?.ref).toBeUndefined();
  });

  it("runs standalone CI against the PR head with actionlint available before every gate", () => {
    const ciPath = ".github/workflows/ci.yml";
    const raw = readFileSync(path.resolve(ciPath), "utf8");
    const workflow = parseYaml(raw) as WorkflowDocument;
    const steps = workflow.jobs.ci?.steps ?? [];

    const checkoutIndex = steps.findIndex((step) => step.uses === "actions/checkout@v7");
    const nodeIndex = steps.findIndex((step) => step.uses === "actions/setup-node@v7");
    const pnpmIndex = steps.findIndex((step) => step.uses === "pnpm/action-setup@v4");
    const actionlintIndex = steps.findIndex((step) => step.name === "Install actionlint");
    const installIndex = steps.findIndex((step) => step.run?.trim() === "pnpm install --frozen-lockfile");
    const checkIndex = steps.findIndex((step) => step.run?.trim() === "pnpm run check");
    const testIndex = steps.findIndex((step) => step.run?.trim() === "pnpm test");
    const buildIndex = steps.findIndex((step) => step.run?.trim() === "pnpm build");

    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(steps[checkoutIndex]?.with?.ref).toContain("github.event.pull_request.head.sha");
    expect(steps[checkoutIndex]?.with?.ref).not.toContain("base.sha");
    expect(steps[nodeIndex]?.with?.["node-version"]).toBe("26");
    expect(steps[pnpmIndex]?.with?.version).toBe("11.15.1");

    const actionlintStep = steps[actionlintIndex];
    expect(actionlintStep?.env?.ACTIONLINT_VERSION).toBe("1.7.12");
    expect(actionlintStep?.env?.ACTIONLINT_SHA256).toBe(
      "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
    );
    expect(actionlintStep?.run).toContain("actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz");
    expect(actionlintStep?.run).toContain("sha256sum --check");
    expect(actionlintStep?.run).toContain('>> "${GITHUB_PATH}"');
    expect(actionlintStep?.run).toContain('"${install_dir}/actionlint" -version');

    expect(raw).not.toContain("--ignore-scripts");
    expect(nodeIndex).toBeGreaterThan(checkoutIndex);
    expect(pnpmIndex).toBeGreaterThan(nodeIndex);
    expect(actionlintIndex).toBeGreaterThan(pnpmIndex);
    expect(installIndex).toBeGreaterThan(actionlintIndex);
    expect(checkIndex).toBeGreaterThan(installIndex);
    expect(testIndex).toBeGreaterThan(checkIndex);
    expect(buildIndex).toBeGreaterThan(testIndex);
  });
});

describe("github client viewer-identity fallback", () => {
  const original = process.env.CODEGENIE_GITHUB_LOGIN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CODEGENIE_GITHUB_LOGIN;
    } else {
      process.env.CODEGENIE_GITHUB_LOGIN = original;
    }
  });

  function ghWithFailingUser(comments: unknown[]): RunGh {
    return async (_repoRoot, args) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "acme" }, name: "widgets" });
      }
      if (args.join(" ") === "api user --jq .login") {
        throw new CodegenieError("gh_auth_failed", "installation tokens have no /user");
      }
      if (args[0] === "api" && String(args[1]).includes("/pulls/7/comments")) {
        return JSON.stringify(comments);
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
  }

  it("uses the injected login when gh api user fails", async () => {
    process.env.CODEGENIE_GITHUB_LOGIN = "codegenie[bot]";
    const client = createGitHubClient("/repo", {
      runGh: ghWithFailingUser([
        { id: 1, path: "a.ts", side: "RIGHT", line: 3, body: "mine", user: { login: "codegenie[bot]" } },
        { id: 2, path: "b.ts", side: "RIGHT", line: 9, body: "theirs", user: { login: "alice" } }
      ])
    });
    const own = await client.listOwnComments(7);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: "1", author: "codegenie[bot]" });
  });

  it("still fails without an injected login", async () => {
    delete process.env.CODEGENIE_GITHUB_LOGIN;
    const client = createGitHubClient("/repo", { runGh: ghWithFailingUser([]) });
    await expect(client.listOwnComments(7)).rejects.toMatchObject({ code: "gh_auth_failed" });
  });
});
