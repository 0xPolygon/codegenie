// Treatment-only projection. Callers must verify primary locks and reconciliation
// before invoking it, and must bind the selected receipt and packet inventory.
export function projectMechanism({ id, records, packets, anchorMappings = [] }) {
  if (!/^[a-f0-9]{24}$/u.test(id ?? '') || !Array.isArray(records) || !Array.isArray(packets) || !Array.isArray(anchorMappings)) throw new Error('missing mechanism evidence');
  const byPacket = new Map();
  for (const packet of packets) {
    if (!packet || typeof packet.id !== 'string' || byPacket.has(packet.id) || !Array.isArray(packet.hunks)) throw new Error('invalid packet inventory');
    byPacket.set(packet.id, packet);
  }
  const seen = new Set();
  const passes = records.map((record) => {
    const packet = byPacket.get(record?.packetId), passKey = `${record?.packetId}\0${record?.pass}`;
    if (!packet || !Number.isSafeInteger(record.pass) || record.pass < 1 || seen.has(passKey) || !Array.isArray(record.assignedHunkIds) ||
        !Array.isArray(record.assignedEffects) || !['findings', 'no_findings', 'incomplete'].includes(record.reviewStatus)) throw new Error('invalid effect record');
    seen.add(passKey);
    const assigned = new Set(record.assignedHunkIds);
    if (assigned.size !== record.assignedHunkIds.length || assigned.size !== new Set(packet.hunks.map((item) => item.hunkId)).size || [...assigned].some((hunk) => typeof hunk !== 'string' || !packet.hunks.some((item) => item.hunkId === hunk))) throw new Error('invalid assigned hunk');
    const effects = record.assignedEffects.map((row) => {
      if (!row || !assigned.has(row.hunkId) || typeof row.effect !== 'string' || typeof row.basis !== 'string' ||
          !['removed_guarantee', 'skipped_path', 'relied_guard', 'none'].includes(row.kind) || !['safe', 'finding', 'question'].includes(row.disposition) || (row.kind === 'none' && row.disposition !== 'safe')) throw new Error('invalid effect row');
      return { hunkId: row.hunkId, effect: row.effect, kind: row.kind, disposition: row.disposition, basis: row.basis };
    });
    const uncoveredHunks = [...assigned].filter((hunk) => !effects.some((row) => row.hunkId === hunk));
    if (record.reviewStatus !== 'incomplete' && uncoveredHunks.length) throw new Error('complete effect record lacks coverage');
    return { pass: record.pass, packetId: record.packetId, reviewStatus: record.reviewStatus, assignedHunkIds: [...assigned], uncoveredHunks, effects,
      source: { path: packet.path, hunks: packet.hunks.filter((hunk) => assigned.has(hunk.hunkId)) } };
  });
  const diagnostics = anchorMappings.map((mapping) => {
    if (!mapping || typeof mapping.id !== 'string' || !Array.isArray(mapping.hunkIds) || typeof mapping.unmapped !== 'boolean' || mapping.unmapped !== (mapping.hunkIds.length === 0)) throw new Error('invalid anchor mapping');
    const uncovered = passes.flatMap((pass) => pass.reviewStatus === 'incomplete' ? pass.uncoveredHunks.filter((hunkId) => mapping.hunkIds.includes(hunkId)).map((hunkId) => ({ packetId: pass.packetId, pass: pass.pass, hunkId })) : []);
    return { causeId: mapping.id, mapping: mapping.unmapped ? 'unmapped' : 'mapped', uncoveredOnIncomplete: uncovered };
  });
  return { id, passes, diagnostics };
}
