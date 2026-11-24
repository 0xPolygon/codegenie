import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';
import { readCheckedFile } from './safe-read.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const neutral = (value) => typeof value === 'string' && value.length > 0 && value.length < 512 && !/[\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('/') && !value.includes('\\') &&
  !value.split('/').includes('..') && !/(?:assigned.?effects|openrouter|openai|\b(?:control|treatment)\b|\barm[-_ ]|\bdraw[-_ ]|attempt[-_ ]|\bp7\.)/iu.test(value);
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The hashed configuration and oracle manifest bind every resource needed to
// grade; run this before admitting the first probe as well as before export.
export function validateBlindInputs(binding, slots) {
  if (!binding || typeof binding.mappingFile !== 'string' || !path.isAbsolute(binding.mappingFile) || outsideCheckout(binding.mappingFile) !== binding.mappingFile ||
      typeof binding.locatorManifestPath !== 'string' || !path.isAbsolute(binding.locatorManifestPath) || typeof binding.oracleManifestPath !== 'string' || !path.isAbsolute(binding.oracleManifestPath) || !hash(binding.locatorManifestSHA256) || !hash(binding.oracleManifestSHA256) || !Array.isArray(slots)) throw new Error('blind manifest binding missing');
  const locatorBytes = readCheckedFile(binding.locatorManifestPath), oracleBytes = readCheckedFile(binding.oracleManifestPath);
  if (sha(locatorBytes) !== binding.locatorManifestSHA256 || sha(oracleBytes) !== binding.oracleManifestSHA256) throw new Error('blind manifest binding mismatch');
  const locators = JSON.parse(locatorBytes.toString('utf8')), oracles = JSON.parse(oracleBytes.toString('utf8'));
  if (!Array.isArray(locators.cases) || !Array.isArray(oracles.cases)) throw new Error('invalid blind manifests');
  if (slots.some((slot) => typeof slot?.caseId !== 'string' || !slot.caseId || /[\u0000-\u001f\u007f]/u.test(slot.caseId))) throw new Error('invalid blind case identity');
  const required = [...new Set(slots.map((slot) => slot.caseId))].sort();
  const locatorIds = locators.cases.map((item) => item?.caseId), oracleIds = oracles.cases.map((item) => item?.caseId);
  if (new Set(locatorIds).size !== locatorIds.length || new Set(oracleIds).size !== oracleIds.length ||
      [...locatorIds].sort().join('\0') !== required.join('\0') || [...oracleIds].sort().join('\0') !== required.join('\0') ||
      new Set(locators.cases.map((item) => item.label)).size !== locators.cases.length) throw new Error('blind case membership mismatch');
  for (const location of locators.cases) {
    const oracle = oracles.cases.find((item) => item.caseId === location.caseId);
    if (!neutral(location.label) || !neutral(location.sourceLocator) || !neutral(location.oracleLocator) || !hash(location.oracleSHA256) ||
        oracle?.sha256 !== location.oracleSHA256 || typeof location.oraclePath !== 'string' || !path.isAbsolute(location.oraclePath) || !Array.isArray(oracle.causes) || new Set(oracle.causes.map((cause) => cause.id)).size !== oracle.causes.length ||
        oracle.causes.some((cause) => !cause || !neutral(cause.id) || typeof cause.optional !== 'boolean') || sha(readCheckedFile(location.oraclePath)) !== location.oracleSHA256 ||
        typeof location.sourceRoot !== 'string' || !path.isAbsolute(location.sourceRoot) || !/^[a-f0-9]{40}$/u.test(location.sourceRevision ?? '')) throw new Error('blind source or oracle changed');
    const root = realpathSync(location.sourceRoot);
    if (binding.mappingFile === root || binding.mappingFile.startsWith(`${root}${path.sep}`)) throw new Error('blind mapping overlaps source checkout');
    if (root !== path.resolve(location.sourceRoot) || realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root || git(root, 'rev-parse', 'HEAD') !== location.sourceRevision || git(root, 'status', '--porcelain') !== '') throw new Error('blind source or oracle changed');
  }
  return { locators, oracles };
}
