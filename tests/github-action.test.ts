import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  parseModelSpec
} from "../src/github-action/entrypoint.js";
import type { IssueComment, IssueCommentClient } from "../src/github-action/issue-comments.js";
import { createIssueCommentClient } from "../src/github-action/issue-comments.js";
import { STATUS_COMMENT_MARKER } from "../src/github-action/marker.js";
import { createStatusCommentController } from "../src/github-action/status-comment.js";
import { ISSUE_COMMENT_MAX_CHARS, TRUNCATION_DISCLOSURE } from "../src/github-action/render.js";
import { createGitHubClient } from "../src/github/github-client.js";
import type { runGh } from "../src/git/subprocess.js";
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
  | { kind: "permission"; login: string };

function createFakeComments(opts: {
  existing?: IssueComment[];
  permission?: string;
  failUpdates?: boolean;
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
    }
  };
  return { client, calls };
}

function stageEvent(message: "stage_started" | "stage_completed", stage: number): Parameters<ReturnType<typeof createStatusCommentController>["onTelemetryEvent"]>[0] {
  return { stage: stage as 1, level: "info", message };
}

describe("status comment controller", () => {
  it("creates the comment when none exists and reclaims its own marker comment on rerun", async () => {
    const fresh = createFakeComments();
    const controller = createStatusCommentController({ comments: fresh.client, prNumber: 7 });
    const claimed = await controller.claim();
    expect(claimed.author).toBe("codegenie[bot]");
    expect(fresh.calls[1]).toMatchObject({ kind: "create", issueNumber: 7 });
    expect((fresh.calls[1] as { body: string }).body).toContain(STATUS_COMMENT_MARKER);
    expect(controller.stats().claimed).toBe("created");

    const rerun = createFakeComments({
      existing: [
        { id: 1, body: `spoof ${STATUS_COMMENT_MARKER}`, author: "mallory" },
        { id: 2, body: `old status ${STATUS_COMMENT_MARKER}`, author: "codegenie[bot]" }
      ]
    });
    const rerunController = createStatusCommentController({ comments: rerun.client, prNumber: 7 });
    const reclaimed = await rerunController.claim();
    expect(reclaimed.commentId).toBe(2);
    expect(rerunController.stats().claimed).toBe("reclaimed");
    expect(rerun.calls[1]).toMatchObject({ kind: "update", commentId: 2 });
  });

  it("never reclaims a human-authored marker comment even with ownLogin resolved", async () => {
    const fake = createFakeComments({
      existing: [{ id: 1, body: `spoof ${STATUS_COMMENT_MARKER}`, author: "mallory" }]
    });
    const controller = createStatusCommentController({ comments: fake.client, prNumber: 7, ownLogin: "codebot" });
    await controller.claim();
    expect(controller.stats().claimed).toBe("created");
  });

  it("throttles progress edits and renders the stage checklist", async () => {
    let clock = 0;
    const fake = createFakeComments();
    const controller = createStatusCommentController({
      comments: fake.client,
      prNumber: 7,
      minEditIntervalMs: 10_000,
      now: () => clock
    });
    await controller.claim();

    controller.onTelemetryEvent(stageEvent("stage_started", 1));
    await controller.settle();
    expect(fake.calls.filter((call) => call.kind === "update")).toHaveLength(0);
    expect(controller.stats().throttledCount).toBe(1);

    clock = 15_000;
    controller.onTelemetryEvent(stageEvent("stage_started", 5));
    await controller.settle();
    const updates = fake.calls.filter((call) => call.kind === "update") as Array<{ body: string }>;
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body).toContain("☑ resolving input");
    expect(updates[0]?.body).toContain("▸ planning review");
    expect(updates[0]?.body).toContain("☐ verifying findings");
    expect(controller.stats().editCount).toBe(1);
  });

  it("goes headless after repeated edit failures but still lands the terminal edit", async () => {
    let clock = 0;
    let failUpdates = true;
    const calls: FakeCommentCall[] = [];
    const client: IssueCommentClient = {
      async listComments() {
        return [];
      },
      async createComment(issueNumber, body) {
        calls.push({ kind: "create", issueNumber, body });
        return { id: 9, body, author: "codegenie[bot]" };
      },
      async updateComment(commentId, body) {
        calls.push({ kind: "update", commentId, body });
        if (failUpdates) {
          throw new CodegenieError("github_post_failed", "boom");
        }
      },
      async getCollaboratorPermission() {
        return "write";
      }
    };
    const controller = createStatusCommentController({
      comments: client,
      prNumber: 7,
      minEditIntervalMs: 0,
      maxConsecutiveEditFailures: 2,
      now: () => (clock += 10)
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
  });

  it("sanitizes the terminal report, appends the marker after sanitization, and links the run", async () => {
    const fake = createFakeComments();
    const controller = createStatusCommentController({
      comments: fake.client,
      prNumber: 7,
      runUrl: "https://github.com/acme/widgets/actions/runs/42"
    });
    await controller.claim();
    await controller.finalizeSuccess("# review\n\nping @alice <!-- sneaky --> done");
    const terminal = fake.calls.at(-1) as { body: string };
    expect(terminal.body).toContain("`@alice`");
    expect(terminal.body).not.toContain("sneaky");
    expect(terminal.body).toContain(STATUS_COMMENT_MARKER);
    expect(terminal.body).toContain("actions/runs/42");
    expect(terminal.body.indexOf(STATUS_COMMENT_MARKER)).toBeGreaterThan(terminal.body.indexOf("done"));
    expect(controller.stats().terminalState).toBe("report");
  });

  it("caps oversized terminal reports with a disclosure", async () => {
    const fake = createFakeComments();
    const controller = createStatusCommentController({ comments: fake.client, prNumber: 7 });
    await controller.claim();
    const report = `# review\n\n${"finding line\n".repeat(9_000)}`;
    await controller.finalizeSuccess(report);
    const terminal = fake.calls.at(-1) as { body: string };
    expect(terminal.body.length).toBeLessThanOrEqual(ISSUE_COMMENT_MAX_CHARS);
    expect(terminal.body).toContain(TRUNCATION_DISCLOSURE);
    expect(terminal.body).toContain(STATUS_COMMENT_MARKER);
    expect(controller.stats().terminalState).toBe("report_truncated");
    expect(controller.stats().finalBodyBytesBeforeCap).toBeGreaterThan(ISSUE_COMMENT_MAX_CHARS);
  });

  it("posts a failure terminal state and reports edit failure without throwing", async () => {
    const ok = createFakeComments();
    const controller = createStatusCommentController({ comments: ok.client, prNumber: 7 });
    await controller.claim();
    await expect(controller.finalizeFailure("llm_call_failed")).resolves.toBe(true);
    const terminal = ok.calls.at(-1) as { body: string };
    expect(terminal.body).toContain("`llm_call_failed`");
    expect(controller.stats().terminalState).toBe("failure");

    const failing = createFakeComments({ failUpdates: true });
    const failingController = createStatusCommentController({ comments: failing.client, prNumber: 7 });
    // claim's initial write is a create, which succeeds even when updates fail
    failing.calls.length = 0;
    await failingController.claim();
    await expect(failingController.finalizeFailure("timeout")).resolves.toBe(false);
  });
});

describe("github-action entrypoint", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "codegenie-gha-"));

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
        hooks.writeOutput("# review report\n\nno findings\n");
        return { runId: "r1", runDir };
      }
    });

    expect(reviewArgv).toEqual([
      "review", "--pr", "7", "--ci", "--post-github-comments", "--depth", "deep", "--lens", "security"
    ]);
    expect(env.CODEGENIE_GITHUB_LOGIN).toBe("codegenie[bot]");
    expect(fake.calls[0]).toMatchObject({ kind: "permission" });
    expect(fake.calls[1]).toMatchObject({ kind: "list" });
    expect(fake.calls[2]).toMatchObject({ kind: "create" });
    const terminal = fake.calls.at(-1) as { kind: string; body: string };
    expect(terminal.kind).toBe("update");
    expect(terminal.body).toContain("# review report");
    expect(terminal.body).toContain(STATUS_COMMENT_MARKER);
    expect(readFileSync(reportPath, "utf8")).toContain("# review report");
    const record = JSON.parse(readFileSync(path.join(runDir, "github-action.json"), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ lane: "issue_comment", prNumber: 7, actor: "alice" });
    expect(output).toContain("review complete");
  });

  it("posts a failure terminal state and rethrows when the review fails", async () => {
    const fake = createFakeComments();
    await expect(
      executeGitHubActionCommand([], {
        env: actionEnv(pullRequestPayload(), "pull_request"),
        issueComments: fake.client,
        minEditIntervalMs: 0,
        writeOutput: () => undefined,
        runReview: async () => {
          throw new CodegenieError("llm_call_failed", "provider down");
        }
      })
    ).rejects.toMatchObject({ code: "llm_call_failed" });
    const terminal = fake.calls.at(-1) as { kind: string; body: string };
    expect(terminal.kind).toBe("update");
    expect(terminal.body).toContain("`llm_call_failed`");
  });

  it("disables inline posting when post-inline-comments is false", async () => {
    const fake = createFakeComments();
    let reviewArgv: string[] = [];
    await executeGitHubActionCommand(["--post-inline-comments", "false"], {
      env: actionEnv(issueCommentPayload(), "issue_comment"),
      issueComments: fake.client,
      minEditIntervalMs: 0,
      writeOutput: () => undefined,
      runReview: async (argv, hooks) => {
        reviewArgv = argv;
        hooks.writeOutput("# report");
        return { runId: "r1", runDir: "" };
      }
    });
    expect(reviewArgv).not.toContain("--post-github-comments");
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
      runReview: async (argv, hooks) => {
        reviewArgv = argv;
        hooks.writeOutput("# report");
        return { runId: "r1", runDir: "" };
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
      "--depth", ""
    ]);
    expect(parsed.allowedAssociations).toEqual(["OWNER", "MEMBER"]);
    expect(parsed.allowedUsers).toEqual(["alice", "bob"]);
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
  });

  it("rejects malformed repository names", () => {
    expect(() => createIssueCommentClient("/repo", "not-a-repo")).toThrow(/invalid repository name/u);
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
