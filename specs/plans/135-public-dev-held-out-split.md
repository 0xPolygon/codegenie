# Fixed public development and confirmation sets

The population is the 51 distinct base-to-head diffs in the Plan 134 public registry, SHA-256 27c86b861f09a2f3eb1f809a13becd6f4617991bf791c9abdab3fb7fd97f85f1. The unit sampled is a diff, including all of its required causes. Both arms review the same diff.

## Frozen draw

Seed `134-20-31-v1`. Each case belongs to the first eligible stratum below. Sort each stratum by the unsigned bytewise SHA-256 digest of UTF-8 `seed|stratum|case-id`, without a trailing newline, and select its first four. The exploratory controls have a quota of zero. Classifications use the pre-134 registry and historical case list. Plan 134 arm outcomes play no part.

| Stratum | Eligibility | Selected case IDs |
|---|---|---|
| hard | Nonempty registered hard cause | cg-01, cg-03, cg-10, go-07 |
| reliable | Nonempty registered reliable cause after hard cases are assigned | go-02, go-08, go-09, pi-05 |
| mixed | Historical mixed list cg-05, cg-06, cg-07, cg-08, go-05, go-06, pi-03 | cg-06, cg-07, go-06, pi-03 |
| other positive | Other remaining required-positive diffs | go-14, pi-08, pi-12, pi-16 |
| clean control | Registered clean control | cg-n2, cg-n3, cg-n5, go-10 |
| exploratory control | Registered contaminated controls, outside clean false-claim endpoint | None |

**Held out (31).** cg-02, cg-04, cg-05, cg-08, cg-09, cg-11, cg-12, cg-13, cg-n1, cg-n4, go-01, go-03, go-04, go-05, go-11, go-12, go-13, go-n1, pi-01, pi-04, pi-06, pi-07, pi-09, pi-10, pi-13, pi-14, pi-15, pi-n1, pi-n2, pi-n3, pi-n4.

## Reproducing the draw from Git

Use the case directory names under `evals/public` at corpus commit `6cc63d8961c61068f6124a180fd436b8335d6230`. The exact stratum strings for hashing appear in the first column above, including their spaces. The frozen hard list is cg-01, cg-03, cg-04, cg-09, cg-10, go-01, go-07, pi-07. The reliable list is cg-10, go-02, go-04, go-08, go-09, pi-01, pi-05, pi-06, pi-10. Assign cg-10 to hard by precedence. Use the mixed list in the table. The clean controls are cg-n1, cg-n2, cg-n3, cg-n4, cg-n5, go-10, go-n1, pi-n1, pi-n4. The exploratory controls are go-11, pi-n2, pi-n3. All remaining cases belong to `other positive`.

Strata determine membership once. Later label corrections apply to scoring at the revision registered for the comparison. For example, go-14 stays in development and pi-07 stays held out when their expectations become optional. The fourth development control, go-10, tests the streaming decoder's byte-parity contract.

## Future measurements

Before each comparison, freeze the current-best baseline and one general change, case and label revision, pairing and order seed, cost cap, failure policy, primary endpoint and what counts as ambiguous. One draw per arm on all 20 diffs gives 40 reviews. If the registered ambiguity condition holds, add the second paired draw for all 20. Keep full debug and the provider-health gate. Two blind analysts lock and reconcile by opaque review ID before unblinding. Report source-adjudicated raises, publications, clean-control false claims, earliest loss, incomplete outcomes, and paired wall time, calls and cost.

A dev improvement advances to a separately registered held-out confirmation before release. Keep confirmation results out of prompt design and case selection. Contaminated controls remain exploratory. Prior public-suite history and Plan 134 inspected some held-out cases, so this split reserves them for future confirmation without making them historically unseen. The operator stopped evaluation dispatch pending the team decision.
