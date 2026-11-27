// This optional binding is for a paired instruction screen. It is deliberately
// absent from historical campaigns, whose admission contract stays unchanged.
export function validateInstructionArms(blind) {
  const arms = blind?.instructionSets;
  if (arms === undefined) {
    if (blind?.effortPolicy !== undefined) throw new Error('instruction effort policy missing arms');
    return undefined;
  }
  if (!arms || typeof arms !== 'object' || Array.isArray(arms) || Object.keys(arms).sort().join(',') !== 'control,treatment' ||
      arms.control !== 'v1' || arms.treatment !== 'v2' || blind.effortPolicy !== 'global-high') throw new Error('invalid instruction arm binding');
  return arms;
}

export function assertInstructionBinding(config, expectedCalls, instructionSet) {
  if (!config?.llm || !config?.review || config.llm.reasoning !== 'high' ||
      Object.values(config.llm.stages ?? {}).some((stage) => stage?.reasoning !== undefined)) throw new Error('instruction effort policy mismatch');
  if ((config.review.stage7Instructions ?? 'v1') !== instructionSet) throw new Error('instruction arm mismatch');
  if (!Array.isArray(expectedCalls) || !expectedCalls.length) throw new Error('instruction call policy missing');
  if ([5, 7, 9, 10].some((stage) => !expectedCalls.some((row) => row.stage === stage && row.kind === 'initial' && row.purpose === undefined))) throw new Error('instruction call policy missing');
  const version = instructionSet === 'v2' ? 'p9.32' : 'p9.31';
  if (expectedCalls.filter((row) => row.stage === 9).some((row) => row.templateVersion !== version)) throw new Error('instruction verifier template mismatch');
  const stage7 = instructionSet === 'v2' ? ['p7.18', 'p7.19'] : ['p7.16', 'p7.17'];
  if (expectedCalls.filter((row) => row.stage === 7 && row.purpose !== 'location_clarification').some((row) => !stage7.includes(row.templateVersion))) throw new Error('instruction packet template mismatch');
  // The prompt version may differ by arm; everything governing actual model,
  // provider and selected/wire effort must agree across the paired campaign.
  return JSON.stringify(expectedCalls.map(({ templateVersion: _ignored, ...row }) => row)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
