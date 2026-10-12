import { LAB } from './lab.js?v=1.14.1';
import { setupWorkspaces, WORKSPACE_SETTINGS } from './workspaces.js?v=1.14.1';
import { jsonObject, validatePath, classify, safeError, boundedNumber } from './core.js?v=1.14.1';
import * as firebase from './firebase.js?v=1.14.1';
import { createDemo } from './demo.js?v=1.14.1';
import { setupConfigInput } from './config-input.js?v=1.14.1';
import { createGraph } from './graph.js?v=1.14.1';
import { installIcons } from './icons.js?v=1.14.1';
import { setupSecurity } from './security.js?v=1.14.1';
import { setupTokens } from './token-ui.js?v=1.14.1';

const $ = id => document.getElementById(id);
const titles = { overview: 'Project', tokens: 'Tokens & requests', graph: 'Graph explorer', auth: 'Authentication', firestore: 'Firestore', realtime: 'Realtime Database', storage: 'Storage', functions: 'Functions', checks: 'Permission checks', activity: 'Activity', security: 'Secure your project' };
let resumeAudit = false, latestAudit = null, savedSetup = null;
let session = null, identity = null, busy = false, stopped = false, logs = [], latest = null, mfa = null, verifier = null, storagePage = null;

function notify(message, error = false) { $('notice').hidden = false; $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
installIcons();
const configInput = setupConfigInput(notify);
const graph = createGraph({
  notify,
  onRead: path => run('Graph: read collection', async () => { graph.loading(path); return dispatch('firestore', { operation: 'query', path, filters: [], limit: 10 }); }),
  onOpen: (path, operation, projectId) => { if (!session || session.config.projectId !== projectId) { notify('Connect the snapshot project before opening its SDK editor.', true); return; } $('fs-path').value = path; $('fs-operation').value = operation; $('fs-operation').onchange(); tab('firestore'); },
  onExport: data => { download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'firelab-graph.json'); notify('Graph exported. It includes sampled document data.'); }
});
const tokens = setupTokens({ download,
  onInvalidate: () => { latestAudit = null; graph.clearAudit(); security.clear(); },
  onComplete: (report, samples) => { latestAudit = report; graph.auditSamples(report.project, samples); },
  showGraph: () => tab('graph'),
  onCredential: kind => { if (session && !identity && !document.querySelector('dialog[open]')) promptConnection(kind); },
  auditMode: active => {
    $('autopwn-quick').classList.toggle('active', active);
    if (active) $('autopwn-quick').setAttribute('aria-current', 'page'); else $('autopwn-quick').removeAttribute('aria-current');
    const tokenNav = document.querySelector('.nav[data-tab="tokens"]'); tokenNav.classList.toggle('active', !active);
    if (active) tokenNav.removeAttribute('aria-current'); else tokenNav.setAttribute('aria-current', 'page');
    $('breadcrumb').textContent = active ? 'AutoPwn' : 'Tokens & requests';
  },
  openPath: ({ project, path, kind }) => {
    if (!session || session.config.projectId !== project) { notify('Connect the project from this report before opening its data.', true); return; }
    $('fs-path').value = path; $('fs-operation').value = kind === 'collection' ? 'query' : 'get'; $('fs-operation').onchange(); tab('firestore');
    notify(`Ready to read ${path}. Press Run request to load its data with your current identity.`);
  },
  navigate: (name, resume = false) => { resumeAudit = resume; tab(name); if (name === 'auth') { $('auth-action').value = 'signin'; $('auth-method').value = 'password'; $('auth-method').onchange(); $('auth-guidance').hidden = false; $('email').focus(); } else notify('Paste your Firebase config and connect. Then press AutoPwn to start.'); },
  auditContext: async () => {
    if (!session) return null;
    const current = session, user = identity;
    const token = !current.demo && current.auth.currentUser ? await current.auth.currentUser.getIdToken() : null;
    const baseline = current.demo ? createDemo(() => {}) : null;
    return { project: current.config.projectId, signedIn: Boolean(user), token, demo: current.demo, paths: graph.knownPaths(),
      read: async p => {
        const start = performance.now(); let outcome = 'readable', http = 200, sampledDocuments, result;
        try { result = await (p.label === 'No token' ? baseline : current).firestore({ operation: p.kind === 'collection' ? 'query' : 'get', path: p.path, filters: [], limit: p.limit }); sampledDocuments = result.count; if (result.exists === false) { outcome = 'not found'; http = 404; } }
        catch (e) { outcome = e.code === 'permission-denied' ? 'denied' : 'error'; http = outcome === 'denied' ? 403 : null; }
        return { documents: result?.documents || (result?.exists ? [{ path: p.path, data: result.data }] : []), evidence: { time: new Date().toISOString(), project: p.project, path: p.path, kind: p.kind, method: 'GET', identity: p.label, outcome, http, durationMs: Math.round(performance.now() - start), demo: true, ...(sampledDocuments !== undefined ? { sampledDocuments } : {}) } };
      },
      sdkRead: async p => {
        const start = performance.now(); let result, outcome = 'readable';
        const request = { operation: p.kind === 'collection' ? 'query' : 'get', path: p.path, filters: [], limit: p.limit };
        try { result = current.demo ? await current.firestore(request) : await firebase.firestore(current, request); if (result.exists === false) outcome = 'not found'; }
        catch (e) { outcome = classify(e) === 'denied' ? 'denied' : 'request error'; }
        return { documents: result?.documents || (result?.exists ? [{ path: p.path, data: result.data }] : []), evidence: { time: new Date().toISOString(), project: p.project, path: p.path, kind: p.kind, method: 'Client SDK', identity: p.label, outcome, http: null, durationMs: Math.round(performance.now() - start), demo: Boolean(current.demo), ...(p.kind === 'collection' && result ? { sampledDocuments: result.count, mayHaveMore: result.count >= p.limit } : {}) } };
      },
      canaryCommit: label => {
        const versions = new Map();
        return async write => {
          const name = write.update?.name || write.delete, path = name.split('/documents/')[1];
          const root = path.split('/')[0];
          const signedIn = label !== 'No token' && Boolean(user);
          if (root === 'private' || root === 'users' && !signedIn) return { response: { ok: false, status: 403 }, body: { error: { status: 'PERMISSION_DENIED' } } };
          const old = versions.get(name);
          if (write.currentDocument.exists === false ? old : old !== write.currentDocument.updateTime) return { response: { ok: false, status: 409 }, body: { error: { status: 'FAILED_PRECONDITION' } } };
          const version = new Date().toISOString() + '-' + crypto.randomUUID();
          if (write.delete) versions.delete(name); else versions.set(name, version);
          return { response: { ok: true, status: 200 }, body: { writeResults: [{ updateTime: version }] } };
        };
      }
    };
  }, getSessionToken: async () => {
  if (!session || session.demo || !session.auth.currentUser) throw new Error('Sign in to a real Firebase session first. Demo identities do not have real tokens.');
  const active = session; return { token: await active.auth.currentUser.getIdToken(), project: active.config.projectId };
} });
const security = setupSecurity({ getConfig: () => session?.config || configInput.read(), getAudit: () => latestAudit, getRaw: () => $('config').value, download });
setupWorkspaces({ notify, download, isBusy: () => busy || $('audit-run').disabled,
  snapshot: () => {
    const config = configInput.read();
    const known = session?.config.projectId === config.projectId ? graph.knownPaths() : savedSetup?.config.projectId === config.projectId ? savedSetup.collectionPaths : [];
    return { config, collectionPaths: known.filter(path => path.split('/').length % 2 === 1),
      scanPaths: $('audit-paths').value.split('\n').map(p => p.trim()).filter(Boolean),
      settings: Object.fromEntries(Object.keys(WORKSPACE_SETTINGS).map(id => [id, $(id).value])) };
  },
  open: async item => {
    lock(true);
    try {
      await endSession(); savedSetup = item; configInput.set(item.config);
      const defaults = { 'audit-profile':'standard', 'audit-scope-mode':'auto', 'audit-engine':'rest', 'audit-concurrency':'5', 'audit-rate':'25', 'audit-sample':'5' };
      for (const id of Object.keys(WORKSPACE_SETTINGS)) $(id).value = item.settings[id] || defaults[id];
      $('audit-paths').value = item.scanPaths.join('\n'); tab('overview');
    } finally { lock(false); }
  }
});
$('lab-panel').hidden = !LAB;
$('lab-load').onclick = () => {
  if (busy || $('audit-run').disabled) return;
  run('Load local lab', async () => {
    const response = await fetch('/__lab/session', { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('Start the local lab server and seed its emulators first.');
    const lab = await response.json();
    if (lab.environment !== 'local-emulator' || lab.config.projectId !== 'demo-firelab-lab') throw new Error('Invalid lab setup.');
    await endSession();
    configInput.set(lab.config); tokens.setProject(lab.config);
    savedSetup = { config: lab.config, collectionPaths: lab.collectionPaths };
    $('audit-paths').value = lab.paths.join('\n'); $('audit-scope-mode').value = 'custom';
    $('jwt-a').value = lab.users[$('lab-identity-a').value].idToken;
    $('jwt-b').value = lab.users[$('lab-identity-b').value].idToken;
    await connectProject(lab.config, true);
    $('token-api-key').value = lab.config.apiKey;
    $('token-refresh').value = lab.users[$('lab-identity-a').value].refreshToken;
    $('lab-status').textContent = 'Fresh emulator tokens loaded. Local SDK connected. Open AutoPwn to compare the selected users and No token, then view the graph. SDK login: alice@firelab.test · Firelab-lab-only-2026!';
    tab('overview');
    return { environment: 'local-emulator', project: lab.config.projectId, identities: [$('lab-identity-a').value, $('lab-identity-b').value], paths: lab.paths.length };
  }, false);
};
async function promptConnection(kind = '') {
  if (!session || identity || document.querySelector('dialog[open]')) return;
  const current = session, dialog = $('connection-next'); dialog.returnValue = 'later';
  $('connection-next-message').textContent = kind === 'Firebase ID token' ? 'Your Firebase ID token can be used in REST scans. Sign in separately to use the Client SDK as a user, or start the scan with your supplied token.' : 'Your project is connected. Sign in with an existing project account to compare user access, or scan without signing in.';
  dialog.showModal();
  const choice = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (current !== session) return;
  if (choice === 'login') {
    resumeAudit = true; tab('auth'); $('auth-guidance').hidden = false;
    $('auth-method').value = kind === 'Firebase custom token' ? 'custom' : kind === 'Google ID token' ? 'google' : 'password';
    $('auth-action').value = 'signin'; $('auth-method').onchange();
    if (['Firebase custom token','Google ID token'].includes(kind)) $('token').value = $('jwt-a').value;
    else $('email').focus();
  } else if (choice === 'scan') { openAudit(); tokens.startAudit(true); }
}
function tab(name) {
  document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== name);
  document.querySelectorAll('.nav').forEach(n => { n.classList.toggle('active', n.dataset.tab === name); if (n.dataset.tab === name) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); });
  $('breadcrumb').textContent = titles[name];
  if (name === 'tokens') document.querySelector('[data-token-tab="inspect"]').click();
  if (name === 'graph') graph.show();
  $('result-panel').hidden = !latest || ['overview', 'activity', 'graph', 'tokens', 'security'].includes(name);
}
function openAudit() { tab('tokens'); document.querySelector('[data-token-tab="audit"]').click(); }
$('autopwn-quick').onclick = () => { openAudit(); tokens.startAudit(); };
$('auth-audit-cancel').onclick = () => { resumeAudit = false; $('auth-guidance').hidden = true; openAudit(); };
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
document.addEventListener('keydown', e => { if (!/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !document.querySelector('dialog[open]') && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-7]$/.test(e.key)) tab(['overview','auth','firestore','realtime','storage','functions','checks'][Number(e.key) - 1]); });
const consoleGlobals = ['authService', 'firestoreService', 'storageService', 'functionsService', 'firelabSDK'];
function clearConsole() { consoleGlobals.forEach(key => { delete window[key]; }); $('console-status').textContent = 'Disabled. Connect a live project first.'; }
$('enable-console').onclick = async () => {
  if (!session || session.demo) { $('console-status').textContent = 'Connect a live Firebase project to enable Client SDK globals.'; return; }
  const current = session; $('enable-console').disabled = true;
  try {
    const [fs, st, fn] = await Promise.all([firebase.sdk('firestore/lite'), firebase.sdk('storage'), firebase.sdk('functions')]);
    if (session !== current) return;
    window.authService = current.auth;
    window.firestoreService = fs.getFirestore(current.app);
    window.storageService = current.config.storageBucket ? st.getStorage(current.app) : null;
    window.functionsService = fn.getFunctions(current.app);
    window.firelabSDK = Object.freeze({ firestore: () => firebase.sdk('firestore/lite'), auth: () => firebase.sdk('auth'), storage: () => firebase.sdk('storage'), functions: () => firebase.sdk('functions') });
    $('console-status').textContent = 'Enabled for ' + current.config.projectId + '. Open browser DevTools → Console.';
  } catch { clearConsole(); $('console-status').textContent = 'SDK loading failed. Check the network and retry.'; }
  finally { $('enable-console').disabled = false; }
};
$('theme').onclick = () => { const light = document.documentElement.classList.toggle('light'); $('theme').setAttribute('aria-label', `Toggle ${light ? 'dark' : 'light'} theme`); };

function updateIdentity(user) {
  const priorIdentity = JSON.stringify(identity);
  identity = user ? { uid: user.uid, email: user.email, isAnonymous: user.isAnonymous } : null;
  if (priorIdentity !== JSON.stringify(identity)) { latestAudit = null; graph.identityChanged(user); tokens.clear(); }
  if (user && resumeAudit) { resumeAudit = false; $('auth-guidance').hidden = true; setTimeout(() => { if (session && identity) { openAudit(); tokens.startAudit(); } }, 0); }
  $('identity').textContent = user ? user.isAnonymous ? 'Anonymous user' : user.email || 'Authenticated user' : 'Unauthenticated';
  $('identity-detail').textContent = user ? `UID: ${user.uid}` : 'Requests without a signed-in user';
}
function updateSession() {
  $('project-name').textContent = session?.config.projectId || 'No project connected';
  $('project-detail').textContent = session ? session.demo ? 'Demo workspace · simulated requests' : 'SDK initialized · access verified per request' : 'Start with your Firebase config';
  $('connection').textContent = session ? session.demo ? '● Demo mode' : '● SDK ready' : '● Disconnected';
  $('connection').className = `badge ${session ? session.demo ? 'demo' : 'connected' : ''}`;
  $('disconnect').hidden = !session;
  $('demo').textContent = session?.demo ? 'Restart demo ↻' : 'Explore demo ↗';
}
function lock(value) {
  busy = value; graph.setBusy(value);
  document.querySelectorAll('form:not([method="dialog"]) button, #demo, #disconnect, #storage-next, #mfa-send, #mfa-finish').forEach(b => { if (b.id !== 'check-stop') b.disabled = value; });
}
function clearLog() { logs = []; latest = null; $('result-panel').hidden = true; $('result').textContent = ''; renderLog(); }
function renderLog() {
  $('log-count').textContent = logs.length;
  $('operation-count').replaceChildren(document.createTextNode(`${logs.length} `), Object.assign(document.createElement('em'), { textContent: 'operations' }));
  const list = $('activity-list'); list.replaceChildren();
  if (!logs.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No activity yet. Connect a project or explore the demo.'; list.append(empty); }
  for (const entry of [...logs].reverse()) {
    const details = document.createElement('details'); details.className = 'activity-item'; details.dataset.status = entry.status;
    const summary = document.createElement('summary');
    const title = document.createElement('b'); title.textContent = `${entry.status.toUpperCase()} · ${entry.operation}`;
    const time = document.createElement('span'); time.textContent = `${new Date(entry.time).toLocaleTimeString()} · ${entry.durationMs} ms${entry.demo ? ' · DEMO' : ''}`;
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(entry, null, 2);
    summary.append(title, time); details.append(summary, pre); list.append(details);
  }
}
function record(operation, status, data, started) {
  const entry = { time: new Date().toISOString(), project: session?.config.projectId || null, demo: session?.demo || false, identity, operation, status, durationMs: Math.round(performance.now() - started), result: data };
  logs.push(entry); if (logs.length > 200) logs.shift();
  latest = entry; $('result').textContent = JSON.stringify(entry, null, 2); $('result-status').textContent = status;
  $('result-panel').hidden = !$('overview').hidden || !$('activity').hidden || !$('graph').hidden || !$('tokens').hidden || !$('security').hidden;
  renderLog();
}
async function run(operation, task, requiresSession = true) {
  if (busy) return;
  if (requiresSession && !session) { notify('Connect a project or explore the demo first.', true); return; }
  lock(true); const started = performance.now();
  notify(`${operation} in progress…`);
  try {
    const data = await task();
    if (data === undefined) { notify('Request cancelled.'); return; }
    record(operation, 'success', data, started);
    notify(`${session?.demo ? 'Demo · ' : ''}${operation} completed.`);
  } catch (error) {
    const message = safeError(error); record(operation, classify(error), { error: message }, started); notify(message, true);
    if (error.code === 'auth/invalid-api-key' || String(error.code).includes('api-key-not-valid')) {
      $('auth-key-repair').hidden = false;
      $('auth-key-current').textContent = session?.config.apiKey ? `Connected key ends with: ${session.config.apiKey.slice(-8)}. Check uppercase I versus lowercase l.` : 'Copy the API key exactly from Firebase project settings.';
      $('auth-replacement-key').value = '';
    }
  } finally { lock(false); }
}
function review(title, detail) {
  $('review-title').textContent = title;
  $('review-description').textContent = session?.demo ? 'This changes only the simulated demo workspace.' : 'This request can change project data. Check the project, identity, path, and payload before running it.';
  $('review-detail').textContent = JSON.stringify({ project: session?.config.projectId, identity: identity?.uid || 'unauthenticated', ...detail }, null, 2);
  const dialog = $('review'); dialog.returnValue = 'cancel'; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
function clearMfa() { mfa = null; verifier?.clear(); verifier = null; $('mfa-panel').hidden = true; $('mfa-code').value = ''; $('mfa-factor').replaceChildren(); }
async function endSession() {
  savedSetup = null; latestAudit = null; security.clear();
  clearConsole(); $('audit-writes').checked = false; $('audit-updates').checked = false; $('audit-mode-badge').textContent = 'READ-ONLY';
  resumeAudit = false; $('auth-guidance').hidden = true; $('audit-paths').value = '';
  await firebase.disconnect(session); session = null; updateIdentity(null); clearMfa(); storagePage = null; $('storage-next').hidden = true;
  $('password').value = ''; $('token').value = ''; $('email').value = ''; $('config').value = ''; $('check-results').replaceChildren(); $('check-progress').hidden = true;
  tokens.clear(); configInput.clear(); graph.setSession(null); clearLog(); updateSession();
}
async function connectProject(config, authPage = false) {
  const restored = savedSetup?.config.projectId === config.projectId ? savedSetup : null;
  const scanPaths = $('audit-paths').value;
  const pending = !session ? { a: $('jwt-a').value, b: $('jwt-b').value } : null;
  const candidate = await firebase.connect(config, () => {});
  try { await endSession(); } catch (error) { await firebase.disconnect(candidate); throw error; }
  session = candidate;
  session.unsubscribe();
  const authSDK = await firebase.sdk('auth');
  session.unsubscribe = authSDK.onAuthStateChanged(session.auth, updateIdentity);
  graph.setSession(session); configInput.set(config); tokens.setProject(config); if (pending) { $('jwt-a').value = pending.a; $('jwt-b').value = pending.b; } updateSession(); tab(authPage ? 'auth' : 'graph');
  if (restored) { savedSetup = restored; $('audit-paths').value = scanPaths; try { graph.addPaths(restored.collectionPaths); } catch (e) { notify(safeError(e), true); } }
  $('auth-key-repair').hidden = true; $('auth-replacement-key').value = '';
  const connected = session; if (!authPage) setTimeout(() => { if (session === connected && !identity) promptConnection(); }, 0);
  return { projectId: config.projectId, initialized: true, note: 'Initialization does not prove connectivity or permissions. Run a service request to verify access.' };
}
$('connect-form').onsubmit = e => { e.preventDefault(); run('Initialize project', () => connectProject(configInput.read()), false); };
$('auth-repair-form').onsubmit = e => { e.preventDefault(); run('Reconnect Authentication', async () => {
  const apiKey = $('auth-replacement-key').value.trim();
  if (!apiKey) throw new Error('Paste the corrected Firebase API key.');
  const config = { ...(session?.config || configInput.read()), apiKey };
  const diagnostic = await firebase.checkAuthConfiguration(config);
  if (diagnostic.projectNumberMatches === false) throw new Error('This key belongs to a different project number. Review the complete project config before reconnecting.');
  const email = $('email').value, resume = resumeAudit;
  const result = await connectProject(config, true);
  $('email').value = email; resumeAudit = resume; $('auth-guidance').hidden = !resume;
  $('password').focus();
  return { ...result, note: 'Corrected key verified and a fresh Firebase session initialized. Enter your password and press Authenticate.' };
}, false); };
$('demo').onclick = () => run('Start demo', async () => {
  await endSession(); session = createDemo(updateIdentity); graph.setSession(session); updateSession();
  graph.addPaths(['posts','users','settings','private']);
  for (const path of ['posts', 'settings']) await dispatch('firestore', { operation: 'query', path, filters: [], limit: 10 });
  tab('graph');
  $('fs-path').value = 'posts'; $('check-paths').value = 'posts\nusers\nsettings\nprivate'; $('rt-path').value = 'public/settings';
  return { demo: true, note: 'Simulated data only. posts and settings are readable; users requires sign-in; private is denied. Demo behavior is not a Firebase rules emulator.' };
}, false);
$('disconnect').onclick = () => { if (!busy) { lock(true); endSession().then(() => notify('Disconnected. Session, credentials, and activity cleared.')).catch(e => notify(safeError(e), true)).finally(() => lock(false)); } };

$('auth-method').onchange = () => {
  const method = $('auth-method').value, password = method === 'password', token = ['google', 'custom'].includes(method);
  $('password-fields').hidden = !password; $('auth-action-wrap').hidden = !password; $('token-fields').hidden = !token;
  for (const id of ['email', 'password']) { $(id).disabled = !password; $(id).required = password; }
  $('token').disabled = !token; $('token').required = token;
  $('password').autocomplete = $('auth-action').value === 'register' ? 'new-password' : 'current-password';
  $('auth-method-help').textContent = { password: $('auth-action').value === 'register' ? 'Create a new email/password user in this Firebase project. Choose Sign in if the account already exists.' : 'Use an existing user account from this Firebase project. Your Firebase Console / Google account password is not automatically a project user account.', anonymous: 'Creates an anonymous Firebase user after your confirmation. The project must enable Anonymous sign-in.', google: 'Paste a Google-issued ID token for an OAuth client accepted by this project. A Firebase ID token is a different credential.', custom: 'Paste a Firebase custom token issued by your trusted backend for this project. Firebase ID tokens are used in Tokens & requests.' }[method];
};
$('auth-action').onchange = $('auth-method').onchange;
$('auth-method').onchange();
$('auth-diagnose').onclick = () => run('Check auth setup', async () => {
  if (session?.demo) return { demo: true, note: 'Demo authentication is simulated. Connect a live config to check public Firebase Auth configuration.' };
  return firebase.checkAuthConfiguration(session?.config || configInput.read());
}, false);
$('auth-form').onsubmit = e => { e.preventDefault(); run('Authenticate', async () => {
  clearMfa();
  const p = { method: $('auth-method').value, action: $('auth-action').value, email: $('email').disabled ? '' : $('email').value.trim(), password: $('password').disabled ? '' : $('password').value, token: $('token').disabled ? '' : $('token').value.trim() };
  if (p.method === 'password' && (!p.email || !p.password)) throw new Error('Enter an email address and password.');
  if (['google', 'custom'].includes(p.method) && !p.token) throw new Error('Enter a token.');
  if ((p.method === 'anonymous' || (p.method === 'password' && p.action === 'register')) && !await review('Create Firebase user?', { method: p.method, email: p.email || undefined })) return;
  try { return session.demo ? await session.authenticate(p) : await firebase.authenticate(session, p); }
  catch (error) {
    if (error.code !== 'auth/multi-factor-auth-required') throw error;
    const a = await firebase.sdk('auth');
    const resolver = a.getMultiFactorResolver(session.auth, error);
    const phones = resolver.hints.map((hint, index) => ({ hint, index })).filter(x => x.hint.factorId === a.PhoneMultiFactorGenerator.FACTOR_ID);
    if (!phones.length) throw new Error('This account requires a non-SMS MFA factor, which this version does not support.');
    mfa = { resolver, verificationId: null };
    $('mfa-factor').replaceChildren(...phones.map(x => new Option(x.hint.displayName || x.hint.phoneNumber, x.index)));
    $('mfa-panel').hidden = false;
    return { nextStep: 'Complete SMS verification below.' };
  } finally { $('password').value = ''; $('token').value = ''; }
}); };
$('signout').onclick = () => run('Sign out', async () => { clearMfa(); if (session.demo) return session.signout(); await (await firebase.sdk('auth')).signOut(session.auth); return { signedOut: true }; });
$('mfa-send').onclick = () => run('Send MFA SMS', async () => {
  if (!mfa) throw new Error('Start a sign-in that requires SMS MFA first.');
  mfa.verificationId = null;
  const a = await firebase.sdk('auth'); verifier?.clear(); verifier = new a.RecaptchaVerifier(session.auth, 'recaptcha', { size: 'normal' });
  mfa.verificationId = await new a.PhoneAuthProvider(session.auth).verifyPhoneNumber({ multiFactorHint: mfa.resolver.hints[Number($('mfa-factor').value)], session: mfa.resolver.session }, verifier);
  return { sent: true };
});
$('mfa-finish').onclick = () => run('Verify MFA', async () => {
  if (!mfa?.verificationId || !$('mfa-code').value.trim()) throw new Error('Send an SMS and enter the verification code first.');
  const a = await firebase.sdk('auth'); const result = await mfa.resolver.resolveSignIn(a.PhoneMultiFactorGenerator.assertion(a.PhoneAuthProvider.credential(mfa.verificationId, $('mfa-code').value.trim())));
  clearMfa(); return { uid: result.user.uid, email: result.user.email };
});

async function dispatch(service, p) {
  let result;
  try { result = session.demo ? await session[service](p) : await firebase[service](session, p); }
  catch (error) {
    if (service === 'firestore') { try { graph.failure(p, classify(error), safeError(error)); } catch {  } }
    throw error;
  }
  if (service === 'firestore') { try { graph.ingest(p, result); } catch (error) { notify(`Request completed; graph could not display it: ${error.message}`, true); } }
  return result;
}
$('fs-operation').onchange = () => { const op = $('fs-operation').value; $('fs-query').hidden = op !== 'query'; $('fs-data-wrap').hidden = !['set', 'update'].includes(op); $('fs-merge').parentElement.hidden = op !== 'set'; $('fs-path').placeholder = op === 'query' ? 'users' : 'users/alice'; };
function filters() {
  let value; try { value = JSON.parse($('fs-filters').value.trim() || '[]'); } catch { throw new Error('Filters must be a JSON array.'); }
  const ops = ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'in', 'not-in', 'array-contains-any'];
  if (!Array.isArray(value) || value.length > 10 || value.some(x => !x || typeof x.field !== 'string' || !x.field.trim() || !ops.includes(x.op) || !Object.hasOwn(x, 'value'))) throw new Error('Use up to 10 filters with field, op, and value properties.');
  if (value.some(x => ['in', 'not-in', 'array-contains-any'].includes(x.op) && (!Array.isArray(x.value) || !x.value.length))) throw new Error('in, not-in, and array-contains-any need a nonempty array value.');
  return value;
}
$('firestore-form').onsubmit = e => { e.preventDefault(); run(`Firestore ${$('fs-operation').value}`, async () => {
  const operation = $('fs-operation').value;
  const p = { operation, path: validatePath($('fs-path').value, operation === 'query' ? 'collection' : 'document') };
  if (operation === 'query') Object.assign(p, { limit: boundedNumber($('fs-limit').value, 1, 100, 'Limit'), order: $('fs-order').value.trim(), direction: $('fs-direction').value, filters: filters() });
  if (['set', 'update'].includes(operation)) Object.assign(p, { data: jsonObject($('fs-data').value), merge: $('fs-merge').checked });
  if (['set', 'update', 'delete'].includes(operation) && !await review(`Firestore: ${operation} document?`, p)) return;
  return dispatch('firestore', p);
}); };
$('realtime-form').onsubmit = e => { e.preventDefault(); run(`Realtime ${$('rt-operation').value}`, async () => {
  const p = { operation: $('rt-operation').value, path: validatePath($('rt-path').value, 'realtime') };
  if (p.operation === 'set') { try { p.data = JSON.parse($('rt-data').value); } catch { throw new Error('Enter valid JSON data.'); } }
  if (p.operation === 'update') p.data = jsonObject($('rt-data').value);
  if (p.operation !== 'get' && !await review(`Realtime Database: ${p.operation}?`, p)) return;
  return dispatch('realtime', p);
}); };
function download(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
$('st-operation').onchange = () => { $('st-file-wrap').hidden = $('st-operation').value !== 'upload'; storagePage = null; $('storage-next').hidden = true; };
$('st-path').oninput = () => { storagePage = null; $('storage-next').hidden = true; };
async function storageRequest(p) {
  const data = await dispatch('storage', p);
  if (p.operation === 'list') { storagePage = data.nextPageToken ? { ...p, pageToken: data.nextPageToken } : null; $('storage-next').hidden = !storagePage; }
  if (data.blob) { download(data.blob, data.filename); return { downloaded: data.filename, bytes: data.blob.size }; }
  return data;
}
$('storage-form').onsubmit = e => { e.preventDefault(); run(`Storage ${$('st-operation').value}`, async () => {
  const p = { operation: $('st-operation').value, path: validatePath($('st-path').value, 'storage') };
  if (p.operation !== 'list' && !p.path) throw new Error('Enter an exact file path.');
  if (p.operation === 'upload') { p.file = $('st-file').files[0]; if (!p.file) throw new Error('Choose a file.'); if (p.file.size > 10 * 1024 * 1024) throw new Error('Choose a file smaller than 10 MB.'); }
  if (['upload', 'delete'].includes(p.operation) && !await review(`Storage: ${p.operation} file?`, { operation: p.operation, path: p.path, file: p.file ? { name: p.file.name, bytes: p.file.size } : undefined })) return;
  return storageRequest(p);
}); };
$('storage-next').onclick = () => run('Storage next page', async () => { if (!storagePage) throw new Error('No next page.'); return storageRequest(storagePage); });
$('functions-form').onsubmit = e => { e.preventDefault(); run('Invoke callable function', async () => {
  let data; try { data = JSON.parse($('fn-data').value); } catch { throw new Error('Enter valid JSON data.'); }
  const p = { name: $('fn-name').value.trim(), region: $('fn-region').value.trim(), data };
  if (!await review('Invoke callable function?', p)) return;
  return dispatch('invoke', p);
}); };
$('check-stop').onclick = () => { stopped = true; $('check-stop').disabled = true; };
$('checks-form').onsubmit = e => { e.preventDefault(); run('Collection read checks', async () => {
  const paths = [...new Set($('check-paths').value.split('\n').map(p => p.trim()).filter(Boolean).map(p => validatePath(p, 'collection')))];
  if (!paths.length || paths.length > 100) throw new Error('Enter between 1 and 100 collection paths.');
  const concurrency = boundedNumber($('check-concurrency').value, 1, 5, 'Concurrency');
  stopped = false; $('check-stop').hidden = false; $('check-stop').disabled = false; $('check-results').replaceChildren(); $('check-progress').hidden = false; $('progress').max = paths.length; $('progress').value = 0; $('progress-label').textContent = `0 / ${paths.length} checked`;
  const results = []; let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
      while (!stopped && next < paths.length) {
        const path = paths[next++]; let result;
        try { const data = await dispatch('firestore', { operation: 'query', path, filters: [], limit: 1 }); result = { path, status: 'readable', sampledDocuments: data.count }; }
        catch (error) { result = { path, status: classify(error), error: safeError(error) }; }
        results.push(result);
        const row = document.createElement('div'); row.className = `check-row ${result.status}`;
        const label = document.createElement('span'); label.textContent = path;
        const status = document.createElement('span'); status.textContent = result.status === 'readable' ? result.sampledDocuments ? 'READABLE · nonempty' : 'READABLE · empty' : result.status.toUpperCase();
        row.append(label, status); $('check-results').append(row); $('progress').value = results.length; $('progress-label').textContent = `${results.length} / ${paths.length} checked`;
      }
    }));
    $('progress-label').textContent += stopped ? ' · Stopped' : ' · Complete';
    return { stopped, requested: paths.length, completed: results.length, note: 'Read checks only. Denied does not establish overall security; readable may be intended.', results };
  } finally { $('check-stop').hidden = true; }
}); };
$('clear-log').onclick = () => { if (!busy) { clearLog(); notify('Activity cleared.'); } };
$('export').onclick = () => { download(new Blob([JSON.stringify({ tool: 'Firelab', version: '1.14.1', exportedAt: new Date().toISOString(), entries: logs }, null, 2)], { type: 'application/json' }), `firelab-${new Date().toISOString().slice(0, 10)}.json`); notify('Report exported. It may contain returned project data.'); };
$('copy-result').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(latest, null, 2)); notify('Result copied.'); } catch { notify('Clipboard unavailable. Select the result text or export from Activity.', true); } };
updateSession();
