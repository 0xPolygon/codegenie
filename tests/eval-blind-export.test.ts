import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { exportFirstLock } from '../evals/runner/blind-export.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { readCheckedFile } from '../evals/runner/safe-read.mjs';

it('writes one stable, private mapping and receipt-selected blind sheets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-export-'));
  try {
    const evidence = { outcome: 'completed_partial', candidates: [{ id: 'raw-id-123', title: 'A write can fail', path: 'src/a.ts' }], promotion: { decisions: [] }, verification: [], finalReview: { findings: [] } };
    const args = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 1, outputDirectory: path.join(dir, 'blind'), mappingFile: path.join(dir, 'private', 'mapping.json'),
      selections: [{ slotId: 'secret-treatment-slot', attempt: 1, receiptSHA256: 'c'.repeat(64), arm: 'treatment', draw: 1, caseId: 'case-01', causes: [], sourceLocator: 'sources/case-01', oracleLocator: 'oracles/case-01', evidence }] };
    const first = exportFirstLock(args), manifest = readFileSync(path.join(args.outputDirectory, 'manifest.json'));
    const mappingFd = openSync(args.mappingFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let mapping: Buffer;
    try { expect(fstatSync(mappingFd).mode & 0o777).toBe(0o600); mapping = readFileSync(mappingFd); }
    finally { closeSync(mappingFd); }
    expect(exportFirstLock(args)).toEqual(first);
    expect(readCheckedFile(args.mappingFile)).toEqual(mapping); expect(readFileSync(path.join(args.outputDirectory, 'manifest.json'))).toEqual(manifest);
    const sheetFile = readdirSync(args.outputDirectory).find((name) => name !== 'manifest.json')!;
    const sheetBytes = readFileSync(path.join(args.outputDirectory, sheetFile)); rmSync(path.join(args.outputDirectory, sheetFile));
    expect(exportFirstLock(args)).toEqual(first); expect(readFileSync(path.join(args.outputDirectory, sheetFile))).toEqual(sheetBytes);
    const scratch = path.join(args.outputDirectory, `.blind-${'f'.repeat(32)}`); writeFileSync(scratch, 'partial');
    expect(() => exportFirstLock(args)).toThrow('scratch'); rmSync(scratch);
    const all = readdirSync(args.outputDirectory).map((file) => readFileSync(path.join(args.outputDirectory, file), 'utf8')).join('\n');
    expect(all).not.toMatch(/secret-treatment-slot|raw-id-123|"arm"|"draw"|"score"|cccccccc/);
    expect(() => exportFirstLock({ ...args, selections: [] })).toThrow('selection changed');
    expect(() => exportFirstLock({ ...args, mappingFile: path.join(args.outputDirectory, 'mapping') })).toThrow('overlaps');
    expect(() => exportFirstLock({ ...args, selections: [{ ...args.selections[0], sourceLocator: 'C:/Users/alice/private' }] })).toThrow('selected review');
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

it('refuses explicit arm labels but preserves ordinary review prose', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-labels-'));
  try {
    const evidence = { outcome: 'completed_full', candidates: [], promotion: { decisions: [] }, verification: [], finalReview: { findings: [{ id: 'finding', finalBody: 'Access control changes the control flow.' }] } };
    const selection = { slotId: 'slot', attempt: 1, receiptSHA256: 'c'.repeat(64), arm: 'control', draw: 1, caseId: 'case-01', causes: [], sourceLocator: 'source/01', oracleLocator: 'oracle/01', evidence };
    const options = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 0,
      outputDirectory: path.join(dir, 'good'), mappingFile: path.join(dir, 'private', 'good.json'), selections: [selection] };
    expect(exportFirstLock(options).sheetCount).toBe(1);
    const sheet = readdirSync(options.outputDirectory).find((file) => file !== 'manifest.json')!;
    expect(readFileSync(path.join(options.outputDirectory, sheet), 'utf8')).toContain('Access control changes the control flow.');
    const publishedOutput = path.join(dir, 'bad-published'), publishedMapping = path.join(dir, 'private', 'bad-published.json');
    const publishedLeak = { ...selection, evidence: { ...evidence, finalReview: { findings: [{ id: 'finding', finalBody: 'The treatment arm changed.' }] } } };
    try { exportFirstLock({ ...options, outputDirectory: publishedOutput, mappingFile: publishedMapping, selections: [publishedLeak] }); throw new Error('expected refusal'); }
    catch (error) { expect(error).toMatchObject({ hits: 1, affectedSheets: 1 }); }
    expect(() => readdirSync(publishedOutput)).toThrow(); expect(() => readFileSync(publishedMapping)).toThrow();
    for (const [index, label] of ['control arm', 'treatment arm', 'arm-a', 'arm_e', 'arm: treatment', 'blind.arm', '"arm"'].entries()) {
      const outputDirectory = path.join(dir, `bad-${index}`), mappingFile = path.join(dir, 'private', `bad-${index}.json`);
      const bad = { ...selection, evidence: { ...evidence, candidates: [{ id: 'candidate', title: label }] } };
      try { exportFirstLock({ ...options, outputDirectory, mappingFile, selections: [bad] }); throw new Error('expected refusal'); }
      catch (error) { expect(error).toMatchObject({ hits: 1, affectedSheets: 1 }); }
      expect(() => readdirSync(outputDirectory)).toThrow(); expect(() => readFileSync(mappingFile)).toThrow();
    }
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

it('aliases registered hunks consistently across projected prose and separately per sheet', async () => {
  const { createHmac } = await import('node:crypto');
  // @ts-expect-error Development-only ESM has no emitted types.
  const { projectBlindSheet } = await import('../evals/runner/blind-sheet.mjs');
  const key = Buffer.alloc(32, 7), registered = 'abcd1234', punct = 'test.h+01';
  const text = `(${registered}), ${punct}. feedcafe _${registered} ${registered}-part testXhh01 é${registered}é`;
  const project = (id: string) => projectBlindSheet({ id, key, hunkIdentifiers: [registered, punct], caseId: 'synthetic', outcome: 'completed_full',
    candidates: [{ id: 'candidate-001', failureMode: text, evidence: { changedCode: text } }],
    promotion: { decisions: [{ packetId: 'packet-001', question: text }] },
    verification: [{ candidateId: 'candidate-001', verdict: { reason: text } }],
    finalReview: { summary: text, findings: [{ id: 'finding-001', finalBody: text }], summaryOnlyFindings: [{ id: 'finding-002', finalBody: text }], needsHumanAttention: [{ question: text }] } });
  const alias = (id: string, value: string) => 'h-' + createHmac('sha256', key).update(`${id}\0h\0${value}`).digest('hex').slice(0, 16);
  for (const id of ['a'.repeat(24), 'b'.repeat(24)]) {
    const p = project(id), expected = `(${alias(id, registered)}), ${alias(id, punct)}. feedcafe _${registered} ${registered}-part testXhh01 é${registered}é`;
    expect([p.discovery.findings[0].failureMode, p.discovery.findings[0].changedCode, p.discovery.questions[0].question,
      p.verification[0].reason, p.published.summary, p.published.findings[0].visibleBody,
      p.published.summaryOnly[0].visibleBody, p.published.attentionQuestions[0].question]).toEqual(Array(8).fill(expected));
    expect(project(id)).toEqual(p);
  }
  expect(alias('a'.repeat(24), registered)).not.toEqual(alias('b'.repeat(24), registered));
});

it('exports registered hunk prose and refuses residual identifiers before publishing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-blind-hunk-'));
  try {
    const hunk = 'abcd1234', evidence = { outcome: 'completed_full', hunkIdentifiers: [hunk], privateIdentifiers: [hunk],
      candidates: [{ id: 'candidate', failureMode: `This affects (${hunk}).` }], promotion: { decisions: [] }, verification: [], finalReview: {} };
    const selection = { slotId: 'slot', attempt: 1, receiptSHA256: 'c'.repeat(64), arm: 'control', draw: 1, caseId: 'case-01', causes: [], sourceLocator: 'source/01', oracleLocator: 'oracle/01', evidence };
    const args = { bindingSHA256: 'a'.repeat(64), oracleManifestSHA256: 'b'.repeat(64), campaignState: 'completed', excludedCount: 0,
      outputDirectory: path.join(dir, 'good'), mappingFile: path.join(dir, 'private', 'good.json'), selections: [selection] };
    const first = exportFirstLock(args), sheetFile = readdirSync(args.outputDirectory).find((name) => name !== 'manifest.json')!;
    const sheet = readFileSync(path.join(args.outputDirectory, sheetFile), 'utf8');
    expect(sheet).toMatch(/This affects \(h-[a-f0-9]{16}\)/u);
    expect(sheet).not.toContain(hunk);
    expect(exportFirstLock(args)).toEqual(first);
    expect(readFileSync(path.join(args.outputDirectory, sheetFile), 'utf8')).toBe(sheet);
    const badOutput = path.join(dir, 'bad'), badMapping = path.join(dir, 'private', 'bad.json');
    const bad = { ...selection, evidence: { ...evidence, candidates: [{ id: 'candidate', failureMode: `prefix${hunk}` }] } };
    expect(() => exportFirstLock({ ...args, outputDirectory: badOutput, mappingFile: badMapping, selections: [bad] })).toThrow('private identifier');
    expect(() => readdirSync(badOutput)).toThrow(); expect(() => readFileSync(badMapping)).toThrow();
    const unicodeOutput = path.join(dir, 'unicode'), unicodeMapping = path.join(dir, 'private', 'unicode.json');
    const unicode = { ...selection, evidence: { ...evidence, candidates: [{ id: 'candidate', failureMode: `é${hunk}é` }] } };
    expect(() => exportFirstLock({ ...args, outputDirectory: unicodeOutput, mappingFile: unicodeMapping, selections: [unicode] })).toThrow('private identifier');
    expect(() => readdirSync(unicodeOutput)).toThrow(); expect(() => readFileSync(unicodeMapping)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
