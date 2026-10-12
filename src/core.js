const CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'databaseURL', 'storageBucket', 'appId', 'messagingSenderId', 'measurementId'];

function objectConfig(text) {
  try { return JSON.parse(text); } catch {  }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Paste a Firebase object, Android XML, or google-services.json.');
  const tokens = text.slice(start, end + 1).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[A-Za-z_$][\w$]*|[{}:,]|\s+|./gs) || [];
  const clean = tokens.filter(t => !t.startsWith('//') && !t.startsWith('/*'));
  const source = clean.map((t, index) => {
    if (/^\s+$/.test(t)) return t;
    if (t === ',' && clean.slice(index + 1).find(n => !/^\s+$/.test(n)) === '}') return '';
    if (t.startsWith("'")) return JSON.stringify(t.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
    if (/^[A-Za-z_$][\w$]*$/.test(t)) return JSON.stringify(t);
    return t;
  }).join('');
  try { return JSON.parse(source); } catch { throw new Error('Could not parse config. Use quoted string values; JavaScript expressions are not supported.'); }
}

export function inspectConfig(raw) {
  const text = raw.trim();
  if (text.length > 1024 * 1024) throw new Error('Config files must be smaller than 1 MB.');
  let value, format = 'Firebase config';
  const warnings = [], inferred = [];
  if (text.startsWith('<')) {
    format = 'Android XML';
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entity declarations are not supported. Paste only Android resource strings.');
    const fragment = text.replace(/<\?xml[^?]*\?>/g, '');
    const xml = new DOMParser().parseFromString(`<firelab>${fragment}</firelab>`, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Invalid XML. Paste complete <string name="…">value</string> elements.');
    const mapping = { google_api_key: 'apiKey', google_app_id: 'appId', google_storage_bucket: 'storageBucket', project_id: 'projectId', firebase_database_url: 'databaseURL', gcm_defaultSenderId: 'messagingSenderId', google_crash_reporting_api_key: 'apiKey' };
    value = {};
    for (const item of xml.querySelectorAll('string[name]')) {
      const key = mapping[item.getAttribute('name')];
      if (!key) continue;
      const v = item.textContent.trim();
      if (value[key] && value[key] !== v) throw new Error(`Conflicting Android values for ${key}. Use manual fields to choose the right value.`);
      value[key] = v;
    }
  } else {
    value = objectConfig(text);
    if (value?.project_info) {
      format = 'google-services.json';
      if (!Array.isArray(value.client) || !value.client.length) throw new Error('google-services.json has no Android client.');
      if (value.client.length > 1) throw new Error('This file has multiple Android clients. Use manual fields to select the correct client API key and app ID.');
      const client = value.client[0];
      value = { projectId: value.project_info.project_id, storageBucket: value.project_info.storage_bucket, databaseURL: value.project_info.firebase_url, messagingSenderId: value.project_info.project_number, appId: client.client_info?.mobilesdk_app_id, apiKey: client.api_key?.[0]?.current_key };
    }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Enter a configuration object.');
  const config = {};
  for (const key of CONFIG_KEYS) {
    if (value[key] !== undefined && value[key] !== '') {
      if (typeof value[key] !== 'string') throw new Error(`${key} must be a string.`);
      config[key] = value[key].trim();
    }
  }
  if (config.storageBucket) config.storageBucket = config.storageBucket.replace(/^gs:\/\//, '').replace(/\/$/, '');
  if (!config.projectId) {
    const bucket = config.storageBucket?.match(/^([a-z0-9-]+)\.(?:appspot\.com|firebasestorage\.app)$/);
    if (bucket) { config.projectId = bucket[1]; inferred.push('projectId'); warnings.push('Project ID inferred from the default bucket name. Review it before connecting.'); }
  }
  if (config.projectId && !config.authDomain) { config.authDomain = `${config.projectId}.firebaseapp.com`; inferred.push('authDomain'); }
  if (config.appId?.includes(':android:')) warnings.push('Android app ID detected. Provider restrictions and browser auth settings still apply.');
  if (!config.databaseURL) warnings.push('No Realtime Database URL supplied. Add its exact URL to use that service.');
  if (config.databaseURL) {
    let url; try { url = new URL(config.databaseURL); } catch { throw new Error('databaseURL must be a valid HTTPS URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || url.pathname !== '/') throw new Error('databaseURL must be an HTTPS root URL without credentials, port, query, or fragment.');
    if (!/^[a-z0-9-]+\.firebaseio\.com$/.test(url.hostname) && !/^[a-z0-9-]+\.[a-z0-9-]+\.firebasedatabase\.app$/.test(url.hostname)) throw new Error('databaseURL must use an official Firebase Realtime Database hostname.');
  }
  return { config, format, inferred, warnings, missing: ['apiKey', 'projectId'].filter(k => !config[k]) };
}

export function parseConfig(text) {
  const result = inspectConfig(text);
  if (result.missing.length) throw new Error(`Missing ${result.missing.join(' and ')}. Add them using manual fields.`);
  return result.config;
}

export function jsonObject(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Enter valid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Enter a JSON object, for example {"name": "Demo User"}.');
  return value;
}

export function validatePath(raw, kind) {
  const path = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!path && kind !== 'storage' && kind !== 'realtime') throw new Error('Enter a path.');
  if (path.includes('//')) throw new Error('Path segments cannot be empty.');
  const count = path.split('/').length;
  if (kind === 'collection' && count % 2 !== 1) throw new Error('Collection paths have an odd number of segments, e.g. users or users/alice/posts.');
  if (kind === 'document' && count % 2 !== 0) throw new Error('Document paths have an even number of segments, e.g. users/alice.');
  return path;
}

export function classify(error) {
  const code = String(error.code || 'error').replace(/^firestore\//, '');
  if (['permission-denied', 'storage/unauthorized', 'PERMISSION_DENIED'].includes(code)) return 'denied';
  return 'error';
}

export function safeError(error) {
  const authHelp = {
    'auth/invalid-api-key': 'Firebase rejected the API key. Copy it exactly from Firebase project settings; check uppercase I versus lowercase l in screenshots.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Firebase rejected the API key. Copy it exactly from Firebase project settings; check uppercase I versus lowercase l in screenshots.',
    'auth/operation-not-allowed': 'This sign-in provider is disabled. Enable the selected provider in Firebase Console → Authentication → Sign-in method, or choose an enabled method.',
    'auth/configuration-not-found': 'Firebase Authentication is not configured for this API key/project. Check the project and initialize Authentication in Firebase Console.',
    'auth/invalid-credential': 'Firebase rejected these credentials. Check the account, password or token and confirm it belongs to this project.',
    'auth/invalid-login-credentials': 'Firebase rejected these credentials. Check the account, password or token and confirm it belongs to this project.',
    'auth/wrong-password': 'The email/password combination was rejected. Check the credentials for this Firebase project.',
    'auth/user-not-found': 'The supplied account was not found in this Firebase project.',
    'auth/user-disabled': 'This account has been disabled by the project owner.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/invalid-custom-token': 'This is not a valid Firebase custom token. Firebase ID tokens belong in Tokens & requests; Google ID tokens use the Google method.',
    'auth/custom-token-mismatch': 'This custom token was created for another Firebase project.',
    'auth/unauthorized-domain': 'This host is not authorized for browser OAuth. Review Authentication → Settings → Authorized domains.',
    'auth/app-not-authorized': 'The API key or app restrictions reject this client. Use the project’s browser configuration and review its API key restrictions.',
    'auth/network-request-failed': 'Firebase Authentication could not be reached. Check your connection, browser network errors and extensions; then retry.',
    'auth/too-many-requests': 'Firebase temporarily limited sign-in requests. Wait before retrying; do not repeatedly submit credentials.',
    'auth/email-already-in-use': 'An account already uses this email. Choose Sign in instead of Create account.',
    'auth/weak-password': 'The password does not satisfy this project’s password policy.',
    'auth/invalid-verification-code': 'The SMS verification code was rejected. Check the code or request a new one.',
    'auth/code-expired': 'The SMS verification code expired. Request a new code.'
  };
  if (authHelp[error.code]) return `${error.code}: ${authHelp[error.code]}`;
  if (error.code) return `${error.code}: ${error.code.includes('permission') || error.code.includes('unauthorized') ? 'The current identity is not allowed to perform this operation.' : 'Request failed. Check configuration, provider settings, network access, and project rules.'}`;
  return error.message || 'Request failed.';
}

export function boundedNumber(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  return n;
}
