# Source adjudication for campaign matchers

The campaign's raw `matchExpectation` result checks fields such as anchor, severity and wording. It can accept a different mechanism at the same location or reject an accurate paraphrase. Issue #127 already marks lexical-only results and anchored lexical misses for adjudication in the normal eval scorer. A location match still does not prove that the finding states the oracle's mechanism.

For a future campaign, run `pnpm exec tsx scripts/eval-adjudication-queue.ts <pinned case directory> <telemetry directory>` on offline copies of the case and telemetry artifacts. Save the JSON as a machine lead list. It records raw positive matches and lexical misses within the expected file or line range separately for candidates and published findings, without assigning credit. The normal eval matcher and scores stay available as raw data.

Have an analyst compare leads against the pinned diff and oracle and record the adjudicated outcome independently. Read relevant source and other findings too. Wrong-anchor matches, absent findings, materially different mechanisms, and negative controls still require the campaign's normal source review. Freeze matcher inputs and this review procedure before a campaign starts. Do not use the queue to rewrite a sealed campaign's scores.
