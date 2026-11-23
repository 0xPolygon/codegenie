import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PacketReviewResult, RunOutcome, TelemetryEvent } from "../src/types.js";

type ReviewTerminal = "completed_full" | "completed_partial" | "review_failed";
type Classification = {
  status: ReviewTerminal;
  stage7: { incompleteWorkerSubmissions: number; incompleteFinalPackets: number };
};
type Arm = "A" | "B" | "C";
type SealedReview = {
  arm: Arm;
  block: number;
  draw: number;
  case: string;
  binding: string;
  status: ReviewTerminal | "infrastructure_failure";
  attempt: number;
  stage7: Classification["stage7"];
};
type RetryApproval = { configReverified: boolean; failedReceipt: string; binding: string };

const arms = ["A", "B", "C"] as const;

export function classifyCampaignReview(
  outcome: Pick<RunOutcome, "status">,
  events: Pick<TelemetryEvent, "stage" | "message" | "workerId" | "packetId">[],
  packets: Pick<PacketReviewResult, "status" | "reviewStatus" | "packetId">[]
): Classification {
  const incompleteWorkers = new Set<string>();
  for (const event of events) {
    if (event.stage !== 7 || event.message !== "packet_review_incomplete") continue;
    if (event.workerId === undefined || event.packetId === undefined) {
      throw new Error("Incomplete Stage 7 event has no worker or packet identity.");
    }
    incompleteWorkers.add(JSON.stringify([event.packetId, event.workerId]));
  }
  const incompletePackets = new Set(packets
    .filter(packet => packet.status === "incomplete" || packet.reviewStatus === "incomplete")
    .map(packet => packet.packetId));
  const stage7 = {
    incompleteWorkerSubmissions: incompleteWorkers.size,
    incompleteFinalPackets: incompletePackets.size
  };
  switch (outcome.status) {
    case "failed": return { status: "review_failed", stage7 };
    case "completed_partial": return { status: "completed_partial", stage7 };
    case "completed_full":
      if (incompletePackets.size > 0) throw new Error("Complete outcome contradicts the final Stage 7 packet results.");
      return { status: "completed_full", stage7 };
    default: throw new Error("Unknown or unsealed review outcome.");
  }
}

export function classifyCampaignBlock(reviews: SealedReview[]) {
  const first = reviews[0];
  if (reviews.length !== arms.length || first === undefined || !arms.every(arm => reviews.some(review => review.arm === arm))) {
    throw new Error("A block requires one sealed receipt for each arm.");
  }
  for (const review of reviews) {
    if (review.binding !== first.binding || review.block !== first.block || review.draw !== first.draw || review.case !== first.case) {
      throw new Error("Arm receipts do not identify the same bound block.");
    }
    if (review.status !== "completed_full" && review.status !== "completed_partial") {
      throw new Error("The block still contains a failed attempt requiring reconciliation.");
    }
  }
  const partialArms = reviews.filter(review => review.status === "completed_partial").map(review => review.arm).sort();
  const complete = partialArms.length === 0;
  return {
    status: complete ? "complete_pairing" : "partial_pairing",
    eligibleForCompletePairedQuality: complete,
    satisfiesCompleteCoverage: complete,
    partialArms,
    // Preserve each entire receipt, including the existing call/time/spend accounting.
    reviews
  };
}

export function canRetryCampaignReview(
  attempt: Pick<SealedReview, "attempt" | "binding" | "status">,
  attemptDigest: string,
  approval: RetryApproval | undefined,
  retryExists: boolean
): boolean {
  return attempt.status === "infrastructure_failure" && attempt.attempt === 1 && !retryExists
    && approval?.configReverified === true && approval.binding === attempt.binding
    && approval.failedReceipt === attemptDigest;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main([command, ...paths]: string[]): unknown {
  if (command === "review" && paths.length === 3) {
    const [runPath, eventsPath, capturePath] = paths as [string, string, string];
    const { outcome } = readJson<{ outcome: RunOutcome }>(runPath);
    const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as TelemetryEvent);
    const { result } = readJson<{ result: PacketReviewResult[] }>(capturePath);
    return classifyCampaignReview(outcome, events, result);
  }
  if (command === "block" && paths.length === 3) {
    return classifyCampaignBlock(paths.map(path => readJson<SealedReview>(path)));
  }
  if (command === "retry" && paths.length === 1) {
    const receipt = readFileSync(join(paths[0]!, "attempt-01", "receipt.json"));
    const approval = join(paths[0]!, "verified-retry.json");
    return {
      retryAllowed: canRetryCampaignReview(JSON.parse(receipt.toString("utf8")),
        createHash("sha256").update(receipt).digest("hex"),
        existsSync(approval) ? readJson<RetryApproval>(approval) : undefined,
        existsSync(join(paths[0]!, "attempt-02")))
    };
  }
  throw new Error("Use review <run.json> <events.jsonl> <stage7-capture.json>, block <A receipt> <B receipt> <C receipt>, or retry <arm directory>.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
}
