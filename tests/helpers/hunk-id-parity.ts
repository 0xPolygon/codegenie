export type HunkIdParityFixture = {
  metadata: {
    caseName: string;
    caseHash: string;
    sourceRun: number;
    runId: string;
    status: "pass";
    idFormat: "full" | "short";
  };
  diff: Array<{
    id: string;
    hunkHash?: string;
    path: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    header: string;
    changedNewLineNumbers: number[];
    changedOldLineNumbers: number[];
    changedLines: string[];
  }>;
  planCoverage: Array<{
    hunkId: string;
    path: string;
    coverage: string;
    lenses: string[];
    reason: string;
  }>;
  packets: Array<{
    id: string;
    path: string;
    kind: string;
    coverage: string;
    lenses: string[];
    hunkIds: string[];
  }>;
  candidates: Array<{
    id: string;
    path: string;
    title: string;
    category: string;
    severity: string;
    confidence: string;
    anchor: { hunkId: string; path: string; line: number; side: "RIGHT" | "LEFT" };
    packetId: string;
  }>;
  verdicts: Array<{
    candidateId: string;
    gate: string;
    verdict: string;
    reason: string;
  }>;
  coverageRecords: Array<{
    hunkId: string;
    path: string;
    coverage: string;
    source: string;
    status: string;
  }>;
  finalFindings: Array<{
    id: string;
    path: string;
    title: string;
    category: string;
    severity: string;
    confidence: string;
    anchor: { hunkId: string; path: string; line: number; side: "RIGHT" | "LEFT" };
    packetId: string;
    mergedCandidateIds: string[];
    publication: string;
    fingerprint: string;
  }>;
};

type IdMap = Map<string, string>;

export type HunkIdParityResult = {
  hunkBijection: IdMap;
  packetBijection: IdMap;
  candidateBijection: IdMap;
  baseline: unknown;
  current: unknown;
};

export function normalizeCrossVersionHunkIds(
  baseline: HunkIdParityFixture,
  current: HunkIdParityFixture
): HunkIdParityResult {
  const baselineHunkKeys = identityKeys(baseline.diff, (hunk) => hunk.id, hunkSemanticKey, "baseline hunk");
  const currentHunkKeys = identityKeys(current.diff, (hunk) => hunk.id, hunkSemanticKey, "current hunk");
  assertSameSemanticSet("hunk", baselineHunkKeys, currentHunkKeys);

  const baselinePacketKeys = identityKeys(
    baseline.packets,
    (packet) => packet.id,
    (packet) => packetSemanticKey(packet, baselineHunkKeys),
    "baseline packet"
  );
  const currentPacketKeys = identityKeys(
    current.packets,
    (packet) => packet.id,
    (packet) => packetSemanticKey(packet, currentHunkKeys),
    "current packet"
  );
  assertSameSemanticSet("packet", baselinePacketKeys, currentPacketKeys);

  const baselineCandidateKeys = identityKeys(
    baseline.candidates,
    (candidate) => candidate.id,
    (candidate) => candidateSemanticKey(candidate, baselineHunkKeys, baselinePacketKeys),
    "baseline candidate"
  );
  const currentCandidateKeys = identityKeys(
    current.candidates,
    (candidate) => candidate.id,
    (candidate) => candidateSemanticKey(candidate, currentHunkKeys, currentPacketKeys),
    "current candidate"
  );
  assertSameSemanticSet("candidate", baselineCandidateKeys, currentCandidateKeys);

  validateReferences(baseline, baselineHunkKeys, baselinePacketKeys, baselineCandidateKeys);
  validateReferences(current, currentHunkKeys, currentPacketKeys, currentCandidateKeys);

  return {
    hunkBijection: crossVersionBijection(baselineHunkKeys, currentHunkKeys),
    packetBijection: crossVersionBijection(baselinePacketKeys, currentPacketKeys),
    candidateBijection: crossVersionBijection(baselineCandidateKeys, currentCandidateKeys),
    baseline: normalizeFixture(baseline, baselineHunkKeys, baselinePacketKeys, baselineCandidateKeys),
    current: normalizeFixture(current, currentHunkKeys, currentPacketKeys, currentCandidateKeys)
  };
}

function validateReferences(fixture: HunkIdParityFixture, hunks: IdMap, packets: IdMap, candidates: IdMap): void {
  for (const decision of fixture.planCoverage) {
    mapped(hunks, decision.hunkId, "plan coverage hunk");
  }
  for (const record of fixture.coverageRecords) {
    mapped(hunks, record.hunkId, "coverage record hunk");
  }
  for (const packet of fixture.packets) {
    for (const hunkId of packet.hunkIds) {
      mapped(hunks, hunkId, "packet hunk");
    }
  }
  for (const candidate of fixture.candidates) {
    mapped(packets, candidate.packetId, "candidate packet");
    validateAnchor(candidate.anchor, fixture, hunks);
  }
  for (const verdict of fixture.verdicts) {
    mapped(candidates, verdict.candidateId, "verdict candidate");
  }
  for (const finding of fixture.finalFindings) {
    mapped(candidates, finding.id, "final finding candidate");
    mapped(packets, finding.packetId, "final finding packet");
    validateAnchor(finding.anchor, fixture, hunks);
    for (const candidateId of finding.mergedCandidateIds) {
      mapped(candidates, candidateId, "merged candidate");
    }
  }
}

function validateAnchor(
  anchor: HunkIdParityFixture["candidates"][number]["anchor"],
  fixture: HunkIdParityFixture,
  hunks: IdMap
): void {
  mapped(hunks, anchor.hunkId, "anchor hunk");
  const hunk = fixture.diff.find((candidate) => candidate.id === anchor.hunkId);
  if (hunk === undefined || hunk.path !== anchor.path) {
    throw new Error(`anchor path does not match hunk: ${anchor.hunkId}`);
  }
  const changedLines = anchor.side === "RIGHT" ? hunk.changedNewLineNumbers : hunk.changedOldLineNumbers;
  if (!changedLines.includes(anchor.line)) {
    throw new Error(`anchor line is not changed in hunk: ${anchor.hunkId}:${String(anchor.line)}`);
  }
}

function normalizeFixture(fixture: HunkIdParityFixture, hunks: IdMap, packets: IdMap, candidates: IdMap): unknown {
  return {
    diff: sortByJson(fixture.diff.map(({ id, hunkHash: _hunkHash, ...hunk }) => ({ ...hunk, id: mapped(hunks, id, "diff hunk") }))),
    planCoverage: sortByJson(fixture.planCoverage.map((decision) => ({
      ...decision,
      hunkId: mapped(hunks, decision.hunkId, "plan coverage hunk")
    }))),
    packets: sortByJson(fixture.packets.map((packet) => ({
      ...packet,
      id: mapped(packets, packet.id, "packet"),
      hunkIds: packet.hunkIds.map((hunkId) => mapped(hunks, hunkId, "packet hunk")).sort()
    }))),
    candidates: sortByJson(fixture.candidates.map((candidate) => normalizeCandidate(candidate, hunks, packets, candidates))),
    verdicts: sortByJson(fixture.verdicts.map((verdict) => ({
      ...verdict,
      candidateId: mapped(candidates, verdict.candidateId, "verdict candidate")
    }))),
    coverageRecords: sortByJson(fixture.coverageRecords.map((record) => ({
      ...record,
      hunkId: mapped(hunks, record.hunkId, "coverage record hunk")
    }))),
    finalFindings: sortByJson(fixture.finalFindings.map((finding) => ({
      ...finding,
      id: mapped(candidates, finding.id, "final finding candidate"),
      anchor: { ...finding.anchor, hunkId: mapped(hunks, finding.anchor.hunkId, "final finding hunk") },
      packetId: mapped(packets, finding.packetId, "final finding packet"),
      mergedCandidateIds: finding.mergedCandidateIds.map((id) => mapped(candidates, id, "merged candidate")).sort()
    })))
  };
}

function normalizeCandidate(
  candidate: HunkIdParityFixture["candidates"][number],
  hunks: IdMap,
  packets: IdMap,
  candidates: IdMap
): unknown {
  return {
    ...candidate,
    id: mapped(candidates, candidate.id, "candidate"),
    anchor: { ...candidate.anchor, hunkId: mapped(hunks, candidate.anchor.hunkId, "candidate hunk") },
    packetId: mapped(packets, candidate.packetId, "candidate packet")
  };
}

function hunkSemanticKey(hunk: HunkIdParityFixture["diff"][number]): string {
  const { id: _id, hunkHash: _hunkHash, ...semantic } = hunk;
  return JSON.stringify(semantic);
}

function packetSemanticKey(packet: HunkIdParityFixture["packets"][number], hunks: IdMap): string {
  const { id: _id, hunkIds, ...semantic } = packet;
  return JSON.stringify({ ...semantic, hunkIds: hunkIds.map((id) => mapped(hunks, id, "packet hunk")).sort() });
}

function candidateSemanticKey(
  candidate: HunkIdParityFixture["candidates"][number],
  hunks: IdMap,
  packets: IdMap
): string {
  const { id: _id, anchor, packetId, ...semantic } = candidate;
  return JSON.stringify({
    ...semantic,
    anchor: { ...anchor, hunkId: mapped(hunks, anchor.hunkId, "candidate hunk") },
    packetId: mapped(packets, packetId, "candidate packet")
  });
}

function identityKeys<T>(items: T[], id: (item: T) => string, key: (item: T) => string, label: string): IdMap {
  const byId = new Map<string, string>();
  const semanticKeys = new Set<string>();
  for (const item of items) {
    const itemId = id(item);
    const semanticKey = key(item);
    if (byId.has(itemId)) {
      throw new Error(`${label} id is not unique: ${itemId}`);
    }
    if (semanticKeys.has(semanticKey)) {
      throw new Error(`${label} semantic identity is not unique`);
    }
    byId.set(itemId, semanticKey);
    semanticKeys.add(semanticKey);
  }
  return byId;
}

function assertSameSemanticSet(label: string, baseline: IdMap, current: IdMap): void {
  const left = [...baseline.values()].sort();
  const right = [...current.values()].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} semantic identities differ across versions`);
  }
}

function crossVersionBijection(baseline: IdMap, current: IdMap): IdMap {
  const currentByKey = new Map([...current.entries()].map(([id, key]) => [key, id]));
  return new Map([...baseline.entries()].map(([id, key]) => [id, mapped(currentByKey, key, "cross-version identity")]));
}

function mapped(map: IdMap, id: string, label: string): string {
  const result = map.get(id);
  if (result === undefined) {
    throw new Error(`${label} references unknown id: ${id}`);
  }
  return result;
}

function sortByJson<T>(items: T[]): T[] {
  return [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
