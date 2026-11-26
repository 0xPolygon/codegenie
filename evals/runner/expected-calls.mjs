import { getCodegeniePiModels } from '../../dist/provider/pi-ai-models.js';
import { modelThinkingLevels, selectReasoningEffort } from '../../dist/provider/reasoning.js';

// Call after resolveEvalCaseConfig, using the same effective config the worker
// will run. Packet-specific Stage 7 templates are substituted by the worker.
export function deriveExpectedCalls(config, templates) {
  if (!config?.llm || !config?.review || !templates || typeof templates !== 'object') throw new Error('effective call configuration missing');
  const models = getCodegeniePiModels(), calls = [];
  for (const [stage, name] of [[5, 'plan'], [7, 'review'], [9, 'verify'], [10, 'compose']]) {
    if (templates[stage] === undefined) continue;
    const selection = config.llm.stages?.[name], qualified = selection?.model;
    const slash = typeof qualified === 'string' ? qualified.indexOf('/') : -1;
    const provider = qualified === undefined ? config.llm.provider : qualified.slice(0, slash);
    const id = qualified === undefined ? config.llm.model : qualified.slice(slash + 1);
    const model = models.getModel(provider, id);
    if (!model || model.api !== 'openai-completions' || model.provider !== 'openrouter' || typeof templates[stage] !== 'string') throw new Error('unsupported campaign model');
    const configured = selection?.reasoning ?? config.llm.reasoning ?? 'high';
    const levels = modelThinkingLevels(model);
    if (levels.length && !levels.includes(configured)) throw new Error('unsupported campaign reasoning');
    const purposes = stage === 7 ? [undefined, 'location_clarification'] : [undefined];
    for (const purpose of purposes) for (const kind of ['initial', 'tool-continuation', 'repair', 'finalize']) {
      const policy = kind === 'repair' || purpose ? 'lowest_supported'
        : stage === 10 && config.review.compositionReasoningStepDown && selection?.reasoning === undefined ? 'one_level_lower' : 'configured';
      const reasoningSelected = selectReasoningEffort(configured, levels, policy);
      const wireEffort = model.thinkingLevelMap?.[reasoningSelected] ?? reasoningSelected;
      calls.push({ api: model.api, destination: `${model.baseUrl}/chat/completions`, provider: model.provider, modelId: model.id,
        stage, kind, ...(purpose ? { purpose } : {}), templateVersion: purpose ? 'location-clarification-v1' : templates[stage], reasoningSelected, wireEffort });
    }
  }
  return calls;
}

export function assertExpectedCalls(config, expectedCalls) {
  if (!Array.isArray(expectedCalls) || !expectedCalls.length) throw new Error('effective expected calls missing');
  const templates = {};
  for (const call of expectedCalls) {
    if (call.kind === 'initial' && call.purpose === undefined) {
      if (templates[call.stage] !== undefined) throw new Error('duplicate expected call');
      templates[call.stage] = call.templateVersion;
    }
  }
  const derived = deriveExpectedCalls(config, templates);
  const fields = ['api', 'destination', 'provider', 'modelId', 'stage', 'kind', 'purpose', 'templateVersion', 'reasoningSelected', 'wireEffort'];
  if (derived.length !== expectedCalls.length || derived.some((call) => {
    const matches = expectedCalls.filter((row) => row.stage === call.stage && row.kind === call.kind && (row.purpose ?? null) === (call.purpose ?? null));
    return matches.length !== 1 || fields.some((field) => matches[0][field] !== call[field]);
  })) throw new Error('effective expected calls mismatch');
}
