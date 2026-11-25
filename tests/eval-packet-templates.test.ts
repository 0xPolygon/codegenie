import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { derivePacketTemplates, expectedPacketTemplate, resolveExpectedCall, validatePacketTemplates, verifyPacketCalls } from '../evals/runner/packet-templates.mjs';

const packet = (id: string, truncated: boolean) => ({ id, hunks: [{ hunkId: id, lines: [], truncated }], prSummary: '', path: 'a', language: 'javascript', lenses: [], labels: [], contextText: '', relevantTests: [], toolBudget: 3 });
const kinds = ['initial', 'tool-continuation', 'repair', 'finalize'];

it('derives packet and kind bindings from the actual prompt builder', () => {
  const bindings = derivePacketTemplates([packet('ordinary', false), packet('shortened', true)]);
  validatePacketTemplates(bindings, ['ordinary', 'shortened']);
  for (const kind of kinds) {
    expect(expectedPacketTemplate(bindings, 'ordinary', kind)).toBe(`p7.16`);
    expect(expectedPacketTemplate(bindings, 'shortened', kind)).toBe(`p7.17`);
    const expectedCalls = [{ stage: 7, kind, templateVersion: 'generic' }];
    expect(resolveExpectedCall(expectedCalls, { stage: 7, kind, packetId: 'shortened' }, bindings).templateVersion).toBe(`p7.17`);
    expect(resolveExpectedCall(expectedCalls, { stage: 7, kind, packetId: 'ordinary' }, bindings).templateVersion).toBe(`p7.16`);
    expect(resolveExpectedCall(expectedCalls, { stage: 7, kind, packetId: 'foreign' }, bindings)).toEqual({});
  }
  expect(expectedPacketTemplate(bindings, 'unknown', 'initial')).toBeUndefined();
});

it('verifies per-call packet assignments, rejecting swaps, omissions and duplicate IDs', () => {
  const bindings = derivePacketTemplates([packet('ordinary', false), packet('shortened', true)]);
  const calls = kinds.flatMap((kind, i) => ['ordinary', 'shortened'].map((packetId, j) => ({ callId: `mc-${i}-${j}`, packetId, kind, templateVersion: expectedPacketTemplate(bindings, packetId, kind) })));
  const modelCalls: { callId: string; packetId?: string; kind: string; stage: number; candidateId?: string; workerId?: string }[] = calls.map(({ callId, packetId, kind }) => ({ callId, packetId, kind, stage: 7 }));
  const debug = new Map(calls.map((call) => [call.callId, { request: { promptTemplateVersion: call.templateVersion } }]));
  const verify = (observed = calls, models = modelCalls) => verifyPacketCalls({ bindings, packetIds: ['ordinary', 'shortened'], calls: observed, modelCalls: models, readDebug: (id: string) => debug.get(id) });
  expect(() => verify()).not.toThrow();
  const swapped = calls.map((item) => ({ ...item, templateVersion: item.templateVersion === 'p7.16' ? 'p7.17' : 'p7.16' }));
  expect(() => verify(swapped)).toThrow('packet call evidence');
  const wrongPacket = modelCalls.map((row, index) => index === 0 ? { ...row, packetId: 'shortened' } : row);
  expect(() => verify(calls, wrongPacket)).toThrow('packet call evidence');
  expect(() => verify(calls.slice(1))).toThrow('packet call evidence');
  expect(() => verify([...calls, calls[0]!])).toThrow('packet call evidence');
  expect(() => verify(calls, modelCalls.slice(1))).toThrow('packet call evidence');
  debug.set('mc-extra', { request: { promptTemplateVersion: 'p7.16' } });
  expect(() => verify(calls, [...modelCalls, { callId: 'mc-extra', kind: 'initial', stage: 7 } as typeof modelCalls[number]])).toThrow('packet call evidence');
  const unknown = { callId: 'mc-unknown', packetId: 'ordinary', kind: 'unexpected', templateVersion: undefined };
  debug.set('mc-unknown', { request: { promptTemplateVersion: undefined } });
  expect(() => verify([...calls, unknown], [...modelCalls, { callId: unknown.callId, packetId: unknown.packetId, kind: unknown.kind, stage: 7 }])).toThrow('packet call evidence');
  debug.set('mc-location', { request: { promptTemplateVersion: 'location-clarification-v1' } });
  expect(() => verify(calls, [...modelCalls, { callId: 'mc-location', kind: 'initial', stage: 7, candidateId: 'candidate', workerId: 'location-candidate' } as typeof modelCalls[number]])).not.toThrow();
});
