export function securityReview(config = {}, audit = null, raw = '') {
  const checks = [];
  const add = (title, status, action, source) => checks.push({ title, status, action, source });
  if (/-----BEGIN (?:RSA )?PRIVATE KEY-----|"private_key"\s*:|"type"\s*:\s*"service_account"/.test(raw)) add('Private server credential detected', 'Action required', 'Remove this credential from client code. Rotate it through the owning service if it was exposed; keep Admin credentials on a trusted server.', 'https://firebase.google.com/docs/admin/setup');
  add('Client Firebase API key', config.apiKey ? 'Present — not an access control' : 'Not supplied', 'A Firebase client key identifies a project. Review API restrictions; use separate restricted keys for non-Firebase APIs. Hiding this config does not protect data.', 'https://firebase.google.com/docs/projects/api-keys');
  add('Security Rules', 'Owner review required', 'Define intended access for each path and test signed-out, owner, other-user and role-based requests. Inspect create, update and delete separately.', 'https://firebase.google.com/docs/rules/basics');
  add('App Check', 'Not verified', 'Configure app attestation, inspect metrics, then enforce supported services after validating legitimate clients.', 'https://firebase.google.com/docs/app-check');
  add('Authentication and IAM', 'Not verified', 'Review enabled providers, authorized domains, account protections, backend token validation and least-privilege project roles.', 'https://firebase.google.com/docs/auth/admin/verify-id-tokens');
  add('Regression tests', 'Owner review required', 'Run positive and negative access cases in the Firebase Emulator Suite before deploying changed rules. Keep test fixtures separate from production data.', 'https://firebase.google.com/docs/rules/unit-tests');
  const comparable = Boolean(audit && config.projectId && audit.project === config.projectId && Array.isArray(audit.requests));
  const publicReads = comparable ? audit.requests.filter(r => r.identity === 'No token' && r.outcome === 'readable').map(r => ({ path: r.path, kind: r.kind, sampledDocuments: r.sampledDocuments ?? null })) : [];
  return { tool: 'Firelab developer review', project: config.projectId || null, time: new Date().toISOString(), checks, publicReads, findings: comparable ? audit.highlights || null : null, scanContext: comparable ? { demo: audit.demo, engine: audit.engine, status: audit.status } : null, note: 'Local guidance and scoped observations, not a security certification. No configuration, rules or keys were changed.' };
}
function baselineTests(owner) {
  return `import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-firelab-rules',
    firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.rules', 'utf8') }
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'users/owner'), { name: 'Synthetic fixture' });
    await setDoc(doc(db, 'users/owner/notes/item'), { text: 'Synthetic note' });
    await setDoc(doc(db, 'private/item'), { value: 'Synthetic private fixture' });
  });
});
after(async () => { if (env) { try { await env.clearFirestore(); } finally { await env.cleanup(); } } });

for (const role of ['signed-out', 'owner', 'other-user']) {
  const database = () => role === 'signed-out' ? env.unauthenticatedContext().firestore() : env.authenticatedContext(role).firestore();
  test(role + ': user document read', async () => {
    const expect = ${owner ? "role === 'owner' ? assertSucceeds : assertFails" : 'assertFails'};
    await expect(getDoc(doc(database(), 'users/owner')));
  });
  test(role + ': nested collection read', async () => {
    const expect = ${owner ? "role === 'owner' ? assertSucceeds : assertFails" : 'assertFails'};
    await expect(getDocs(collection(database(), 'users/owner/notes')));
  });
  test(role + ': unrelated private path denied', async () => {
    await assertFails(getDoc(doc(database(), 'private/item')));
  });
  test(role + ': create denied', async () => {
    await assertFails(setDoc(doc(database(), 'users/owner/notes/new'), { text: 'Synthetic' }));
  });
  test(role + ': update denied', async () => {
    await assertFails(updateDoc(doc(database(), 'users/owner'), { name: 'Changed' }));
  });
  test(role + ': delete denied', async () => {
    await assertFails(deleteDoc(doc(database(), 'users/owner')));
  });
}
`;
}
export function ruleTemplates(mode) {
  if (!['deny', 'owner-read'].includes(mode)) throw new Error('Choose a supported baseline.');
  const owner = mode === 'owner-read';
  return {
    'firelab.rules.test.mjs': baselineTests(owner),
    'package.json': JSON.stringify({ name: 'firelab-rules-regression', private: true, type: 'module', engines: { node: '>=22' }, scripts: { test: 'firebase emulators:exec --only firestore --project demo-firelab-rules "node --test firelab.rules.test.mjs"' }, devDependencies: { '@firebase/rules-unit-testing': '5.0.2', firebase: '12.19.0', 'firebase-tools': '15.30.1' } }, null, 2),
    'firestore.rules': `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if false; }\n${owner ? '    match /users/{uid}/{document=**} {\n      allow read: if request.auth != null && request.auth.uid == uid;\n      allow write: if false;\n    }\n' : ''}  }\n}\n`,
    'storage.rules': `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{file=**} { allow read, write: if false; }\n${owner ? '    match /users/{uid}/{file=**} {\n      allow read: if request.auth != null && request.auth.uid == uid;\n      allow write: if false;\n    }\n' : ''}  }\n}\n`,
    'database.rules.json': JSON.stringify({ rules: { '.read': false, '.write': false, ...(owner ? { users: { '$uid': { '.read': 'auth != null && auth.uid === $uid', '.write': false } } } : {}) } }, null, 2),
    'firebase.json': JSON.stringify({ firestore: { rules: 'firestore.rules' }, storage: { rules: 'storage.rules' }, database: { rules: 'database.rules.json' }, emulators: { firestore: { port: 8080 }, auth: { port: 9099 }, storage: { port: 9199 }, database: { port: 9000 } } }, null, 2)
  };
}
export function ruleBundle(mode) {
  const encoder = new TextEncoder(), chunks = [], directory = [];
  let offset = 0, directorySize = 0, count = 0;
  const header = size => { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; };
  for (const [name, text] of Object.entries(ruleTemplates(mode))) {
    const filename = encoder.encode(name), data = encoder.encode(text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true);
    local.view.setUint16(12, 33, true); local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true); local.view.setUint32(22, data.length, true); local.view.setUint16(26, filename.length, true);
    chunks.push(local.bytes, filename, data);
    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true); central.view.setUint16(4, 20, true); central.view.setUint16(6, 20, true);
    central.view.setUint16(14, 33, true); central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true); central.view.setUint32(24, data.length, true); central.view.setUint16(28, filename.length, true); central.view.setUint32(42, offset, true);
    directory.push(central.bytes, filename); directorySize += 46 + filename.length;
    offset += 30 + filename.length + data.length; count++;
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, count, true); end.view.setUint16(10, count, true);
  end.view.setUint32(12, directorySize, true); end.view.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end.bytes], { type: 'application/zip' });
}
export function setupSecurity({ getConfig, getAudit, getRaw = () => '', download }) {
  const $ = id => document.getElementById(id); let report = null;
  $('security-run').onclick = () => {
    let config = {}; try { config = getConfig(); } catch {  }
    report = securityReview(config, getAudit(), getRaw());
    $('security-checks').replaceChildren();
    for (const check of report.checks) {
      const article = document.createElement('article'); article.className = 'security-check';
      const heading = document.createElement('h3'); heading.textContent = check.title;
      const status = document.createElement('strong'); status.textContent = check.status;
      const action = document.createElement('p'); action.textContent = check.action;
      const link = document.createElement('a'); link.textContent = 'Firebase documentation →'; link.href = check.source; link.target = '_blank'; link.rel = 'noreferrer';
      article.append(heading, status, action, link); $('security-checks').append(article);
    }
    $('security-observed').textContent = report.scanContext ? `${report.scanContext.demo ? 'DEMO · ' : ''}${report.publicReads.length} readable no-token paths in the latest matching scan. Review whether this access is intended.\n` + report.publicReads.map(r => `${r.path}${r.sampledDocuments === 0 ? ' (empty sample)' : ''}`).join('\n') : 'No matching AutoPwn scan available. Run AutoPwn to add access observations.';
    $('security-export').disabled = false;
  };
  $('security-export').onclick = () => { if (report) download(new Blob([JSON.stringify(report,null,2)], { type: 'application/json' }), 'firelab-security-review.json'); };
  function preview() { $('security-rule-preview').textContent = ruleTemplates($('security-baseline').value)[$('security-rule-file').value]; }
  $('security-baseline').onchange = preview; $('security-rule-file').onchange = preview;
  $('security-download-rule').onclick = () => { const name = $('security-rule-file').value; download(new Blob([ruleTemplates($('security-baseline').value)[name]], { type: 'text/plain' }), name); };
  $('security-download-bundle').onclick = () => download(ruleBundle($('security-baseline').value), `firelab-${$('security-baseline').value}-tests.zip`);
  preview();
  return { clear() { report = null; $('security-checks').replaceChildren(); $('security-observed').textContent = 'Run a local review to see guidance and matching scan observations.'; $('security-export').disabled = true; } };
}
