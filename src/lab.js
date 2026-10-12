export const LAB_PROJECT = 'demo-firelab-lab';
export const LAB = typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && new URLSearchParams(location.search).get('lab') === '1';
export const LAB_PORTS = { auth: 19099, firestore: 18085, database: 19000, storage: 19199 };
export function assertLabProject(project) {
  if (LAB && project !== LAB_PROJECT) throw new Error('Local lab accepts only demo-firelab-lab. Open a normal Firelab tab for other projects.');
}
export function labURL(raw) {
  if (!LAB) return raw;
  const url = new URL(raw);
  if (url.origin === `http://127.0.0.1:${LAB_PORTS.firestore}` && url.pathname.startsWith(`/v1/projects/${LAB_PROJECT}/`)) return url.href;
  if (url.hostname === 'firestore.googleapis.com' && url.protocol === 'https:' && url.pathname.startsWith(`/v1/projects/${LAB_PROJECT}/`)) return `http://127.0.0.1:${LAB_PORTS.firestore}${url.pathname}${url.search}`;
  if (['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'].includes(url.hostname) && url.protocol === 'https:' && url.searchParams.get('key') === 'firelab-local-key') return `http://127.0.0.1:${LAB_PORTS.auth}/${url.hostname}${url.pathname}${url.search}`;
  throw new Error('This request is outside the fixed local lab. No cloud request was sent.');
}
