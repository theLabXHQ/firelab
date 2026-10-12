import { LAB } from './lab.js?v=1.14.1';
import { sampleDocuments } from './audit-samples.js?v=1.14.1';
import { buildReadURL, decodeToken, claimChecks, fingerprint, readWithToken, verifyToken } from './tokens.js?v=1.14.1';

export function auditPlan(project, scope, credentials) {
  const paths = [...new Set(scope.split(/\r?\n/).map(x => x.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))];
  if (!paths.length || paths.length > 500) throw new Error('Enter 1–500 explicit collection or document paths.');
  const targets = paths.map(path => {
    const kind = path.split('/').length % 2 ? 'collection' : 'document';
    return { path, kind, url: buildReadURL(project, path, kind) };
  });
  const identities = [{ label: 'No token', token: null }];
  for (const [label, raw] of credentials) if (raw.trim()) {
    const decoded = decodeToken(raw);
    if (decoded.kind !== 'Firebase ID token') throw new Error(`${label}: use a Firebase ID token.`);
    identities.push({ label, token: decoded.token });
  }
  return { project, targets, identities, total: targets.length * identities.length };
}
export async function runAudit(plan, { stopped = () => false, onProgress = () => {}, onSample = () => {}, verify = true, privateScope = false, read = readWithToken, demo = false, concurrency = 1, rateLimit = 0, limit = 1, engine = 'rest', discover = false, maxPaths = 500 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error('Concurrency must be 1–50.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Audit sample limit must be 1–100.');
  if (!Number.isInteger(rateLimit) || rateLimit < 0 || rateLimit > 100) throw new Error('Read rate must be 0–100 per second.');
  if (!Number.isInteger(maxPaths) || maxPaths < plan.targets.length || maxPaths > 500) throw new Error('Discovery path budget must cover the initial scope and be at most 500.');
  const report = { tool: 'Firelab AutoPwn', environment: LAB ? 'local-emulator' : 'firebase', version: '1.14.1', demo, engine, startedAt: new Date().toISOString(), project: plan.project, status: 'running', plannedRequests: plan.total, concurrency, sampleLimit: limit, discovery: { enabled: discover, addedPaths: 0, limitReached: false, maxPaths }, privateScope, tokens: [], requests: [], mutations: [], findings: [], coverage: { tested: 'Explicit Firestore (default) list/query or get requests with the recorded identities and sample limit', untested: ['Create, update, delete permissions (unless canary results are present)', 'Realtime Database, Storage, Functions and IAM', 'Other paths, queries, databases and identities', 'Revocation, disabled accounts and App Check enforcement'] } };
  const fingerprints = new Map();
  report.rateLimit = rateLimit;
  let gate = Promise.resolve(), nextStart = 0;
  async function permit() {
    const before = gate;
    let release;
    gate = new Promise(resolve => { release = resolve; });
    await before;
    try {
      while (!stopped() && performance.now() < nextStart) await new Promise(resolve => setTimeout(resolve, Math.min(50, nextStart - performance.now())));
      if (stopped()) return false;
      nextStart = performance.now() + (rateLimit ? 1000 / rateLimit : 0);
      return true;
    } finally { release(); }
  }
  for (const identity of plan.identities.filter(i => i.token)) {
    if (stopped()) break;
    const decoded = decodeToken(identity.token);
    const check = { identity: identity.label, fingerprint: await fingerprint(identity.token), failedClaims: claimChecks(decoded, plan.project).filter(c => !c.pass).map(c => c.name), signature: 'not checked' };
    if (verify && !stopped()) {
      try { const result = await verifyToken(identity.token, plan.project); check.signature = result.signatureValid ? 'valid' : 'invalid'; }
      catch { check.signature = 'verification unavailable or unsupported'; }
    }
    fingerprints.set(identity.label, check.fingerprint); report.tokens.push(check);
  }
  const jobs = plan.targets.flatMap(target => plan.identities.map(identity => ({ ...target, ...identity })));
  let next = 0;
  const seen = new Set(plan.targets.map(t => t.path));
  function expand(job, response) {
    if (!discover) return;
    const found = new Set(), prefix = `projects/${plan.project}/databases/(default)/documents/`;
    function walk(v, depth = 0) {
      if (depth > 12) return;
      if (typeof v === 'string' && v.startsWith(prefix)) found.add(v.slice(prefix.length));
      else if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child, depth+1);
    }
    for (const doc of sampleDocuments(plan.project,job,response)) { found.add(doc.path); walk(doc.data); }
    for (const path of found) {
      if (seen.has(path)) continue;
      try { buildReadURL(plan.project,path,'document'); } catch { continue; }
      if (seen.size >= maxPaths) { report.discovery.limitReached = true; break; }
      seen.add(path); report.discovery.addedPaths++;
      for (const identity of plan.identities) jobs.push({ path, kind: 'document', ...identity });
      report.plannedRequests = jobs.length;
    }
  }
  async function worker() {
    while (!stopped() && next < jobs.length) {
      const job = jobs[next++];
      if (!await permit()) break;
      let evidence, response;
      try { response = await read({ project: plan.project, ...job, limit }); evidence = response.evidence; }
      catch { evidence = { time: new Date().toISOString(), project: plan.project, path: job.path, kind: job.kind, identity: job.label, method: 'GET', http: null, outcome: 'request error', durationMs: 0 }; }
      if (fingerprints.has(job.label)) evidence.tokenFingerprint = fingerprints.get(job.label);
      evidence.engine = engine;
      report.requests.push(evidence);
      if (response && evidence.outcome === 'readable' && !stopped()) { try { onSample(job, response); expand(job,response); } catch { report.sampleWarning = 'Some returned data could not be added to the graph.'; } }
      if (job.label === 'No token' && evidence.outcome === 'readable') report.findings.push({ path: job.path, operation: job.kind === 'collection' ? 'list' : 'get', finding: privateScope ? 'Unexpected unauthenticated read: differs from your private-scope expectation' : 'Unauthenticated read observed: review intended access', severity: privateScope ? 'review required' : 'observation', ...(job.kind === 'collection' ? { returnedData: evidence.sampledDocuments > 0, note: evidence.sampledDocuments > 0 ? 'Returned sample documents' : 'Empty or unreported sample; collection existence is not established' } : {}) });
      onProgress(report);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  const index = new Map();
  for (const row of report.requests) { if (!index.has(row.path)) index.set(row.path, []); index.get(row.path).push(row); }
  for (const [path, rows] of index) if (rows.some(r => r.outcome === 'readable') && rows.some(r => r.outcome === 'denied')) report.findings.push({ path, finding: 'Read permission differs across tested identities', severity: 'observation' });
  report.status = stopped() ? 'stopped' : 'complete'; report.completedRequests = report.requests.length; report.finishedAt = new Date().toISOString();
  return report;
}

export function diffReports(previous, current) {
  if (!previous || previous.project !== current.project || previous.engine !== current.engine || previous.demo !== current.demo || previous.sampleLimit !== current.sampleLimit || (previous.environment || 'firebase') !== (current.environment || 'firebase')) return [];
  const key = r => `${r.path}\0${r.kind}\0${r.identity}\0${r.tokenFingerprint || ''}`;
  const old = new Map(previous.requests.map(r => [key(r), r]));
  return current.requests.flatMap(r => { const before = old.get(key(r)); return before && before.outcome !== r.outcome ? [{ path: r.path, identity: r.identity, before: before.outcome, after: r.outcome }] : []; });
}
export function markdownReport(report) {
  const safe = x => String(x ?? '—').replace(/[\\|`<>\r\n\[\]()]/g, ' ');
  const lines = ['# Firelab audit', '', `Project: ${safe(report.project)} · ${safe(report.status)} · ${report.demo ? 'Simulated' : report.environment === 'local-emulator' ? 'Local emulator evidence' : 'Live request evidence'}`, '', '| Path | Identity | HTTP | Read outcome |', '| --- | --- | --- | --- |'];
  for (const r of report.requests) lines.push(`| ${safe(r.path)} | ${safe(r.identity)} | ${safe(r.http)} | ${safe(r.outcome)} |`);
  if (report.mutations?.length) { lines.push('', '## Canary checks', '', '| Collection | Identity | Create | Update | Delete | Cleanup |', '| --- | --- | --- | --- | --- | --- |'); for (const m of report.mutations) lines.push(`| ${safe(m.collection)} | ${safe(m.identity)} | ${safe(m.create)} | ${safe(m.update)} | ${safe(m.delete)} | ${safe(m.cleanupRequired ? m.path : 'Complete / not needed')} |`); }
  if (report.discovery?.enabled) lines.push('', `Document follow-up: ${report.discovery.addedPaths} added paths. Budget reached: ${report.discovery.limitReached ? 'yes; discovery incomplete' : 'no'}.`);
  if (report.highlights) {
    lines.push('', '## Findings to review', '', safe(report.highlights.scope));
    for (const [group, entries] of Object.entries(report.highlights.groups)) {
      lines.push('', `### ${safe(group)} (${entries.length})`, '');
      for (const entry of entries) lines.push(`- ${Object.entries(entry).map(([key,val]) => `${safe(key)}: ${safe(Array.isArray(val) ? val.join(', ') : val)}`).join(' · ')}`);
    }
  }
  lines.push('', '## Coverage', '', `Environment: ${report.environment || 'firebase'}`, '', ...report.coverage.untested.map(x => `- Not established: ${safe(x)}`), '', 'Raw credentials and response bodies are excluded. Readable content alone is not proof of a vulnerability.');
  return lines.join('\n');
}
