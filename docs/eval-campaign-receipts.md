# Review receipts for future three-arm campaigns

Read settled artifacts with `pnpm exec tsx scripts/eval-campaign-receipts.ts`. Run this from the Codegenie checkout and use copies of receipt artifacts for offline validation. The script reads inputs and emits JSON to standard output.

- **Review**. Pass `review <run.json> <events.jsonl> <stage7-capture.json>`. The final capture has a `result` array of packet results. Persist the returned status and Stage 7 counts alongside the attempt's binding, arm, block, case, draw, attempt number and existing physical call, wall-time and spend accounting. An accepted incomplete result retains `completed_partial`. A finished worker can submit incomplete even if a later pass completes its packet, so keep both counts.
- **Block**. Pass `block <A receipt> <B receipt> <C receipt>`. Each receipt must refer to the same bound draw. Keep all three receipts and their accounting in the funnel. A partial pairing contributes to health and spend, and is excluded from complete paired quality. Include `stage7.incompleteWorkerSubmissions` and `stage7.incompleteFinalPackets` for each arm in the health table. Check `satisfiesCompleteCoverage` before applying the ship rule.
- **Retry**. Pass `retry <arm directory>`. It reads the first terminal attempt and its separately verified retry approval, bound to the same configuration and the exact failed receipt. An existing second attempt prevents admission. Only a separately classified `infrastructure_failure` can be retried. Keep the first attempt and all original artifacts.

The launcher owns order, budget and sealing. It should advance through the frozen schedule after recording either pairing status. These checks are for future campaign bindings. The Plan 134 launcher, draws and receipts remain frozen.
