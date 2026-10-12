import { buildReadURL, decodeToken, jsonFetch } from './tokens.js?v=1.14.1';
export async function probeCanary({ project, collection, token, label, update = false, commit = null, probeId = `_firelab_probe_${crypto.randomUUID()}` }) {
  collection = collection.trim().replace(/^\/+|\/+$/g, '');
  buildReadURL(project, collection, 'collection');
  if (!/^_firelab_probe_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(probeId)) throw new Error('Invalid canary ID.');
  const id = probeId, path = `${collection}/${id}`;
  const name = `projects/${project}/databases/(default)/documents/${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) { const d = decodeToken(token); if (d.kind !== 'Firebase ID token') throw new Error('Canary checks require Firebase ID tokens.'); headers.Authorization = `Bearer ${d.token}`; }
  const send = commit || (write => jsonFetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`, { method: 'POST', headers, body: JSON.stringify({ writes: [write] }) }));
  const result = { project, collection, path, identity: label, create: 'not tested', update: 'not tested', delete: 'not tested', cleanupRequired: false, time: new Date().toISOString(), note: 'Synthetic canary schema only; does not establish permission for arbitrary documents.' };
  const fields = { firelabProbe: { stringValue: id }, createdAt: { timestampValue: result.time }, phase: { stringValue: 'created' } };
  function outcome(response, body) {
    if (response.ok) return 'allowed';
    if (body?.error?.details?.some?.(x => ['SERVICE_DISABLED', 'API_KEY_INVALID', 'CONSUMER_INVALID'].includes(x.reason))) return 'configuration error';
    const status = body?.error?.status;
    if (response.status === 403 && status === 'PERMISSION_DENIED') return 'denied';
    if (['ALREADY_EXISTS', 'FAILED_PRECONDITION', 'ABORTED'].includes(status)) return 'precondition failed';
    if (response.status === 401) return 'unauthenticated';
    return 'error';
  }
  let version;
  try {
    const { response, body } = await send({ update: { name, fields }, currentDocument: { exists: false } });
    result.create = outcome(response, body); result.createHttp = response.status;
    if (!response.ok) { result.cleanupRequired = response.status >= 500 || response.status === 408; return result; }
    version = body?.writeResults?.[0]?.updateTime;
    result.cleanupRequired = true;
    if (typeof version !== 'string' || !version) { result.delete = 'skipped: missing create version'; return result; }
  } catch { result.create = 'unknown: network/response error'; result.cleanupRequired = true; return result; }
  if (update) {
    try {
      const { response, body } = await send({ update: { name, fields: { ...fields, phase: { stringValue: 'updated' } } }, currentDocument: { updateTime: version } });
      result.update = outcome(response, body); result.updateHttp = response.status;
      if (response.ok) {
        const nextVersion = body?.writeResults?.[0]?.updateTime;
        if (typeof nextVersion !== 'string' || !nextVersion) { result.delete = 'skipped: missing update version'; return result; }
        version = nextVersion;
      }
    } catch { result.update = 'unknown: network/response error'; }
  }
  try {
    const { response, body } = await send({ delete: name, currentDocument: { updateTime: version } });
    result.delete = outcome(response, body); result.deleteHttp = response.status; result.cleanupRequired = !response.ok;
  } catch { result.delete = 'unknown: network/response error'; }
  return result;
}
