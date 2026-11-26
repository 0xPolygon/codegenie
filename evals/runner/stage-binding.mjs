// Check receipt-inventoried settings and native calls against the slot's
// physical expectations. The case config itself supplies the selection.
export function reviewStageSelection(effectiveLLM) {
  if (!effectiveLLM || typeof effectiveLLM !== 'object') throw new Error('effective stage binding missing');
  const selection = effectiveLLM.stages?.review;
  const qualified = selection?.model;
  const slash = typeof qualified === 'string' ? qualified.indexOf('/') : -1;
  const provider = qualified === undefined ? effectiveLLM.provider : typeof qualified === 'string' ? qualified.slice(0, slash) : undefined;
  const modelId = qualified === undefined ? effectiveLLM.model : typeof qualified === 'string' ? qualified.slice(slash + 1) : undefined;
  const reasoning = selection?.reasoning ?? effectiveLLM.reasoning ?? 'high';
  if (typeof provider !== 'string' || !provider || typeof modelId !== 'string' || !modelId || typeof reasoning !== 'string' || !reasoning ||
      (qualified !== undefined && (slash < 1 || slash === qualified.length - 1))) throw new Error('effective stage binding invalid');
  return { provider, modelId, reasoning };
}

export function assertStageBinding(effectiveLLM, expectedCalls, modelCalls, readDebug) {
  const expected = expectedCalls.filter((call) => call.stage === 7);
  if (!expected.length) return;
  if (!Array.isArray(modelCalls)) throw new Error('effective stage binding missing');
  const { provider, modelId, reasoning } = reviewStageSelection(effectiveLLM);
  const initial = expected.filter((call) => call.kind === 'initial' && call.purpose === undefined);
  if (initial.length !== 1 || initial[0].provider !== provider || initial[0].modelId !== modelId || initial[0].reasoningSelected !== reasoning ||
      expected.some((call) => call.provider !== provider || call.modelId !== modelId)) throw new Error('effective stage binding mismatch');
  for (const row of modelCalls.filter((call) => call.stage === 7)) {
    let purpose = row.purpose;
    if (typeof row.workerId === 'string' && row.workerId.startsWith('location-')) {
      if (typeof readDebug !== 'function' || readDebug(row.callId)?.request?.promptTemplateVersion !== 'location-clarification-v1') throw new Error('native stage binding mismatch');
      purpose = 'location_clarification';
    }
    const matches = expected.filter((call) => call.kind === row.kind && (call.purpose ?? null) === (purpose ?? null));
    if (matches.length !== 1 || row.provider !== matches[0].provider || row.model !== matches[0].modelId ||
        row.reasoningSelected !== matches[0].reasoningSelected) throw new Error('native stage binding mismatch');
  }
}
