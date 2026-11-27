import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const revision = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);

// The caller supplies the integrity-checked suite case, not the worker JSON.
export function validateAdmissionAudit({ record, case: oracleCase, locator, suiteCase, checkout, role, causes }) {
  if (!record || record.version !== 1 || !oracleCase || !locator || !suiteCase || !Array.isArray(causes) ||
      record.caseId !== oracleCase.caseId || record.disposition !== role || record.oracleSHA256 !== locator.oracleSHA256 ||
      !nonempty(record.analyst) || !nonempty(record.curator) || record.analyst.trim().toLowerCase() === record.curator.trim().toLowerCase() ||
      !revision(record.baseRevision) || !revision(record.headRevision) || record.baseRevision !== suiteCase.command?.base ||
      record.headRevision !== suiteCase.command?.head || record.headRevision !== locator.sourceRevision ||
      !Array.isArray(record.scope) || !record.scope.length || !Array.isArray(record.findings)) throw new Error('invalid admission audit');
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const diff = git('diff', '--binary', record.baseRevision, record.headRevision, '--');
  if (hash(diff) !== record.diffSHA256) throw new Error('admission audit diff mismatch');
  const entries = git('diff', '--name-status', '-z', '--find-renames', record.baseRevision, record.headRevision, '--').toString('utf8').split('\0');
  const base = new Set(), head = new Set();
  for (let i = 0; i < entries.length && entries[i];) {
    const status = entries[i++], first = entries[i++];
    if (!first || !/^[ACDMRT]/u.test(status)) throw new Error('invalid admission audit diff');
    if (/^[RC]/u.test(status)) { const next = entries[i++]; if (!next) throw new Error('invalid admission audit diff'); base.add(first); head.add(next); }
    else { if (status[0] !== 'A') base.add(first); if (status[0] !== 'D') head.add(first); }
  }
  const covered = new Set();
  for (const item of record.scope) {
    if (!item || !nonempty(item.path) || !['base', 'head'].includes(item.side) || !['whole_file', 'changed_hunks'].includes(item.coverage) ||
        !(item.side === 'base' ? base : head).has(item.path)) throw new Error('invalid admission audit scope');
    covered.add(item.path);
  }
  for (const item of record.findings) {
    if (!item || !nonempty(item.ref) || typeof item.verified !== 'boolean' || (item.causeId !== undefined && !nonempty(item.causeId))) throw new Error('invalid admission audit finding');
    if (role === 'negative-control' && item.verified && !causes.some((cause) => cause.id === item.causeId && cause.optional === true)) throw new Error('unmapped admission audit finding');
  }
  return { uncoveredChangedPaths: new Set([...base, ...head].filter((item) => !covered.has(item))).size };
}
