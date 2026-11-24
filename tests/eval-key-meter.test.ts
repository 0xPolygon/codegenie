import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Development-only ESM has no emitted types.
import { applyKeyObservation, readKeyUsage, readConfiguredKeyUsage } from '../evals/runner/key-meter.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from '../evals/runner/ledger.mjs';

const key = 'sk-synthetic-secret-1234567890';
const ledger = { fingerprint: vi.fn(() => 'f'.repeat(64)) };
describe('OpenRouter key meter', () => {
  it('makes a failed meter stale across restart and only admits after fresh sealed evidence', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-meter-'));
    try {
      const db = path.join(dir, 'ledger'), config = { binding: 'campaign', limitMicros: 2_000_000 };
      let campaign = new CampaignLedger(db, config);
      const sealReceipt = (bytes: Buffer, hash: string) => { expect(bytes.toString()).not.toContain(key); writeFileSync(path.join(dir, hash), bytes); return true; };
      const reading = { status: 'ok', usageNanos: 0, observedMs: 1, fingerprint: campaign.fingerprint(key) };
      expect(applyKeyObservation({ ledger: campaign, kind: 'baseline', reading, sealReceipt })).toMatchObject({ action: 'recorded' });
      expect(applyKeyObservation({ ledger: campaign, kind: 'snapshot', reading, sealReceipt })).toMatchObject({ action: 'recorded' });
      expect(campaign.keyDecision({ verifyEvidence: () => true })).toEqual({ action: 'admit' });
      expect(applyKeyObservation({ ledger: campaign, kind: 'snapshot', reading: { status: 'stale' }, sealReceipt })).toEqual({ action: 'wait' });
      campaign.close(); campaign = new CampaignLedger(db, config);
      expect(campaign.keyDecision({ verifyEvidence: () => true })).toEqual({ action: 'wait' });
      expect(campaign.reservePhysical({ id: 'blocked', logicalId: 'blocked', kind: 'initial' })).toEqual({ admitted: false, reason: 'key_usage_stale' });
      expect(applyKeyObservation({ ledger: campaign, kind: 'snapshot', reading: { ...reading, observedMs: 2 }, sealReceipt })).toMatchObject({ action: 'recorded' });
      expect(campaign.keyDecision({ verifyEvidence: () => true })).toEqual({ action: 'admit' }); campaign.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('resolves the normal provider identity without returning credentials', async () => {
    const getAuth = vi.fn(async () => ({ auth: { apiKey: key } }));
    const fetchImpl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      expect(init.headers.authorization).toBe(`Bearer ${key}`);
      return new Response('{"data":{"usage":0}}');
    });
    const result = await readConfiguredKeyUsage({ ledger, models: { getAuth }, fetchImpl });
    expect(getAuth).toHaveBeenCalledWith('openrouter');
    expect(result).toMatchObject({ status: 'ok', usageNanos: 0 });
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it('returns a sanitized exact usage observation including a reported zero', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":{"usage":0}}', { status: 200 }));
    const reading = await readKeyUsage({ key, ledger, fetchImpl });
    expect(reading).toMatchObject({ status: 'ok', usageMicros: 0, usageNanos: 0, fingerprint: 'f'.repeat(64) });
    expect(JSON.stringify(reading)).not.toContain(key);
    expect(JSON.stringify(reading).toLowerCase()).not.toContain('authorization');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const precision = await readKeyUsage({ key, ledger, fetchImpl: async () => new Response('{"data":{"usage":0.0000012345}}') });
    expect(precision).toMatchObject({ status: 'ok', usageNanos: 1234, usageMicros: 1 });
  });
  it('distinguishes stale, denied, and malformed observations without leaking transport content', async () => {
    const network = await readKeyUsage({ key, ledger, fetchImpl: async () => { throw new Error(`authorization: Bearer ${key}`); } });
    expect(network).toEqual({ status: 'stale' });
    expect(await readKeyUsage({ key, ledger, fetchImpl: async () => new Response(key, { status: 503 }) })).toEqual({ status: 'stale' });
    expect(await readKeyUsage({ key, ledger, fetchImpl: async () => new Response(key, { status: 401 }) })).toEqual({ status: 'denied', httpStatus: 401 });
    expect(await readKeyUsage({ key, ledger, fetchImpl: async () => new Response('{"data":{}}') })).toEqual({ status: 'malformed' });
    expect(await readKeyUsage({ key, ledger, fetchImpl: async () => new Response(`{"data":{"usage":"${key}"}}`) })).toEqual({ status: 'malformed' });
    expect(JSON.stringify(network)).not.toContain(key);
  });
});
