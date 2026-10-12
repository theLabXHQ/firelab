import { setupScanHistory } from './scan-history.js?v=1.14.1';
import { buildFindings, findingsJSONL, isInconclusive } from './audit-findings.js?v=1.14.1';
import { createSampleStore } from './audit-samples.js?v=1.14.1';
import { auditPlan, runAudit, diffReports, markdownReport } from './audit-engine.js?v=1.14.1';
import { selectScope, COLLECTION_CANDIDATES } from './collection-candidates.js?v=1.14.1';
import { probeCanary } from './audit-write.js?v=1.14.1';
export { auditPlan, runAudit } from './audit-engine.js?v=1.14.1';

export function setupAutoPwn(download, { context = async () => null, navigate = () => {}, openPath = () => {}, onComplete = () => {}, showGraph = () => {}, onInvalidate = () => {} } = {}) {
  const $ = id => document.getElementById(id);
  let active = false, stop = false, generation = 0, report = null, displayed = null, previous = null, retryPaths = null, mutationActive = false, lastRender = 0, renderedRequests = null, renderedCount = 0;
  const cleanup = [];
  $('audit-candidate-count').textContent = COLLECTION_CANDIDATES.length;
  const status = text => { $('audit-status').textContent = text; };
  const history = setupScanHistory({ getReport: () => report, isBusy: () => active, notice: status, download });
  function matrix(value) {
    displayed = value;
    const cell = (tag, text) => { const n = document.createElement(tag); n.textContent = text; return n; };
    const identities = [...new Set(value.requests.map(r => r.identity))];
    const head = document.createElement('tr');
    for (const label of ['Path / operation', ...identities.map(i => i === 'No token' ? 'Without login' : i), 'Create / Update / Delete', '']) head.append(cell('th', label));
    $('audit-matrix-head').replaceChildren(head); $('audit-matrix-body').replaceChildren();
    const groups = new Map();
    for (const r of value.requests) { if (!groups.has(r.path)) groups.set(r.path, []); groups.get(r.path).push(r); }
    const byCollection = new Map();
    for (const m of value.mutations || []) { if (!byCollection.has(m.collection)) byCollection.set(m.collection, []); byCollection.get(m.collection).push(m); }
    for (const [path, rows] of groups) {
      const filter = $('audit-filter').value;
      if (!path.toLowerCase().includes($('audit-search').value.toLowerCase())) continue;
      if (filter === 'interesting' && rows.every(r => r.outcome === 'readable' && r.kind === 'collection' && r.sampledDocuments === 0) && !(value.mutations || []).some(m => m.collection === path)) continue;
      if (filter === 'public' && !rows.some(r => r.identity === 'No token' && r.outcome === 'readable')) continue;
      if (filter === 'denied' && !rows.some(r => r.outcome === 'denied')) continue;
      if (filter === 'error' && !rows.some(r => isInconclusive(r))) continue;
      const tr = document.createElement('tr'), pathCell = cell('td', path);
      const hint = cell('small', rows[0].kind === 'collection' ? 'List collection' : 'Get document'); pathCell.append(hint); tr.append(pathCell);
      for (const identity of identities) {
        const result = rows.find(r => r.identity === identity);
        const td = cell('td', ''), badge = cell('span', !result ? 'Pending' : result.outcome === 'readable' ? (result.kind === 'collection' && result.sampledDocuments === 0 ? 'Allowed · empty' : result.hasMore || result.mayHaveMore ? 'Allowed · more may exist' : 'Allowed') : result.outcome === 'denied' ? 'Denied' : result.outcome);
        badge.className = `access-state ${result?.outcome === 'readable' ? 'allowed' : result?.outcome === 'denied' ? 'denied' : 'other'}`;
        td.append(badge); tr.append(td);
      }
      const mutations = byCollection.get(path) || [];
      const writeCell = cell('td', '');
      if (!mutations.length) writeCell.textContent = 'Not tested';
      for (const m of mutations) {
        const line = cell('div', `${m.identity}: `); line.className = 'canary-outcome';
        for (const [i, [label, result]] of [['Add', m.create], ['Write', m.update], ['Delete', m.delete]].entries()) { if (i) line.append(document.createTextNode(' / ')); const badge = cell('span', `${label} ${result}`); badge.className = `access-state ${result === 'allowed' ? 'allowed' : result === 'denied' ? 'denied' : 'other'}`; line.append(badge); }
        if (m.update === 'not tested' || m.delete === 'not tested') line.append(cell('small', ' · Untested operations remain unknown; create denial does not establish update/delete denial.'));
        if (m.cleanupRequired) line.append(cell('strong', ' · Cleanup required'));
        writeCell.append(line);
      }
      tr.append(writeCell);
      const td = cell('td', ''), button = cell('button', 'Open in Firestore →'); button.type = 'button'; button.className = 'text-button';
      button.onclick = () => openPath({ project: value.project, path, kind: rows[0].kind }); td.append(button); tr.append(td); $('audit-matrix-body').append(tr);
    }
    if (!$('audit-matrix-body').children.length) { const tr = document.createElement('tr'), td = cell('td', 'No matching results.'); td.colSpan = identities.length + 3; tr.append(td); $('audit-matrix-body').append(tr); }
    $('audit-metric-checked').textContent = value.requests.length;
    $('audit-metric-public').textContent = value.requests.filter(r => r.identity === 'No token' && r.outcome === 'readable' && (r.kind === 'document' || r.sampledDocuments > 0)).length;
    $('audit-metric-errors').textContent = value.requests.filter(r => isInconclusive(r)).length;
  }
  ['audit-search', 'audit-filter'].forEach(id => $(id).addEventListener('input', () => { if (displayed) matrix(displayed); }));
  function renderHighlights(value) {
    $('audit-highlights').replaceChildren();
    if (!value.highlights) return;
    const labels = { publicData: 'Public data', identityDifferences: 'Identity permission differences', canaryAccess: 'Canary create / update / delete access', cleanup: 'Cleanup required', sensitiveFields: 'Sensitive-looking field names', errors: 'Inconclusive errors' };
    for (const [key,entries] of Object.entries(value.highlights.groups)) {
      if (!entries.length) continue;
      const detail = document.createElement('details'), title = document.createElement('summary');
      title.textContent = `${labels[key]} · ${entries.length}`; detail.append(title); detail.open = entries.length > 0 && key !== 'errors';
      const guidance = document.createElement('p'); guidance.textContent = entries[0].remediation;
      const retest = document.createElement('p'); retest.className = 'muted'; retest.textContent = `Retest: ${entries[0].retest}`;
      detail.append(guidance, retest);
      for (const entry of entries) {
        const row = document.createElement('article'); row.className = 'audit-highlight';
        const path = document.createElement('strong'); path.textContent = entry.path; row.append(path);
        const meta = document.createElement('p');
        meta.textContent = [entry.identity, entry.operation, entry.outcome, entry.fields?.join(', '), ...['create','update','delete'].filter(k => entry[k]).map(k => `${k}: ${entry[k]}`)].filter(Boolean).join(' · ');
        row.append(meta);
        const badge = document.createElement('span'); badge.className = 'finding-label'; badge.textContent = `${entry.checkId} · ${entry.priority} · ${entry.confidence}`; row.prepend(badge);
        if (entry.note) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = entry.note; row.append(note); }
        detail.append(row);
      }
      $('audit-highlights').append(detail);
    }
    if (!$('audit-highlights').children.length) $('audit-highlights').textContent = 'No review findings in completed requests and retained samples. Untested paths and operations remain unknown.';
  }
  function render(value) {
    history.update(); matrix(value); renderHighlights(value);
    if (renderedRequests !== value.requests || renderedCount > value.requests.length) { $('audit-results').replaceChildren(); renderedRequests = value.requests; renderedCount = 0; }
    const fragment = document.createDocumentFragment();
    for (const row of value.requests.slice(renderedCount)) {
      const tr = document.createElement('tr');
      for (const value of [row.path, row.kind === 'collection' ? 'list' : 'get', row.identity, row.http ?? '—', row.outcome]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
      fragment.append(tr);
    }
    $('audit-results').append(fragment); renderedCount = value.requests.length;
    $('audit-progress').max = value.plannedRequests; $('audit-progress').value = value.requests.length;
    $('audit-retry').disabled = active || !value.requests.some(r => isInconclusive(r));
    status(`${value.requests.length} / ${value.plannedRequests} reads · ${value.status}${value.demo ? ' · Demo (simulated)' : value.environment === 'local-emulator' ? ' · Local emulator' : ''}`);
    const readable = value.requests.filter(r => r.outcome === 'readable').length;
    const denied = value.requests.filter(r => r.outcome === 'denied').length;
    const empty = value.requests.filter(r => r.outcome === 'readable' && r.kind === 'collection' && r.sampledDocuments === 0).length;
    $('audit-summary').textContent = `${readable - empty} reads returned data · ${empty} empty reads · ${denied} permission denied · ${value.requests.length - readable - denied} other outcomes. ${value.status === 'complete' ? 'Finished. Review public access against what your app should allow.' : value.status === 'stopped' ? 'Stopped. Results cover completed requests only.' : 'Checking access…'}`;
    $('audit-summary').textContent += ' Scope is limited to tested paths, identities and payloads. No finding does not establish that the project is secure. Write checks apply only to temporary test documents.';
    const mutations = value.mutations || [];
    const writeCounts = Object.fromEntries(['create','update','delete'].map(operation => {
      const outcomes = mutations.map(m => m[operation]);
      return [operation, { allowed: outcomes.filter(x => x === 'allowed').length, denied: outcomes.filter(x => x === 'denied').length, unknown: outcomes.filter(x => !['allowed','denied'].includes(x)).length }];
    }));
    const plan = value.canaryPlan;
    $('audit-write-coverage').textContent = plan ? `${mutations.length}/${plan.selected} selected canary sequences returned results (${plan.selected - mutations.length} not started); ${plan.eligible - plan.selected} eligible collection/identity pairs excluded by the limit. ${plan.approved ? '' : 'Write review was not approved; no canary permission conclusion.'} ${Object.entries(writeCounts).map(([operation,c]) => `${operation}: ${c.allowed} allowed, ${c.denied} denied, ${c.unknown} unknown/not tested`).join(' · ')}. Existing application documents and other schemas remain untested.` : 'Write checks were not run. Read access does not establish create, update or delete permissions.';
    if (value.discovery?.enabled) $('audit-summary').textContent += ` Follow-up: ${value.discovery.addedPaths} document paths added.${value.discovery.limitReached ? ' Path budget reached; discovery is incomplete.' : ''}`;
    $('audit-observations').replaceChildren();
    for (const finding of value.findings.filter(f => f.returnedData !== false || f.severity === 'review required')) { const item = document.createElement('li'); item.textContent = `${finding.path}: ${finding.finding}`; $('audit-observations').append(item); }
    $('audit-changes').textContent = (value.changes || []).length ? value.changes.map(c => `${c.path} · ${c.identity}: ${c.before} → ${c.after}`).join('\n') : 'No comparable outcome changes recorded. Comparisons require matching project, engine, sample limit and credential fingerprint.';
    $('audit-findings').textContent = JSON.stringify({ tokens: value.tokens, findings: value.findings, coverage: value.coverage, graphSample: value.graphSample, mutations: value.mutations, changes: value.changes }, null, 2);
  }
  function clear() { $('audit-write-coverage').textContent = 'Write permissions have not been tested.'; renderedRequests = null; renderedCount = 0; $('audit-highlights').replaceChildren(); onInvalidate(); $('audit-graph-status').textContent = 'Readable document samples will appear in the graph, separated by identity.'; $('audit-open-graph').disabled = true; $('audit-changes').textContent = 'No previous scan comparison.'; previous = null; retryPaths = null; $('audit-markdown').disabled = true; $('audit-jsonl').disabled = true; $('audit-retry').disabled = true; displayed = null; $('audit-matrix-head').replaceChildren(); $('audit-matrix-body').replaceChildren(); for (const id of ['audit-metric-checked', 'audit-metric-public', 'audit-metric-errors']) $(id).textContent = '0'; generation++; stop = true; report = null; $('audit-observations').replaceChildren(); $('audit-results').replaceChildren(); $('audit-findings').textContent = 'No audit yet.'; $('audit-progress').value = 0; $('audit-export').disabled = true; $('audit-summary').textContent = 'Connect a project, then press Start. Project, session and suggested paths are filled automatically.'; status('Ready to start. No requests sent.'); history.update(); }
  $('audit-stop').onclick = () => { stop = true; status('Stopping after the current request…'); };
  function cleanupView() {
    $('audit-cleanup').hidden = !cleanup.length;
    $('audit-cleanup-paths').textContent = cleanup.map(m => `${m.project} · ${m.path} · ${m.identity}: create=${m.create}; delete=${m.delete}`).join('\n');
  }
  window.addEventListener('beforeunload', e => { if (mutationActive) { e.preventDefault(); e.returnValue = ''; } });
  $('audit-cleanup-export').onclick = () => download(new Blob([JSON.stringify({ note: 'Possible remaining canaries; verify ownership and state before manual cleanup.', entries: cleanup }, null, 2)], { type: 'application/json' }), 'firelab-cleanup.json');
  async function reviewWrites(jobs, update, demo) {
    const dialog = $('audit-write-review'); dialog.returnValue = 'cancel';
    $('audit-write-detail').textContent = JSON.stringify({ project: jobs[0].project, demo, operations: update ? ['create', 'update', 'delete canary'] : ['create', 'delete canary'], payload: { firelabProbe: '_firelab_probe_<uuid>', createdAt: 'current timestamp', phase: 'created / updated' }, targets: jobs.map(j => ({ path: `${j.collection}/${j.probeId}`, identity: j.label })) }, null, 2);
    dialog.showModal(); return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  }
  async function start(skipLogin = false) {
    if (active) return;
    active = true; stop = false; const preparing = generation;
    const retry = retryPaths; retryPaths = null;
    $('audit-markdown').disabled = true; $('audit-jsonl').disabled = true; $('audit-retry').disabled = true;
    $('audit-run').disabled = true;
    try {
      const ctx = await context();
      if (preparing !== generation) return;
      if (!ctx && !$('token-project').value.trim()) {
        navigate('overview'); status('Connect your Firebase project first, then press AutoPwn.'); return;
      }
      if (ctx) $('token-project').value = ctx.project;
      if (skipLogin !== true && ctx && !ctx.signedIn && !$('jwt-a').value.trim() && !$('jwt-b').value.trim()) {
        const dialog = $('audit-login'); dialog.returnValue = 'cancel'; dialog.showModal();
        const choice = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
        if (preparing !== generation) return;
        if (choice === 'login') { navigate('auth', true); return; }
        if (choice !== 'public') return;
      }
      if (ctx?.token) $('jwt-a').value = ctx.token;
      const scope = retry ? { paths: retry, source: 'Retrying paths with inconclusive request errors' } : selectScope({ mode: $('audit-scope-mode').value, custom: $('audit-paths').value, known: ctx?.paths || [] });
      $('audit-scope-note').textContent = `Project: ${$('token-project').value}. ${scope.source} · ${scope.paths.length} paths. Candidates are not proof that collections exist.`;
      const plan = auditPlan($('token-project').value.trim(), scope.paths.join('\n'), ctx?.demo ? [] : [['Token A', $('jwt-a').value], ['Token B', $('jwt-b').value]]);
      const engine = $('audit-engine').value;
      if (engine === 'sdk') {
        if (!ctx) throw new Error('Connect a project to use the Client SDK engine.');
        plan.identities = [{ label: 'Current session (Client SDK)', token: ctx.token || null }];
      } else if (ctx?.demo && ctx.signedIn) plan.identities.push({ label: 'Signed-in demo', token: null });
      plan.total = plan.targets.length * plan.identities.length;
      const aggressive = $('audit-profile').value === 'aggressive';
      const concurrency = Number($('audit-concurrency').value), limit = Number($('audit-sample').value);
      const writeEnabled = $('audit-writes').checked, update = $('audit-updates').checked, writeLimit = Number($('audit-write-limit').value);
      if (!Number.isInteger(writeLimit) || writeLimit < 1 || writeLimit > 100) throw new Error('Canary limit must be between 1 and 100.');
      const oldReport = report; const samples = createSampleStore();
      active = true; stop = false; const current = ++generation; report = null;
      onInvalidate(); $('audit-highlights').replaceChildren(); $('audit-open-graph').disabled = true; $('audit-graph-status').textContent = 'Scan running. New graph samples will be available when it finishes.';
      matrix({ project: plan.project, requests: [] }); $('audit-observations').replaceChildren();
      $('audit-run').disabled = true; $('audit-stop').disabled = false; $('audit-export').disabled = true;
      $('audit-results').replaceChildren(); $('audit-findings').textContent = 'Checking token metadata…'; status(`Starting ${plan.total} reads across ${plan.targets.length} paths…`);
      const value = await runAudit(plan, { stopped: () => stop || current !== generation, verify: $('audit-verify').checked, privateScope: $('audit-private').checked, concurrency, rateLimit: ctx?.demo ? 0 : Number($('audit-rate').value), limit, engine, discover: aggressive && !retry && $('audit-scope-mode').value !== 'custom', ...(engine === 'sdk' ? { read: ctx.sdkRead, demo: Boolean(ctx.demo) } : ctx?.demo ? { read: ctx.read, demo: true } : {}), onSample: (job, response) => samples.add(plan.project, job, response), onProgress: value => { if (current === generation && performance.now() - lastRender > 100) { lastRender = performance.now(); render(value); } } });
      value.scopeSource = scope.source; value.configuredRateLimit = Number($('audit-rate').value);
      if (writeEnabled && current === generation && !stop) {
        status('Reads complete. Preparing the canary write review…');
        const pathOrder = new Map(plan.targets.map((t, i) => [t.path, i])), identityOrder = new Map(plan.identities.map((v, i) => [v.label, i]));
        const eligible = value.requests.filter(r => r.kind === 'collection' && ['readable', 'denied'].includes(r.outcome));
        eligible.sort((a, b) => (pathOrder.get(a.path) ?? 500) - (pathOrder.get(b.path) ?? 500) || identityOrder.get(a.identity) - identityOrder.get(b.identity));
        const allowed = eligible.slice(0, writeLimit);
        const jobs = allowed.map(r => ({ project: plan.project, collection: r.path, label: r.identity, token: plan.identities.find(i => i.label === r.identity)?.token || null, probeId: `_firelab_probe_${crypto.randomUUID()}` }));
        value.canaryPlan = { requested: true, eligible: eligible.length, selected: jobs.length, limit: writeLimit, update, approved: false };
        if (jobs.length && await reviewWrites(jobs, update, Boolean(ctx?.demo)) && current === generation && !stop) {
          value.canaryPlan.approved = true;
          for (const job of jobs) {
            if (current !== generation || stop) break;
            mutationActive = true; status(`Canary check: ${job.collection} · ${job.label}. Cleanup runs before the next check.`);
            let result;
            try { result = await probeCanary({ ...job, update, ...(ctx?.demo ? { commit: ctx.canaryCommit(job.label) } : {}) }); }
            catch { result = { project: job.project, collection: job.collection, path: `${job.collection}/${job.probeId}`, identity: job.label, create: 'unknown: check interrupted', update: 'not tested', delete: 'not tested', cleanupRequired: true }; }
            finally { mutationActive = false; }
            value.mutations.push(result);
            if (result.cleanupRequired) { cleanup.push(result); cleanupView(); }
            if (current === generation) render(value);
          }
          value.coverage.tested += '; conditional synthetic canary operations listed in mutations (REST commits)';
          value.coverage.untested[0] = 'Write/delete access to other schemas, paths, identities and existing application documents';
        }
      }
      if (current === generation) {
        previous = oldReport; value.changes = diffReports(previous, value); value.finishedAt = new Date().toISOString();
        if (stop) value.status = 'stopped';
        const snapshot = samples.snapshot(); value.profile = aggressive ? 'aggressive' : 'standard'; value.highlights = buildFindings(value, snapshot); value.graphSample = { documents: snapshot.count, bytes: snapshot.bytes, truncated: snapshot.truncated };
        onComplete(value, snapshot); $('audit-graph-status').textContent = `${snapshot.count} document samples retained for the graph.${snapshot.truncated ? ' Graph sample limit reached; remaining data was not retained.' : ''} Scan reports exclude document bodies; graph exports include sampled data.`; $('audit-open-graph').disabled = !snapshot.count;
        report = value; render(value); $('audit-export').disabled = false; $('audit-markdown').disabled = false; $('audit-jsonl').disabled = false;
      }
    } catch (e) { status(e.message || 'Audit failed.'); }
    finally { active = false; history.update(); $('audit-run').disabled = false; $('audit-stop').disabled = true; if (report) { $('audit-retry').disabled = !report.requests.some(isInconclusive); $('audit-markdown').disabled = false; $('audit-jsonl').disabled = false; } }
  };
  $('audit-profile').onchange = () => {
    const aggressive = $('audit-profile').value === 'aggressive';
    $('audit-scope-mode').value = aggressive ? 'discovery' : 'auto'; $('audit-concurrency').value = aggressive ? '50' : '5'; $('audit-sample').value = aggressive ? '100' : '5';
    clear(); status(aggressive ? 'Aggressive ready: discovery, 50 parallel reads, 100-document samples, document/reference follow-up up to 500 total paths. Writes keep their separate review.' : 'Standard profile ready.');
  };
  $('audit-run').onclick = () => start();
  $('audit-open-graph').onclick = showGraph;
  $('audit-retry').onclick = () => { if (!report || active) return; retryPaths = [...new Set(report.requests.filter(r => isInconclusive(r)).map(r => r.path))]; $('audit-writes').checked = false; $('audit-mode-badge').textContent = 'READ-ONLY'; start(); };
  $('audit-jsonl').onclick = () => { if (report) download(new Blob([findingsJSONL(report)], { type: 'application/x-ndjson' }), 'firelab-findings.jsonl'); };
  $('audit-markdown').onclick = () => { if (report) download(new Blob([markdownReport(report)], { type: 'text/markdown' }), 'firelab-audit.md'); };
  $('audit-writes').addEventListener('input', () => { if ($('audit-writes').checked) $('audit-updates').checked = true; $('audit-mode-badge').textContent = $('audit-writes').checked ? 'CANARY WRITES · REVIEW REQUIRED' : 'READ-ONLY'; });
  $('audit-export').onclick = () => { if (report) download(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), 'firelab-autopwn.json'); };
  ['jwt-a', 'jwt-b', 'token-project', 'audit-paths', 'audit-private', 'audit-verify', 'audit-scope-mode', 'audit-engine', 'audit-concurrency', 'audit-rate', 'audit-sample', 'audit-writes', 'audit-updates', 'audit-write-limit'].forEach(id => $(id).addEventListener('input', clear));
  return { clear, start };
}
