import { diffReports } from './audit-engine.js?v=1.14.1';

const KEY = 'firelab.scan-history.v1', SCHEMA = 'firelab.scan-history/v1';
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
function rows(value, max) { if (!Array.isArray(value) || value.length > max) throw new Error('Invalid scan evidence or limit exceeded.'); return value; }
export function cleanReport(value) {
  if (!value || !/^[a-z][a-z0-9-]{3,62}$/.test(value.project) || !['complete','stopped'].includes(value.status)) throw new Error('Finish or stop a scan before saving it.');
  if (!Number.isInteger(value.sampleLimit) || value.sampleLimit < 1 || value.sampleLimit > 100) throw new Error('Invalid saved scan sample limit.');
  if (!['rest','sdk'].includes(value.engine) || value.environment && !['firebase','local-emulator'].includes(value.environment)) throw new Error('Unsupported scan environment or engine.');
  return {
    tool: 'Firelab AutoPwn', version: text(value.version, 20), project: value.project, environment: value.environment || 'firebase', demo: Boolean(value.demo), engine: value.engine,
    status: value.status, startedAt: text(value.startedAt, 40), finishedAt: text(value.finishedAt, 40), sampleLimit: number(value.sampleLimit), plannedRequests: number(value.plannedRequests),
    requests: rows(value.requests, 1500).map(r => ({ path: text(r.path, 1500), kind: r.kind === 'document' ? 'document' : 'collection', identity: text(r.identity), tokenFingerprint: /^[a-f0-9]{16}$/.test(r.tokenFingerprint || '') ? r.tokenFingerprint : null, outcome: text(r.outcome, 80), http: Number.isInteger(r.http) ? r.http : null, sampledDocuments: number(r.sampledDocuments), hasMore: Boolean(r.hasMore || r.mayHaveMore), durationMs: number(r.durationMs) })),
    mutations: rows(value.mutations || [], 100).map(m => ({ project: value.project, collection: text(m.collection, 1500), path: text(m.path, 1600), identity: text(m.identity), create: text(m.create, 80), update: text(m.update, 80), delete: text(m.delete, 80), cleanupRequired: Boolean(m.cleanupRequired) })),
    canaryPlan: value.canaryPlan ? { requested: Boolean(value.canaryPlan.requested), eligible: number(value.canaryPlan.eligible), selected: number(value.canaryPlan.selected), limit: number(value.canaryPlan.limit), update: Boolean(value.canaryPlan.update), approved: Boolean(value.canaryPlan.approved) } : null,
    coverage: { note: 'Saved permission evidence only. Credentials, document values and graph samples are excluded. Untested paths, identities and schemas remain unknown.' }
  };
}
const readKey = r => JSON.stringify([r.path,r.kind,r.identity,r.tokenFingerprint || '']);
export function compareSavedReports(before, after) {
  const mismatches = ['project','engine','demo','sampleLimit'].filter(k => before[k] !== after[k]);
  if ((before.environment || 'firebase') !== (after.environment || 'firebase')) mismatches.push('environment');
  if (mismatches.length) return { compatible: false, reason: `Cannot compare different ${mismatches.join(', ')}.`, readChanges: [], writeChanges: [] };
  const old = new Map(before.requests.map(r => [readKey(r), r])), current = new Map(after.requests.map(r => [readKey(r), r]));
  const matched = after.requests.filter(r => old.has(readKey(r)));
  function writeMap(report) {
    const fingerprints = new Map(report.requests.filter(r => r.kind === 'collection').map(r => [JSON.stringify([r.path,r.identity]),r.tokenFingerprint || '']));
    return new Map(report.mutations.map(m => [JSON.stringify([m.collection,m.identity,fingerprints.get(JSON.stringify([m.collection,m.identity])) || '']),m]));
  }
  const previousWrites = writeMap(before), writeChanges = [];
  for (const [key, m] of writeMap(after)) {
    const prior = previousWrites.get(key); if (!prior) continue;
    for (const operation of ['create','update','delete']) if (prior[operation] !== m[operation]) writeChanges.push({ path: m.collection, identity: m.identity, operation, before: prior[operation], after: m[operation], kind: [prior[operation],m[operation]].every(x => ['allowed','denied'].includes(x)) ? 'permission outcome changed' : 'test coverage or inconclusive outcome changed' });
  }
  return { compatible: true, matchingReads: matched.length, readChanges: diffReports(before,after), writeChanges,
    unmatchedBefore: before.requests.filter(r => !current.has(readKey(r))).length, unmatchedAfter: after.requests.filter(r => !old.has(readKey(r))).length,
    note: 'Only matching paths, operations, identity labels and credential fingerprints are compared. Refreshed tokens and unmatched scope are excluded. No changes is not proof of security.' };
}
export function scanHistoryStore(storage) {
  function read() {
    let raw; try { raw = storage().getItem(KEY); } catch { throw new Error('Browser storage is unavailable for scan history.'); }
    if (!raw) return [];
    let doc; try { doc = JSON.parse(raw); } catch { throw new Error('Saved scan history is unreadable; it was not overwritten.'); }
    if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.items) || doc.items.length > 20) throw new Error('Invalid saved scan history.');
    const ids = new Set();
    return doc.items.map(item => { if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('Invalid saved scan ID.'); ids.add(item.id); return { id: item.id, name: text(item.name, 80), report: cleanReport(item.report) }; });
  }
  function write(items) {
    const raw = JSON.stringify({ schema: SCHEMA, items });
    if (raw.length > 4 * 1024 * 1024) throw new Error('Scan history reached its size limit. Export or delete an older scan.');
    try { storage().setItem(KEY, raw); } catch { throw new Error('Scan history could not be saved. Browser storage is full or blocked.'); }
  }
  return { read,
    save(name, report) {
      const items = read(); if (items.length >= 20) throw new Error('History keeps up to 20 scans. Export or delete one first.');
      const clean = cleanReport(report), label = name.trim() || `${clean.project} · ${clean.finishedAt}`;
      if (label.length > 80) throw new Error('Use a scan name of at most 80 characters.');
      const entry = { id: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join(''), name: label, report: clean }; write([...items,entry]); return entry;
    },
    remove(id) { write(read().filter(item => item.id !== id)); }
  };
}
export function setupScanHistory({ getReport, isBusy, notice, download }) {
  const $ = id => document.getElementById(id), store = scanHistoryStore(() => localStorage);
  function update() { $('history-save').disabled = isBusy() || !getReport(); }
  function refresh(selected = $('history-selected').value) {
    const items = store.read(), baseline = $('history-baseline').value;
    for (const id of ['history-selected','history-baseline']) $(id).replaceChildren(new Option('Select a saved scan…',''), ...items.map(item => new Option(item.name,item.id)));
    $('history-selected').value = items.some(item => item.id === selected) ? selected : '';
    $('history-baseline').value = items.some(item => item.id === baseline) ? baseline : '';
    $('history-count').textContent = `${items.length}/20 scans saved locally. Save is manual; document values and raw tokens are excluded.`;
    update();
  }
  function selected(id = 'history-selected') { const item = store.read().find(item => item.id === $(id).value); if (!item) throw new Error('Select a saved scan.'); return item; }
  const action = fn => () => { if (isBusy()) { notice('Wait for the current scan to finish.'); return; } try { fn(); } catch (e) { notice(e.message || 'Scan history operation failed.'); } };
  $('history-save').onclick = action(() => { const item = store.save($('history-name').value,getReport()); refresh(item.id); notice(`Saved permission evidence: ${item.name}`); });
  $('history-open').onclick = action(() => { const item = selected(); $('history-preview').textContent = JSON.stringify(item.report,null,2); $('history-preview-details').open = true; });
  $('history-export').onclick = action(() => { const item = selected(); download(new Blob([JSON.stringify(item,null,2)],{type:'application/json'}),'firelab-saved-scan.json'); });
  $('history-delete').onclick = action(() => { const item = selected(); if (!confirm(`Delete saved scan “${item.name}”?`)) return; store.remove(item.id); $('history-preview').textContent = ''; $('history-comparison').textContent = ''; refresh(); });
  $('history-compare').onclick = action(() => {
    const before = selected('history-baseline'), after = selected(), result = compareSavedReports(before.report,after.report);
    const lines = [`${before.name} → ${after.name}`];
    if (!result.compatible) lines.push(result.reason);
    else {
      lines.push(`${result.matchingReads} matching read cases · ${result.readChanges.length} read changes · ${result.writeChanges.length} write/coverage changes`, `${result.unmatchedBefore} earlier and ${result.unmatchedAfter} later read cases were not compared (scope or credential differences).`);
      for (const change of result.readChanges) lines.push(`Read · ${change.path} · ${change.identity}: ${change.before} → ${change.after}`);
      for (const change of result.writeChanges) lines.push(`${change.operation} · ${change.path} · ${change.identity}: ${change.before} → ${change.after} (${change.kind})`);
      lines.push(result.note);
    }
    $('history-comparison').textContent = lines.join('\n');
  });
  window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) { try { refresh(); } catch (e) { notice(e.message); } } });
  try { refresh(); } catch (e) { $('history-count').textContent = e.message; update(); }
  return { update };
}
