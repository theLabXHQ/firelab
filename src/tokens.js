import { LAB, LAB_PORTS, labURL, assertLabProject } from './lab.js?v=1.14.1';
import { validatePath } from './core.js?v=1.14.1';

export const FIREBASE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let keyCache = null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function cleanToken(text) {
  const token = text.trim().replace(/^Bearer\s+/i, '');
  if (!token || token.length > 65536 || /\s/.test(token)) throw new Error('Paste one token, up to 64 KB. A Bearer prefix is accepted.');
  return token;
}
function bytes(segment) {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) throw new Error('Invalid JWT encoding.');
  try { return Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4)), c => c.charCodeAt(0)); }
  catch { throw new Error('Invalid JWT encoding.'); }
}
function decodePart(part) {
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(part))); if (!object(value)) throw new Error(); return value; }
  catch { throw new Error('JWT header and payload must be valid UTF-8 JSON objects.'); }
}
export function decodeToken(raw) {
  const token = cleanToken(raw), parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) throw new Error('This is not a three-part JWT. Refresh tokens are opaque; use the refresh exchange below.');
  const header = decodePart(parts[0]), payload = decodePart(parts[1]); bytes(parts[2]);
  const issuer = String(payload.iss || '');
  let kind = 'Unknown JWT';
  if (issuer.startsWith('https://securetoken.google.com/')) kind = 'Firebase ID token';
  else if (issuer.startsWith('https://session.firebase.google.com/')) kind = 'Firebase session cookie';
  else if (payload.aud === 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit') kind = 'Firebase custom token';
  else if (['accounts.google.com', 'https://accounts.google.com'].includes(issuer)) kind = 'Google ID token';
  else if (issuer.startsWith('https://firebaseappcheck.googleapis.com/')) kind = 'Firebase App Check token';
  return { token, parts, header, payload, kind };
}
export function claimChecks(decoded, project, now = Date.now() / 1000) {
  const p = decoded.payload, checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  add('Token type', decoded.kind === 'Firebase ID token', decoded.kind);
  add('Algorithm', decoded.header.alg === 'RS256', String(decoded.header.alg || 'Missing'));
  add('Project supplied', Boolean(project), project || 'Enter the expected project ID');
  add('Audience', Boolean(project) && p.aud === project, typeof p.aud === 'string' ? p.aud : 'Missing or not a string');
  add('Issuer', Boolean(project) && p.iss === `https://securetoken.google.com/${project}`, typeof p.iss === 'string' ? p.iss : 'Missing');
  add('Subject', typeof p.sub === 'string' && p.sub.length > 0 && p.sub.length <= 128, typeof p.sub === 'string' && p.sub.length > 0 && p.sub.length <= 128 ? 'Present (1–128 characters)' : 'Missing or invalid');
  add('Expiration', typeof p.exp === 'number' && Number.isFinite(p.exp) && p.exp > now, dateLabel(p.exp));
  add('Issued at', typeof p.iat === 'number' && Number.isFinite(p.iat) && p.iat <= now, dateLabel(p.iat));
  add('Auth time', typeof p.auth_time === 'number' && Number.isFinite(p.auth_time) && p.auth_time <= now, dateLabel(p.auth_time));
  add('Time order', typeof p.exp === 'number' && typeof p.iat === 'number' && p.exp > p.iat && p.auth_time <= p.iat, 'auth_time ≤ iat < exp');
  if (p.nbf !== undefined) add('Not before', typeof p.nbf === 'number' && Number.isFinite(p.nbf) && p.nbf <= now, dateLabel(p.nbf));
  return checks;
}
export function dateLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(new Date(value * 1000).getTime())) return 'Missing or invalid timestamp';
  return new Date(value * 1000).toISOString();
}
export async function fingerprint(raw) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cleanToken(raw)));
  return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function jsonFetch(url, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(labURL(url), { ...options, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
    const reader = response.body?.getReader(); let size = 0, content = '';
    const decoder = new TextDecoder();
    if (reader) {
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Response exceeded the 2 MB display limit. Use a narrower document path.'); } content += decoder.decode(value, { stream: true }); }
      content += decoder.decode();
    }
    let body; try { body = JSON.parse(content); } catch { throw new Error('The endpoint returned a non-JSON response.'); }
    return { response, body };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out after 15 seconds. No access conclusion can be drawn.');
    if (e instanceof TypeError) throw new Error('Network, CORS, or redirect error. No access conclusion can be drawn.');
    throw e;
  } finally { clearTimeout(timer); }
}
async function publicKeys(force = false) {
  if (!force && keyCache?.expires > Date.now()) return keyCache.keys;
  const { response, body } = await jsonFetch(FIREBASE_JWKS);
  if (!response.ok || !Array.isArray(body.keys)) throw new Error('Could not load Firebase public signing keys.');
  const ttl = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300);
  keyCache = { keys: body.keys, expires: Date.now() + Math.min(ttl, 86400) * 1000 };
  return body.keys;
}
export async function verifyToken(raw, project) {
  const decoded = decodeToken(raw);
  if (decoded.kind !== 'Firebase ID token') throw new Error('Signature verification here supports Firebase ID tokens only. Custom tokens, Google tokens, and session cookies use different validation rules.');
  if (!project.trim()) throw new Error('Enter the expected project ID before verification.');
  if (decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string' || !decoded.parts[2]) throw new Error('Production Firebase ID tokens require RS256, a key ID, and a signature. Unsigned emulator tokens are not verified here.');
  if (decoded.header.crit !== undefined || decoded.header.b64 === false) throw new Error('Unsupported JWT critical-header or detached-payload options.');
  let keys = await publicKeys(), jwk = keys.find(k => k.kid === decoded.header.kid && k.kty === 'RSA');
  if (!jwk) { keys = await publicKeys(true); jwk = keys.find(k => k.kid === decoded.header.kid && k.kty === 'RSA'); }
  if (!jwk) return { signatureValid: false, claimsValid: false, checks: claimChecks(decoded, project), note: 'No matching key in Firebase signing keys.' };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signatureValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(decoded.parts[2]), new TextEncoder().encode(decoded.parts.slice(0, 2).join('.')));
  const checks = claimChecks(decoded, project.trim());
  return { signatureValid, claimsValid: checks.every(c => c.pass), checks, note: 'Revocation, disabled accounts, and resource authorization were not checked. This browser check is not a substitute for backend token verification.' };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function diffClaims(a, b) {
  const rows = [];
  function walk(left, right, path) {
    if (object(left) && object(right) && (Object.keys(left).length || Object.keys(right).length)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    } else rows.push({ claim: path || '/', a: left, b: right, change: left === undefined ? 'added' : right === undefined ? 'removed' : JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) ? 'same' : 'changed' });
  }
  walk(a, b, ''); return rows;
}
export function buildReadURL(project, path, kind, limit = 5) {
  assertLabProject(project);
  if (!/^[a-z][a-z0-9-]{3,62}$/.test(project)) throw new Error('Enter a valid Firebase project ID.');
  if (!['collection', 'document'].includes(kind)) throw new Error('Choose a document or collection read.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Read limit must be between 1 and 100.');
  path = validatePath(path, kind);
  if (path.split('/').some(p => ['.', '..'].includes(p)) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid path segment.');
  return labURL(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path.split('/').map(encodeURIComponent).join('/')}${kind === 'collection' ? `?pageSize=${limit}` : ''}`);
}
export function requestCurl(url, authenticated) {
  const parsed = new URL(url);
  if (LAB) labURL(url);
  if (parsed.origin !== 'https://firestore.googleapis.com' && !(LAB && parsed.origin === `http://127.0.0.1:${LAB_PORTS.firestore}`)) throw new Error('Only Firestore URLs are supported.');
  const quoted = `'${url.replace(/'/g, `'"'"'`)}'`;
  return `curl --request GET ${quoted}${authenticated ? ' \\\n  --header "Authorization: Bearer ${FIREBASE_ID_TOKEN:?Set FIREBASE_ID_TOKEN}"' : ''}`;
}
export async function readWithToken({ project, path, kind, token, label, limit = 5 }) {
  const url = buildReadURL(project, path, kind, limit), headers = { Accept: 'application/json' };
  let tokenFingerprint = null;
  if (token) { const decoded = decodeToken(token); if (decoded.kind !== 'Firebase ID token') throw new Error('Firestore replay accepts Firebase ID tokens. Exchange custom tokens through Authentication first.'); headers.Authorization = `Bearer ${decoded.token}`; tokenFingerprint = await fingerprint(decoded.token); }
  const start = performance.now();
  try {
    const { response, body } = await jsonFetch(url, { method: 'GET', headers });
    const configurationError = body?.error?.details?.some?.(d => ['SERVICE_DISABLED', 'API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'CONSUMER_INVALID'].includes(d.reason));
    const outcome = response.ok ? 'readable' : configurationError ? 'configuration error' : response.status === 401 ? 'unauthenticated' : response.status === 403 && body?.error?.status === 'PERMISSION_DENIED' ? 'denied' : response.status === 404 ? 'not found' : response.status === 429 ? 'rate limited' : response.status >= 500 ? 'service error' : 'error';
    return { evidence: { time: new Date().toISOString(), project, method: 'GET', path, kind, identity: label, tokenFingerprint, http: response.status, outcome, durationMs: Math.round(performance.now() - start), ...(response.ok && kind === 'collection' ? { sampledDocuments: Array.isArray(body.documents) ? body.documents.length : 0, hasMore: Boolean(body.nextPageToken) } : {}) }, body };
  } catch (e) { return { evidence: { time: new Date().toISOString(), project, method: 'GET', path, kind, identity: label, tokenFingerprint, http: null, outcome: 'network/response error', durationMs: Math.round(performance.now() - start) }, body: { error: e.message } }; }
}
export async function exchangeRefreshToken(apiKey, refreshToken) {
  if (!apiKey.trim() || !refreshToken.trim()) throw new Error('Enter an API key and refresh token.');
  if (apiKey.length > 256 || refreshToken.length > 65536) throw new Error('API key or refresh token is too long.');
  const { response, body } = await jsonFetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey.trim())}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken.trim() }).toString() });
  if (!response.ok || typeof body.id_token !== 'string' || typeof body.refresh_token !== 'string') throw new Error(`Refresh exchange failed (HTTP ${response.status}). Check the token, API key, project restrictions, and account state.`);
  return { idToken: body.id_token, refreshToken: body.refresh_token };
}
