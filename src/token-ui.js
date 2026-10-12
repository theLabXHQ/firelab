import { setupAutoPwn } from './autopwn.js?v=1.14.1';
import { decodeToken, claimChecks, verifyToken, diffClaims, dateLabel, buildReadURL, requestCurl, readWithToken, exchangeRefreshToken, fingerprint } from './tokens.js?v=1.14.1';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const hints = {
  'Firebase ID token': 'Use as a bearer credential for Firebase resource requests. A decoded payload does not establish authenticity.',
  'Firebase custom token': 'Exchange through signInWithCustomToken in Authentication. A custom token is not a Firebase resource bearer credential.',
  'Firebase session cookie': 'Used by your application backend. Session cookies cannot authenticate directly to other Firebase services.',
  'Google ID token': 'A Google identity credential, not a Firebase ID token. Exchange through Google sign-in in Authentication.',
  'Firebase App Check token': 'Attests an application instance. It is separate from Firebase user authentication.',
  'Unknown JWT': 'Issuer and audience do not match a recognized Firebase or Google token type.'
};

export function setupTokens({ getSessionToken, download, auditContext, navigate, openPath, auditMode = () => {}, onComplete, showGraph, onInvalidate, onCredential = () => {} }) {
  let busy = false, revision = 0, evidence = [];
  const audit = setupAutoPwn(download, { context: auditContext, navigate, openPath, onComplete, showGraph, onInvalidate });
  const inputIds = ['jwt-a', 'jwt-b', 'token-project'];
  function notice(text, error = false) { $('token-notice').hidden = false; $('token-notice').className = `inline-notice${error ? ' error' : ''}`; $('token-notice').textContent = text; }
  function renderEvidence() {
    $('request-results').replaceChildren();
    for (const row of evidence) { const tr = el('tr'); for (const value of [row.identity, row.http ?? '—', row.outcome, `${row.durationMs} ms`]) tr.append(el('td', '', value)); $('request-results').append(tr); }
    if (!evidence.length) { const row = el('tr'); const cell = el('td', 'muted', 'No requests sent.'); cell.colSpan = 4; row.append(cell); $('request-results').append(row); }
  }
  function invalidate() {
    audit.clear(); revision++; evidence = []; renderEvidence(); $('request-body').textContent = 'No response.';
    $('token-header').textContent = '—'; $('token-payload').textContent = '—';
    $('token-summary').replaceChildren(el('div', 'empty', 'Inspect the current token to see its claims.'));
    $('token-diff').replaceChildren(); $('token-notice').hidden = true;
    preview();
  }
  async function task(work) {
    if (busy) return;
    busy = true; const version = revision;
    const buttons = [...$('tokens').querySelectorAll('button')].filter(b => b.id !== 'tokens-clear' && !b.id.startsWith('audit-') && !b.dataset.tokenTab);
    buttons.forEach(b => b.disabled = true);
    try { await work(() => version === revision); }
    catch (error) { if (version === revision) notice(error.message || 'Operation failed.', true); }
    finally { busy = false; buttons.forEach(b => b.disabled = false); }
  }
  function summary(decoded, verification = null) {
    const box = $('token-summary'); box.replaceChildren();
    const verdict = verification ? verification.signatureValid && verification.claimsValid ? 'Signature and claims valid' : verification.signatureValid ? 'Signature valid; claim checks failed' : 'Signature verification failed' : 'Decoded only · signature not verified';
    const heading = el('div', 'token-verdict'); heading.append(el('strong', '', decoded.kind), el('span', verification?.signatureValid && verification?.claimsValid ? 'status-ok' : 'muted', verdict)); box.append(heading);
    const meta = el('dl', 'claim-meta');
    for (const [label, value] of [['Subject', decoded.payload.sub || decoded.payload.uid || '—'], ['Audience', decoded.payload.aud || '—'], ['Provider', decoded.payload.firebase?.sign_in_provider || '—'], ['Expires (UTC)', dateLabel(decoded.payload.exp)]]) { meta.append(el('dt', '', label), el('dd', '', typeof value === 'string' ? value : JSON.stringify(value))); }
    box.append(meta, el('p', 'muted', hints[decoded.kind]));
    if (decoded.header.alg === 'none') box.append(el('p', 'status-warning', 'Unsigned token. Firebase emulator tokens must not be accepted by production backends.'));
    if (verification) box.append(el('p', 'muted', verification.note));
    if (decoded.kind === 'Firebase ID token') {
      const details = el('details', 'claim-checks'); details.open = Boolean(verification); details.append(el('summary', '', 'Claim checks · separate from signature verification'));
      const table = el('table');
      for (const check of verification?.checks || claimChecks(decoded, $('token-project').value.trim())) { const row = el('tr'); row.append(el('th', '', check.name), el('td', check.pass ? 'status-ok' : 'status-warning', check.pass ? 'Pass' : 'Fail'), el('td', '', check.detail)); table.append(row); }
      const wrap = el('div', 'table-scroll'); wrap.append(table); details.append(wrap); box.append(details);
    }
    $('token-header').textContent = JSON.stringify(decoded.header, null, 2); $('token-payload').textContent = JSON.stringify(decoded.payload, null, 2);
  }
  function preview() { try { $('request-url').textContent = buildReadURL($('token-project').value.trim(), $('request-path').value, $('request-kind').value); } catch { $('request-url').textContent = 'Enter a project ID and valid path.'; } }
  function readInputs(which) {
    return { project: $('token-project').value.trim(), path: $('request-path').value.trim(), kind: $('request-kind').value, token: which === 'none' ? null : $(`jwt-${which}`).value.trim(), label: which === 'none' ? 'No token' : `Token ${which.toUpperCase()}` };
  }
  function validateRead(p) {
    buildReadURL(p.project, p.path, p.kind);
    if (p.label !== 'No token') { if (!p.token) throw new Error(`Paste ${p.label} first.`); if (decodeToken(p.token).kind !== 'Firebase ID token') throw new Error(`${p.label} must be a Firebase ID token for resource replay.`); }
  }
  document.querySelectorAll('[data-token-tab]').forEach(button => button.onclick = () => {
    const isAudit = button.dataset.tokenTab === 'audit';
    $('tokens').classList.toggle('audit-mode', isAudit);
    $('tokens-heading').textContent = isAudit ? 'AutoPwn' : 'Tokens & requests';
    $('tokens-description').textContent = isAudit ? 'Check access, compare identities, and open the results in your workspace.' : 'Inspect credentials, compare claims, and test read access as different identities.';
    auditMode(isAudit);
    document.querySelectorAll('.token-pane').forEach(pane => pane.hidden = pane.id !== `token-${button.dataset.tokenTab}`);
    document.querySelectorAll('[data-token-tab]').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  });
  $('audit-token-tools').onclick = () => document.querySelector('[data-token-tab="inspect"]').click();
  $('jwt-a').addEventListener('change', () => { try { const d = decodeToken($('jwt-a').value); if (d.header.alg !== 'none') onCredential(d.kind); } catch {} });
  inputIds.forEach(id => $(id).addEventListener('input', invalidate));
  ['token-api-key', 'token-refresh'].forEach(id => $(id).addEventListener('input', () => { revision++; }));
  ['request-kind', 'request-path'].forEach(id => $(id).addEventListener('input', invalidate));
  $('token-decode').onclick = () => task(async current => { const decoded = decodeToken($('jwt-a').value); const id = await fingerprint(decoded.token); if (!current()) return; summary(decoded); notice(`Inspected locally. SHA-256 fingerprint: ${id}. No request was sent.`); });
  $('token-verify').onclick = () => task(async current => { const raw = $('jwt-a').value, project = $('token-project').value.trim(); notice('Fetching public keys and verifying locally…'); const result = await verifyToken(raw, project); if (!current()) return; summary(decodeToken(raw), result); notice(result.signatureValid && result.claimsValid ? 'Signature and claim checks passed. Revocation and access permissions are not checked.' : 'Verification did not pass all checks. See the details below.', !(result.signatureValid && result.claimsValid)); });
  $('token-diff-run').onclick = () => task(async current => {
    const rows = diffClaims(decodeToken($('jwt-a').value).payload, decodeToken($('jwt-b').value).payload); if (!current()) return;
    $('token-diff').replaceChildren();
    for (const data of rows) { const row = el('tr', data.change === 'same' ? '' : 'changed-row'); for (const value of [data.claim, data.a === undefined ? '(absent)' : JSON.stringify(data.a), data.b === undefined ? '(absent)' : JSON.stringify(data.b), data.change]) row.append(el('td', '', value)); $('token-diff').append(row); }
    notice(`${rows.filter(r => r.change !== 'same').length} changed claims. Neither token signature was verified by this comparison.`);
  });
  $('token-session').onclick = () => task(async current => { const value = await getSessionToken(); if (!current()) return; $('jwt-a').value = value.token; $('token-project').value = value.project; invalidate(); summary(decodeToken(value.token)); notice('Current session ID token loaded into A. It is not added to the activity log.'); });
  $('token-example').onclick = () => {
    const base64 = value => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const now = Math.floor(Date.now() / 1000), header = base64({ alg: 'none', typ: 'JWT' });
    const base = { iss: 'https://securetoken.google.com/demo-firelab', aud: 'demo-firelab', sub: 'example-user', iat: now, auth_time: now - 60, exp: now + 3600, firebase: { sign_in_provider: 'password' } };
    $('jwt-a').value = `${header}.${base64({ ...base, role: 'reader' })}.`; $('jwt-b').value = `${header}.${base64({ ...base, sub: 'second-example-user', role: 'editor' })}.`; $('token-project').value = 'demo-firelab'; invalidate(); summary(decodeToken($('jwt-a').value)); notice('Unsigned example tokens loaded locally. These are not real credentials and will not authenticate to production Firebase.');
  };
  $('token-refresh-run').onclick = () => task(async current => { notice('Exchanging refresh token with Firebase Authentication…'); const result = await exchangeRefreshToken($('token-api-key').value, $('token-refresh').value); if (!current()) return; $('jwt-a').value = result.idToken; $('token-refresh').value = result.refreshToken; invalidate(); summary(decodeToken(result.idToken)); notice('Token A updated. The returned refresh token replaced the old value in memory. No tokens were logged.'); });
  $('request-send').onclick = () => task(async current => { const p = readInputs($('request-identity').value); validateRead(p); notice('Sending read request…'); const result = await readWithToken(p); if (!current()) return; evidence = [result.evidence]; renderEvidence(); $('request-body').textContent = JSON.stringify(result.body, null, 2); notice(`Read result: ${result.evidence.outcome}. See the HTTP status and response body.`); });
  $('request-matrix').onclick = () => task(async current => {
    const inputs = ['none', ...['a', 'b'].filter(id => $(`jwt-${id}`).value.trim())].map(readInputs);
    if (inputs.length < 2) throw new Error('Add at least one Firebase ID token to compare with unauthenticated access.');
    inputs.forEach(validateRead); evidence = []; renderEvidence(); notice('Comparing read access…');
    for (const p of inputs) { if (!current()) return; const result = await readWithToken(p); if (!current()) return; evidence.push(result.evidence); renderEvidence(); $('request-body').textContent = JSON.stringify(result.body, null, 2); }
    notice('Comparison complete. Differences are observations to compare against intended rules, not automatic vulnerability findings.');
  });
  $('request-curl').onclick = () => task(async () => { const url = buildReadURL($('token-project').value.trim(), $('request-path').value, $('request-kind').value); try { await navigator.clipboard.writeText(requestCurl(url, $('request-identity').value !== 'none')); notice('cURL copied. Set FIREBASE_ID_TOKEN in your shell; the actual token was not copied.'); } catch { throw new Error('Clipboard unavailable. Use a secure context such as localhost or HTTPS.'); } });
  $('request-export').onclick = () => { if (!evidence.length) { notice('Run a read request before exporting evidence.', true); return; } download(new Blob([JSON.stringify({ tool: 'Firelab', version: '1.14.1', exportedAt: new Date().toISOString(), note: 'Tokens and response bodies excluded. Fingerprints identify credentials; they are not proof of token validity.', requests: evidence }, null, 2)], { type: 'application/json' }), 'firelab-request-evidence.json'); notice('Evidence exported without raw tokens, headers, or response bodies.'); };
  function clear() { for (const id of [...inputIds, 'token-api-key', 'token-refresh']) $(id).value = ''; invalidate(); }
  $('tokens-clear').onclick = () => { clear(); notice('Tokens, decoded claims, and request evidence cleared.'); };
  return { clear, startAudit: audit.start, setProject(config) { if (!$('token-project').value) $('token-project').value = config.projectId; if (!$('token-api-key').value) $('token-api-key').value = config.apiKey || ''; preview(); } };
}
