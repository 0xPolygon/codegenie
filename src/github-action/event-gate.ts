// Pure trigger/authorization decisions over GitHub webhook payloads. No IO:
// the live collaborator-permission re-check happens in the entrypoint, this
// module only reads the (attacker-visible) payload. Comment text is matched,
// never interpreted — trailing text after the trigger phrase is ignored and
// review knobs come exclusively from workflow inputs.

export const DEFAULT_TRIGGER_PHRASE = "codegenie review";
export const DEFAULT_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
// ready_for_review completes the draft story: drafts skip, so the moment a
// draft is marked ready must itself trigger the review.
const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "ready_for_review"]);

export type TriggerRules = {
  triggerPhrase: string;
  onPullRequest: boolean;
  allowedAssociations: string[];
  allowedUsers: string[];
};

export type TriggerDecision =
  | {
      run: true;
      lane: "pull_request" | "issue_comment";
      prNumber: number;
      actor: string;
      association: string;
      // Users explicitly allowlisted by workflow input skip the live
      // write-permission re-check; association-gated actors do not.
      actorAllowlisted: boolean;
    }
  | { run: false; reason: string };

export function decideTrigger(eventName: string, payload: unknown, rules: TriggerRules): TriggerDecision {
  if (!isRecord(payload)) {
    return skip("event payload is not an object");
  }
  if (eventName === "pull_request") {
    return decidePullRequest(payload, rules);
  }
  if (eventName === "issue_comment") {
    return decideIssueComment(payload, rules);
  }
  return skip(`unsupported event: ${eventName}`);
}

export function matchesTriggerPhrase(body: string, phrase: string): boolean {
  const trimmed = body.trim();
  const trimmedPhrase = phrase.trim();
  if (trimmedPhrase === "" || !trimmed.startsWith(trimmedPhrase)) {
    return false;
  }
  const rest = trimmed.slice(trimmedPhrase.length);
  return rest === "" || /^\s/u.test(rest);
}

function decidePullRequest(payload: Record<string, unknown>, rules: TriggerRules): TriggerDecision {
  if (!rules.onPullRequest) {
    return skip("pull_request lane disabled by workflow input");
  }
  const action = stringAt(payload, ["action"]);
  if (action === undefined || !PULL_REQUEST_ACTIONS.has(action)) {
    return skip(`unsupported pull_request action: ${action ?? "unknown"}`);
  }
  const pullRequest = recordAt(payload, ["pull_request"]);
  if (pullRequest === undefined) {
    return skip("payload has no pull_request");
  }
  if (pullRequest.draft === true) {
    return skip("draft pull request");
  }
  const repoFullName = stringAt(payload, ["repository", "full_name"]);
  const headRepoFullName = stringAt(pullRequest, ["head", "repo", "full_name"]);
  if (repoFullName === undefined || headRepoFullName === undefined || headRepoFullName !== repoFullName) {
    // Fork pull_request events run without secrets and with a read-only
    // token: provider auth and posting are both impossible. The comment lane
    // (base-repo context, write-gated) is the supported path for fork PRs.
    return skip("fork pull request — use the comment trigger lane instead");
  }
  const prNumber = numberAt(pullRequest, ["number"]) ?? numberAt(payload, ["number"]);
  if (prNumber === undefined) {
    return skip("payload has no pull request number");
  }
  const actor = stringAt(pullRequest, ["user", "login"]) ?? "";
  const association = stringAt(pullRequest, ["author_association"]) ?? "NONE";
  return authorize({ lane: "pull_request", prNumber, actor, association, isBot: userIsBot(pullRequest) }, rules);
}

function decideIssueComment(payload: Record<string, unknown>, rules: TriggerRules): TriggerDecision {
  const action = stringAt(payload, ["action"]);
  if (action !== "created") {
    return skip(`unsupported issue_comment action: ${action ?? "unknown"}`);
  }
  const issue = recordAt(payload, ["issue"]);
  if (issue === undefined || !isRecord(issue.pull_request)) {
    return skip("comment is not on a pull request");
  }
  const comment = recordAt(payload, ["comment"]);
  if (comment === undefined) {
    return skip("payload has no comment");
  }
  const body = stringAt(comment, ["body"]) ?? "";
  if (!matchesTriggerPhrase(body, rules.triggerPhrase)) {
    return skip("comment does not match the trigger phrase");
  }
  if (stringAt(issue, ["state"]) === "closed") {
    return skip("pull request is closed");
  }
  const prNumber = numberAt(issue, ["number"]);
  if (prNumber === undefined) {
    return skip("payload has no pull request number");
  }
  const actor = stringAt(comment, ["user", "login"]) ?? "";
  const association = stringAt(comment, ["author_association"]) ?? "NONE";
  return authorize({ lane: "issue_comment", prNumber, actor, association, isBot: userIsBot(comment) }, rules);
}

function authorize(
  input: { lane: "pull_request" | "issue_comment"; prNumber: number; actor: string; association: string; isBot: boolean },
  rules: TriggerRules
): TriggerDecision {
  const actorAllowlisted = rules.allowedUsers.some((user) => user.toLowerCase() === input.actor.toLowerCase());
  if (input.isBot && !actorAllowlisted) {
    return skip(`bot actor not allowlisted: ${input.actor}`);
  }
  if (!actorAllowlisted && !rules.allowedAssociations.some((assoc) => assoc.toUpperCase() === input.association.toUpperCase())) {
    return skip(`author association not allowed: ${input.association}`);
  }
  return {
    run: true,
    lane: input.lane,
    prNumber: input.prNumber,
    actor: input.actor,
    association: input.association,
    actorAllowlisted
  };
}

function userIsBot(parent: Record<string, unknown>): boolean {
  return stringAt(parent, ["user", "type"]) === "Bot";
}

function skip(reason: string): TriggerDecision {
  return { run: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(parent: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let current: unknown = parent;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function stringAt(parent: Record<string, unknown>, path: string[]): string | undefined {
  const container = path.length > 1 ? recordAt(parent, path.slice(0, -1)) : parent;
  const value = container?.[path[path.length - 1] ?? ""];
  return typeof value === "string" ? value : undefined;
}

function numberAt(parent: Record<string, unknown>, path: string[]): number | undefined {
  const container = path.length > 1 ? recordAt(parent, path.slice(0, -1)) : parent;
  const value = container?.[path[path.length - 1] ?? ""];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
