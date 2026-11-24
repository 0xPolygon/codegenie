import { createPromptBuilder } from '../../dist/skills/prompt-builder.js';

const kinds = ['initial', 'tool-continuation', 'repair', 'finalize'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// pi-runner passes the originating request's templateVersion to every kind.
// Derive the originating version from the actual packet and product builder.
export function derivePacketTemplates(packets, assignedEffects, builder = createPromptBuilder({}, { toolSurface: 'current' })) {
  if (!Array.isArray(packets) || typeof assignedEffects !== 'boolean') throw new Error('invalid packet template input');
  return packets.map((packet) => {
    if (!packet || typeof packet.id !== 'string' || !packet.id || !Array.isArray(packet.hunks)) throw new Error('invalid packet');
    const template = builder.buildPacketReviewPrompt({ packet, skills: [], assignedEffects }).templateVersion;
    return { packetId: packet.id, templates: Object.fromEntries(kinds.map((kind) => [kind, template])) };
  }).sort((a, b) => a.packetId < b.packetId ? -1 : a.packetId > b.packetId ? 1 : 0);
}

export function validatePacketTemplates(bindings, packetIds, assignedEffects) {
  if (!Array.isArray(bindings) || !Array.isArray(packetIds) || !packetIds.length || new Set(packetIds).size !== packetIds.length || bindings.length !== packetIds.length || typeof assignedEffects !== 'boolean') throw new Error('packet template binding mismatch');
  const ids = new Set();
  for (const binding of bindings) {
    if (!binding || typeof binding.packetId !== 'string' || !packetIds.includes(binding.packetId) || ids.has(binding.packetId) || !binding.templates || Object.keys(binding.templates).length !== kinds.length) throw new Error('packet template binding mismatch');
    ids.add(binding.packetId);
    for (const kind of kinds) {
      const value = binding.templates[kind];
      const allowed = assignedEffects ? ['p7.16-assigned-effects.1', 'p7.17-assigned-effects.1'] : ['p7.16', 'p7.17'];
      if (!own(binding.templates, kind) || !allowed.includes(value)) throw new Error('packet template binding mismatch');
    }
  }
}

export function expectedPacketTemplate(bindings, packetId, kind) {
  const item = bindings?.find((entry) => entry.packetId === packetId);
  return item && own(item.templates, kind) ? item.templates[kind] : undefined;
}

export function resolveExpectedCall(expectedCalls, call, packetBindings, assignedEffects) {
  const matching = expectedCalls.filter((item) => item.stage === call.stage && item.kind === call.kind && (item.purpose ?? null) === (call.purpose ?? null));
  const packetCall = assignedEffects !== undefined && call.stage === 7 && call.purpose !== 'location_clarification';
  const template = packetCall ? expectedPacketTemplate(packetBindings, call.packetId, call.kind) : undefined;
  return matching.length === 1 && (!packetCall || template !== undefined) ? { ...matching[0], ...(packetCall ? { templateVersion: template } : {}) } : {};
}

export function verifyPacketCalls({ bindings, packetIds, assignedEffects, calls, modelCalls, readDebug }) {
  validatePacketTemplates(bindings, packetIds, assignedEffects);
  if (!Array.isArray(calls) || !Array.isArray(modelCalls)) throw new Error('packet call evidence mismatch');
  const ordinary = modelCalls.filter((row) => {
    if (row.stage !== 7) return false;
    if (typeof row.callId !== 'string' || !row.callId) throw new Error('packet call evidence mismatch');
    const debug = readDebug(row.callId);
    if (debug?.request?.promptTemplateVersion === 'location-clarification-v1') {
      if (row.packetId !== undefined || typeof row.candidateId !== 'string' || !row.candidateId || row.workerId !== `location-${row.candidateId}`) throw new Error('packet call evidence mismatch');
      return false;
    }
    if (typeof row.packetId !== 'string' || !row.packetId) throw new Error('packet call evidence mismatch');
    return true;
  });
  const seen = new Set(), covered = new Set();
  for (const call of calls) {
    const expected = call && expectedPacketTemplate(bindings, call.packetId, call.kind);
    if (!call || typeof call.callId !== 'string' || !call.callId || seen.has(call.callId) || typeof expected !== 'string' || expected !== call.templateVersion) throw new Error('packet call evidence mismatch');
    seen.add(call.callId); covered.add(call.packetId);
    const rows = ordinary.filter((row) => row.callId === call.callId);
    if (rows.length !== 1 || rows[0].packetId !== call.packetId || rows[0].kind !== call.kind || readDebug(call.callId)?.request?.promptTemplateVersion !== call.templateVersion) throw new Error('packet call evidence mismatch');
  }
  if (ordinary.length !== calls.length || covered.size !== packetIds.length || packetIds.some((id) => !covered.has(id))) throw new Error('packet call evidence mismatch');
}
