import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { exportFirstLock } from '../evals/runner/blind-export.mjs';

it('writes one stable, private mapping and receipt-selected blind sheets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-export-'));
  try {
    const evidence = { outcome: 'completed_partial', candidates: [{ id: 'raw-id-123', title: 'A write can fail', path: 'src/a.ts' }], promotion: { decisions: [] }, verification: [], finalReview: { findings: [] } };
    const args = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 1, outputDirectory: path.join(dir, 'blind'), mappingFile: path.join(dir, 'private', 'mapping.json'),
      selections: [{ slotId: 'secret-treatment-slot', attempt: 1, receiptSHA256: 'c'.repeat(64), arm: 'treatment', draw: 1, caseId: 'case-01', causes: [], sourceLocator: 'sources/case-01', oracleLocator: 'oracles/case-01', evidence }] };
    const first = exportFirstLock(args), mapping = readFileSync(args.mappingFile), manifest = readFileSync(path.join(args.outputDirectory, 'manifest.json'));
    expect(statSync(args.mappingFile).mode & 0o777).toBe(0o600);
    expect(exportFirstLock(args)).toEqual(first);
    expect(readFileSync(args.mappingFile)).toEqual(mapping); expect(readFileSync(path.join(args.outputDirectory, 'manifest.json'))).toEqual(manifest);
    const sheetFile = readdirSync(args.outputDirectory).find((name) => name !== 'manifest.json')!;
    const sheetBytes = readFileSync(path.join(args.outputDirectory, sheetFile)); rmSync(path.join(args.outputDirectory, sheetFile));
    expect(exportFirstLock(args)).toEqual(first); expect(readFileSync(path.join(args.outputDirectory, sheetFile))).toEqual(sheetBytes);
    const scratch = path.join(args.outputDirectory, `.blind-${'f'.repeat(32)}`); writeFileSync(scratch, 'partial');
    expect(() => exportFirstLock(args)).toThrow('scratch'); rmSync(scratch);
    const all = readdirSync(args.outputDirectory).map((file) => readFileSync(path.join(args.outputDirectory, file), 'utf8')).join('\n');
    expect(all).not.toMatch(/secret-treatment-slot|raw-id-123|"arm"|"draw"|"score"|cccccccc/);
    expect(() => exportFirstLock({ ...args, selections: [] })).toThrow('selection changed');
    expect(() => exportFirstLock({ ...args, mappingFile: path.join(args.outputDirectory, 'mapping') })).toThrow('overlaps');
    expect(readdirSync(args.outputDirectory)).toHaveLength(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('writes no mechanism files before independent locks and reconciliation', async () => {
  const { createHash } = await import('node:crypto');
  // @ts-expect-error Development-only ESM has no emitted types.
  const { exportMechanism, revealPairing } = await import('../evals/runner/blind-export.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-mechanism-export-'));
  try {
    const evidence = { outcome: 'completed_partial', candidates: [], promotion: { decisions: [] }, verification: [], finalReview: { findings: [] } };
    const options = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 0, outputDirectory: path.join(dir, 'blind'), mappingFile: path.join(dir, 'private', 'mapping.json'),
      selections: [{ slotId: 's', attempt: 1, receiptSHA256: 'c'.repeat(64), arm: 'treatment', draw: 1, caseId: 'case-01', causes: [], sourceLocator: 'source/01', oracleLocator: 'oracle/01', evidence }] };
    const first = exportFirstLock(options), manifestFile = path.join(options.outputDirectory, 'manifest.json');
    const mapping = JSON.parse(readFileSync(options.mappingFile, 'utf8'));
    const file = (name: string, value: unknown) => { const bytes = JSON.stringify(value), dest = path.join(dir, name); writeFileSync(dest, bytes); return { path: dest, sha256: createHash('sha256').update(bytes).digest('hex') }; };
    const grades = [{ id: mapping.selections[0].id, noApplicableCauses: true, causes: [], otherClaims: { survivingMediumPlus: [], published: [] } }];
    const a = file('a.json', { analyst: 'a', manifestSHA256: first.manifestSHA256, grades }), b = file('b.json', { analyst: 'b', manifestSHA256: first.manifestSHA256, grades });
    const reconciliation = file('reconciled.json', { manifestSHA256: first.manifestSHA256, lockSHA256: [a.sha256, b.sha256], grades });
    const target = path.join(dir, 'mechanism');
    const args = { manifestFile, manifestSHA256: first.manifestSHA256, mappingFile: options.mappingFile, locks: [a, b], reconciliation, outputDirectory: target,
      evidence: [{ id: mapping.selections[0].id, receiptSHA256: 'c'.repeat(64), records: [{ packetId: 'p', pass: 1, reviewStatus: 'incomplete', assignedHunkIds: ['h'], assignedEffects: [] }], packets: [{ id: 'p', path: 'src/a', hunks: [{ hunkId: 'h', lines: [] }] }] }] };
    await expect(exportMechanism({ ...args, reconciliation: undefined })).rejects.toThrow();
    await expect(exportMechanism({ ...args, locks: [a, a] })).rejects.toThrow();
    const wrong = file('wrong.json', { analyst: 'b', manifestSHA256: 'f'.repeat(64) });
    await expect(exportMechanism({ ...args, locks: [a, wrong] })).rejects.toThrow();
    expect(() => readdirSync(target)).toThrow();
    const injected = path.join(options.outputDirectory, 'private-note.txt'); writeFileSync(injected, 'do not publish');
    await expect(exportMechanism(args)).rejects.toThrow('unexpected export'); expect(() => readdirSync(target)).toThrow(); rmSync(injected);
    const result = await exportMechanism(args); expect(result.reviewCount).toBe(1);
    expect(JSON.parse(readFileSync(path.join(target, `${mapping.selections[0].id}.json`), 'utf8')).passes[0].uncoveredHunks).toEqual(['h']);
    const reveal = { manifestFile, manifestSHA256: first.manifestSHA256, mappingFile: options.mappingFile, locks: [a, b], reconciliation, mechanismManifestFile: path.join(target, 'manifest.json'), mechanismManifestSHA256: result.mechanismManifestSHA256, outputFile: path.join(dir, 'revealed', 'pairing.json') };
    await expect(revealPairing(reveal)).rejects.toThrow();
    expect(() => readdirSync(path.dirname(reveal.outputFile))).toThrow();
    const coding = file('coding.json', { frozen: true, mechanismManifestSHA256: result.mechanismManifestSHA256, reviews: [{ id: mapping.selections[0].id, noApplicableCauses: true, causes: [] }] });
    const sheetFile = path.join(options.outputDirectory, `${mapping.selections[0].id}.json`), originalSheet = readFileSync(sheetFile);
    writeFileSync(sheetFile, '{}'); await expect(revealPairing({ ...reveal, coding })).rejects.toThrow('sheet mismatch');
    expect(() => readdirSync(path.dirname(reveal.outputFile))).toThrow(); writeFileSync(sheetFile, originalSheet);
    expect((await revealPairing({ ...reveal, coding })).reviewCount).toBe(1);
    const pairing = JSON.parse(readFileSync(reveal.outputFile, 'utf8'));
    expect(pairing.reviews[0]).toMatchObject({ arm: 'treatment', draw: 1 });
    expect(JSON.stringify(pairing)).not.toMatch(/receipt|slotId|"key"/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses treatment markers with aggregate counts before writing any export', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-marker-'));
  try {
    const options = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 0,
      outputDirectory: path.join(dir, 'blind'), mappingFile: path.join(dir, 'private', 'mapping.json'),
      selections: ['one', 'two'].map((slotId, index) => ({ slotId, attempt: 1, receiptSHA256: String(index + 1).repeat(64), arm: 'treatment', draw: index + 1, caseId: 'case-01', causes: [], sourceLocator: 'source/01', oracleLocator: 'oracle/01',
        evidence: { outcome: 'completed_full', candidates: [{ id: `raw-id-${index}`, failureMode: index ? 'assigned effect' : 'skipped_path relied_guard' }], promotion: { decisions: [] }, verification: [], finalReview: {} } })) };
    try { exportFirstLock(options); throw new Error('expected refusal'); } catch (error) { expect(error).toMatchObject({ affectedSheets: 2, hits: 3 }); }
    expect(() => readdirSync(options.outputDirectory)).toThrow(); expect(() => readFileSync(options.mappingFile)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses unrelated destination files before publishing anything', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-dirty-'));
  try {
    const outputDirectory = path.join(dir, 'blind'); mkdirSync(outputDirectory);
    writeFileSync(path.join(outputDirectory, 'private-note.txt'), 'do not publish');
    const args = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 0, outputDirectory,
      mappingFile: path.join(dir, 'private', 'mapping.json'), selections: [{ slotId: 's', attempt: 1, receiptSHA256: 'c'.repeat(64), arm: 'control', draw: 1, caseId: 'case-01', causes: [], sourceLocator: 'source/01', oracleLocator: 'oracle/01',
        evidence: { outcome: 'completed_full', candidates: [], promotion: { decisions: [] }, verification: [], finalReview: {} } }] };
    expect(() => exportFirstLock(args)).toThrow('unexpected export directory entry');
    expect(readdirSync(outputDirectory)).toEqual(['private-note.txt']); expect(() => readFileSync(args.mappingFile)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('keeps frozen anchor hunk IDs in the private mapping while projecting optional causes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-anchor-'));
  try {
    const args = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 0, outputDirectory: path.join(dir, 'blind'), mappingFile: path.join(dir, 'private', 'mapping.json'),
      selections: [{ slotId: 'slot', attempt: 1, receiptSHA256: 'c'.repeat(64), arm: 'treatment', draw: 1, caseId: 'case-01', sourceLocator: 'source/01', oracleLocator: 'oracle/01',
        causes: [{ id: 'optional-cause', optional: true }], anchorMappings: [{ id: 'optional-cause', optional: true, hunkIds: ['private-hunk-id'], unmapped: false }],
        evidence: { outcome: 'completed_full', candidates: [], promotion: { decisions: [] }, verification: [], finalReview: {} } }] };
    exportFirstLock(args);
    const manifest = JSON.parse(readFileSync(path.join(args.outputDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.sheets[0].causes).toEqual([{ id: 'optional-cause', optional: true }]);
    expect(readdirSync(args.outputDirectory).map((name) => readFileSync(path.join(args.outputDirectory, name), 'utf8')).join('')).not.toContain('private-hunk-id');
    expect(readFileSync(args.mappingFile, 'utf8')).toContain('private-hunk-id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
