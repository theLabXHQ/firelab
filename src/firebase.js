import { LAB, LAB_PROJECT, LAB_PORTS, assertLabProject } from './lab.js?v=1.14.1';
import { jsonFetch } from './tokens.js?v=1.14.1';
import { parseConfig } from './core.js?v=1.14.1';
const CDN = 'https://www.gstatic.com/firebasejs/12.19.0/';
const modules = new Map();
export async function sdk(service) {
  if (!modules.has(service)) modules.set(service, import(`${CDN}firebase-${service.replace('/', '-')}.js`).catch(e => { modules.delete(service); throw e; }));
  return modules.get(service);
}

export async function connect(config, onIdentity) {
  config = parseConfig(JSON.stringify(config));
  assertLabProject(config.projectId);
  if (LAB && (config.apiKey !== "firelab-local-key" || config.storageBucket && config.storageBucket !== `${LAB_PROJECT}.appspot.com` || config.databaseURL && config.databaseURL !== `https://${LAB_PROJECT}-default-rtdb.firebaseio.com`)) throw new Error("Use the supplied local lab configuration.");
  const [a, authSDK] = await Promise.all([sdk('app'), sdk('auth')]);
  const app = a.initializeApp(config, `firelab-${crypto.randomUUID()}`);
  try {
    const auth = authSDK.initializeAuth(app, { persistence: authSDK.inMemoryPersistence });
    if (LAB) authSDK.connectAuthEmulator(auth, `http://127.0.0.1:${LAB_PORTS.auth}`, { disableWarnings: true });
    await auth.authStateReady();
    const unsubscribe = authSDK.onAuthStateChanged(auth, onIdentity);
    return { app, auth, config, unsubscribe, demo: false, labServices: new Set() };
  } catch (error) { await a.deleteApp(app); throw error; }
}

export async function disconnect(session) {
  if (!session || session.demo) return;
  session.unsubscribe();
  const a = await sdk('app');
  await a.deleteApp(session.app);
}

export async function authenticate(s, { method, action, email, password, token }) {
  if (!['anonymous', 'password', 'google', 'custom'].includes(method)) throw new Error('Choose a supported sign-in method.');
  const a = await sdk('auth');
  let result;
  if (method === 'anonymous') result = await a.signInAnonymously(s.auth);
  else if (method === 'password') result = await a[action === 'register' ? 'createUserWithEmailAndPassword' : 'signInWithEmailAndPassword'](s.auth, email, password);
  else if (method === 'google') result = await a.signInWithCredential(s.auth, a.GoogleAuthProvider.credential(token));
  else result = await a.signInWithCustomToken(s.auth, token);
  return { uid: result.user.uid, email: result.user.email, isAnonymous: result.user.isAnonymous };
}

export async function checkAuthConfiguration(config, host = location.hostname) {
  assertLabProject(config.projectId);
  if (LAB) return { environment: 'local-emulator', note: 'Cloud provider configuration is not tested in the local lab. Sign in with a lab account to check emulator connectivity.' };
  const { response, body } = await jsonFetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(config.apiKey)}`, { method: 'GET' });
  if (!response.ok) {
    const invalid = body?.error?.details?.some(d => d.reason === 'API_KEY_INVALID') || /API key not valid/i.test(body?.error?.message || '');
    const error = new Error('Firebase rejected the public Authentication configuration request.');
    error.code = invalid ? 'auth/invalid-api-key' : body?.error?.message === 'CONFIGURATION_NOT_FOUND' ? 'auth/configuration-not-found' : 'auth/app-not-authorized';
    if (response.status === 429) error.code = 'auth/too-many-requests';
    if (response.status >= 500) error.code = 'auth/network-request-failed';
    throw error;
  }
  const domains = Array.isArray(body.authorizedDomains) ? body.authorizedDomains.filter(x => typeof x === 'string') : [];
  return { publicAuthConfig: 'reachable', projectNumber: body.projectId || null, authorizedDomains: domains,
    oauthHostAuthorized: domains.includes(host),
    projectNumberMatches: config.messagingSenderId && body.projectId ? config.messagingSenderId === body.projectId : null,
    note: 'This checks public Auth configuration only. It does not verify credentials or establish which sign-in providers are enabled. Authorized domains affect browser OAuth, not email/password sign-in.' };
}

export async function firestore(s, p) {
  const f = await sdk('firestore/lite');
  const db = f.getFirestore(s.app);
  if (LAB && !s.labServices.has('firestore')) { f.connectFirestoreEmulator(db, '127.0.0.1', LAB_PORTS.firestore); s.labServices.add('firestore'); }
  if (p.operation === 'query') {
    const constraints = p.filters.map(x => f.where(x.field, x.op, x.value));
    if (p.order) constraints.push(f.orderBy(p.order, p.direction));
    constraints.push(f.limit(p.limit));
    const result = await f.getDocs(f.query(f.collection(db, p.path), ...constraints));
    return { count: result.size, documents: result.docs.map(d => ({ id: d.id, path: d.ref.path, data: d.data() })) };
  }
  const ref = f.doc(db, p.path);
  if (p.operation === 'get') {
    const d = await f.getDoc(ref);
    return { exists: d.exists(), path: p.path, data: d.exists() ? d.data() : null };
  }
  if (p.operation === 'set') await f.setDoc(ref, p.data, { merge: p.merge });
  if (p.operation === 'update') await f.updateDoc(ref, p.data);
  if (p.operation === 'delete') await f.deleteDoc(ref);
  return { operation: p.operation, path: p.path, completed: true };
}

export async function realtime(s, p) {
  try {
  if (!s.config.databaseURL) throw new Error('Reconnect with databaseURL in your config to use Realtime Database.');
  const r = await sdk('database');
  const db = r.getDatabase(s.app);
  if (LAB && !s.labServices.has('database')) { r.connectDatabaseEmulator(db, '127.0.0.1', LAB_PORTS.database); s.labServices.add('database'); }
  const ref = r.ref(db, p.path);
  if (p.operation === 'get') {
    const result = await r.get(r.query(ref, r.limitToFirst(100)));
    return { exists: result.exists(), value: result.val() };
  }
  if (p.operation === 'set') await r.set(ref, p.data);
  if (p.operation === 'update') await r.update(ref, p.data);
  if (p.operation === 'delete') await r.remove(ref);
  return { operation: p.operation, path: p.path || '/', completed: true };
  } catch (error) { if (error.message === 'Permission denied') error.code = 'permission-denied'; throw error; }
}

export async function storage(s, p) {
  if (!s.config.storageBucket) throw new Error('Reconnect with storageBucket in your config to use Cloud Storage.');
  const st = await sdk('storage');
  const service = st.getStorage(s.app);
  if (LAB && !s.labServices.has('storage')) { st.connectStorageEmulator(service, '127.0.0.1', LAB_PORTS.storage); s.labServices.add('storage'); }
  service.maxOperationRetryTime = 15000;
  service.maxUploadRetryTime = 30000;
  const ref = st.ref(service, p.path);
  if (p.operation === 'list') {
    const result = await st.list(ref, { maxResults: 100, ...(p.pageToken ? { pageToken: p.pageToken } : {}) });
    return { folders: result.prefixes.map(x => x.fullPath), files: result.items.map(x => x.fullPath), nextPageToken: result.nextPageToken || null };
  }
  if (p.operation === 'metadata') {
    const m = await st.getMetadata(ref);
    return { name: m.name, fullPath: m.fullPath, size: m.size, contentType: m.contentType, timeCreated: m.timeCreated, updated: m.updated, generation: m.generation, customMetadata: m.customMetadata || {} };
  }
  if (p.operation === 'download') return { blob: await st.getBlob(ref, 10 * 1024 * 1024), filename: ref.name };
  if (p.operation === 'upload') await st.uploadBytes(ref, p.file);
  if (p.operation === 'delete') await st.deleteObject(ref);
  return { operation: p.operation, path: p.path, completed: true };
}

export async function invoke(s, p) {
  if (LAB) throw new Error('Functions are not configured in this lab. No cloud function was called.');
  const f = await sdk('functions');
  return (await f.httpsCallable(f.getFunctions(s.app, p.region), p.name, { timeout: 30000 })(p.data)).data;
}
