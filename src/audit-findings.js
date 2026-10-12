const RULES = 'https://firebase.google.com/docs/rules/insecure-rules';
const CHECKS = {
  publicData: { checkId: 'FL-FS-001', confidence: 'observed', remediation: 'Confirm whether this path is intended to be public. For private data, restrict get/list rules to the intended owner or role.', retest: 'Repeat the same list/get without a token and with owner and other-user identities. Private data must deny the first and third cases.' },
  identityDifferences: { checkId: 'FL-FS-002', confidence: 'observed', remediation: 'Compare the tested identities with your intended role and ownership policy. A difference can be correct behavior.', retest: 'Repeat the same operation with known owner, other-user and signed-out identities; confirm each expected outcome.' },
  canaryAccess: { checkId: 'FL-FS-003', confidence: 'observed', remediation: 'Check create/update/delete rules independently, including ownership and field validation. Canary access applies only to its synthetic schema.', retest: 'Use the emulator to test valid and invalid application documents for each operation and role.' },
  cleanup: { checkId: 'FL-FS-004', confidence: 'needs verification', remediation: 'Inspect this exact generated document in the owning project. Remove it manually only after confirming it is the test canary.', retest: 'Verify the generated document is absent with an authorized identity. A permission denial does not establish deletion.' },
  sensitiveFields: { checkId: 'FL-FS-005', confidence: 'field-name heuristic', remediation: 'Review these field names and their intended audience. Keep server credentials out of client-readable documents; rotate confirmed exposed credentials.', retest: 'Verify private fields cannot be read by signed-out or unrelated users. Field names alone do not prove that values are sensitive.' },
  errors: { checkId: 'FL-FS-006', confidence: 'inconclusive', remediation: 'Inspect connectivity, quotas, API configuration and token validity before retrying. This result does not establish a permission decision.', retest: 'Retry the same scope and identity after resolving the request error.' }
};

export const isInconclusive = row => !['readable', 'denied', 'not found'].includes(row.outcome);

export function buildFindings(report, samples = { sources: [] }) {
  const groups = { publicData: [], identityDifferences: [], canaryAccess: [], cleanup: [], sensitiveFields: [], errors: [] };
  for (const r of report.requests) {
    if (r.identity === 'No token' && r.outcome === 'readable' && (r.kind === 'document' || r.sampledDocuments > 0)) groups.publicData.push({ path: r.path, operation: r.kind, note: 'Returned data without login. Compare with intended public access.' });
    if (isInconclusive(r)) groups.errors.push({ path: r.path, identity: r.identity, outcome: r.outcome });
  }
  groups.identityDifferences = report.findings.filter(f => f.finding === 'Read permission differs across tested identities').map(f => ({ path: f.path, note: f.finding }));
  for (const m of report.mutations || []) {
    if ([m.create,m.update,m.delete].includes('allowed')) groups.canaryAccess.push({ path: m.path, identity: m.identity, create: m.create, update: m.update, delete: m.delete, note: 'Synthetic canary schema only.' });
    if (m.cleanupRequired) groups.cleanup.push({ path: m.path, project: m.project, identity: m.identity });
  }
  const interesting = /^(?:password|passwd|passwordhash|password_hash|secret|client_secret|private_key|privatekey|access_token|refresh_token|token|email|phone|ssn)$/i;
  for (const source of samples.sources) for (const doc of source.documents) {
    const names = [];
    function walk(obj, prefix = '', depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 12 || names.length >= 20) return;
      for (const [key,val] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (interesting.test(key)) names.push(path);
        if (names.length >= 20) break;
        if (typeof val === 'object') walk(val,path,depth+1);
      }
    }
    walk(doc.data);
    if (names.length) groups.sensitiveFields.push({ path: doc.path, identity: source.label, fields: names, note: 'Field-name heuristic only; values excluded. Not proof of a leaked credential or vulnerability.' });
  }
  for (const [group, entries] of Object.entries(groups)) {
    groups[group] = entries.map(entry => ({ ...entry, ...CHECKS[group],
      priority: group === 'cleanup' || group === 'publicData' && report.privateScope ? 'action required' : group === 'identityDifferences' ? 'informational' : 'review',
      reference: RULES
    }));
  }
  return { groups, scope: 'Sensitive-field hints cover only retained graph samples; other groups cover completed requests. No response values or raw tokens included.' };
}
export function findingsJSONL(report) {
  const records = [{ schema: 'firelab.findings/v1', type: 'scan', environment: report.environment || 'firebase', project: report.project, engine: report.engine, demo: Boolean(report.demo), status: report.status, startedAt: report.startedAt, finishedAt: report.finishedAt, completedRequests: report.requests.length, plannedRequests: report.plannedRequests, coverage: report.coverage }];
  for (const [group, entries] of Object.entries(report.highlights?.groups || {})) for (const e of entries) records.push({
    schema: 'firelab.findings/v1', type: 'finding', project: report.project, demo: Boolean(report.demo), group,
    id: JSON.stringify([e.checkId, e.path, e.identity || '', e.operation || '']),
    checkId: e.checkId, path: e.path, identity: e.identity, operation: e.operation,
    priority: e.priority, confidence: e.confidence, outcome: e.outcome, fields: e.fields,
    create: e.create, update: e.update, delete: e.delete,
    note: e.note, remediation: e.remediation, retest: e.retest, reference: e.reference
  });
  return records.map(r => JSON.stringify(r)).join('\n') + '\n';
}
