import { describe, expect, it } from "vitest";
import {
  canRetryCampaignReview, classifyCampaignBlock, classifyCampaignReview
} from "../scripts/eval-campaign-receipts.js";

describe("future campaign receipt classification", () => {
  const incomplete = { stage: 7, message: "packet_review_incomplete", workerId: "w1", packetId: "p1" } as const;
  const packets = [{ packetId: "p0", status: "completed" }, { packetId: "p1", status: "incomplete" }] as const;
  const tripletIdentity = { block: 5, draw: 1, case: "sample", binding: "frozen", attempt: 1 };

  it("keeps an accepted incomplete submission in the funnel and excludes its triplet from complete quality", () => {
    const full = classifyCampaignReview({ status: "completed_full" }, [], [packets[0]]);
    const partial = classifyCampaignReview({ status: "completed_partial" }, [incomplete, incomplete], [...packets]);
    expect(partial).toEqual({
      status: "completed_partial", stage7: { incompleteWorkerSubmissions: 1, incompleteFinalPackets: 1 }
    });
    const reviews = [
      { arm: "B", ...tripletIdentity, ...full, pricedUSD: 0.10, physicalCalls: 21, wallSeconds: 41 },
      { arm: "C", ...tripletIdentity, ...partial, pricedUSD: 0.15, physicalCalls: 90, wallSeconds: 65 },
      { arm: "A", ...tripletIdentity, ...full, pricedUSD: 0.12, physicalCalls: 24, wallSeconds: 37 }
    ] as const;
    expect(classifyCampaignBlock([...reviews])).toEqual({
      status: "partial_pairing", eligibleForCompletePairedQuality: false, satisfiesCompleteCoverage: false,
      partialArms: ["C"], reviews
    });
    expect(classifyCampaignBlock(reviews.map(review => ({ ...review, ...full })))).toMatchObject({
      status: "complete_pairing", eligibleForCompletePairedQuality: true, satisfiesCompleteCoverage: true
    });
    const approval = { configReverified: true, failedReceipt: "digest", binding: "frozen" };
    expect(canRetryCampaignReview(reviews[1], "digest", approval, false)).toBe(false);
  });

  it("counts a recovered worker separately from final incomplete packets", () => {
    expect(classifyCampaignReview({ status: "completed_full" }, [incomplete], [packets[0]])).toEqual({
      status: "completed_full", stage7: { incompleteWorkerSubmissions: 1, incompleteFinalPackets: 0 }
    });
    expect(() => classifyCampaignReview({ status: "completed_full" }, [incomplete], [...packets])).toThrow(/contradicts/);
  });

  it("requires specifically verified and unretried infrastructure failure", () => {
    const attempt = { ...tripletIdentity, status: "infrastructure_failure" } as const;
    const approval = { configReverified: true, failedReceipt: "digest", binding: "frozen" };
    expect(canRetryCampaignReview(attempt, "digest", approval, false)).toBe(true);
    expect(canRetryCampaignReview(attempt, "different", approval, false)).toBe(false);
    expect(canRetryCampaignReview(attempt, "digest", { ...approval, binding: "changed" }, false)).toBe(false);
    expect(canRetryCampaignReview(attempt, "digest", approval, true)).toBe(false);
    expect(canRetryCampaignReview({ ...attempt, attempt: 2 }, "digest", approval, false)).toBe(false);
    expect(canRetryCampaignReview({ ...attempt, status: "review_failed" }, "digest", approval, false)).toBe(false);
    expect(classifyCampaignReview({ status: "failed" }, [incomplete], [...packets]).status).toBe("review_failed");
  });
});
