function value(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 30) return '[Unsupported value]';
  if ('nullValue' in v) return null;
  for (const key of ['booleanValue','stringValue','timestampValue','referenceValue','bytesValue','geoPointValue']) if (key in v) return v[key];
  if ('integerValue' in v) { const n = Number(v.integerValue); return Number.isSafeInteger(n) ? n : String(v.integerValue); }
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(x => value(x, depth + 1));
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k,v]) => [k,value(v,depth+1)]));
  return '[Unsupported value]';
}
export function sampleDocuments(project, job, response) {
  const base = `projects/${project}/databases/(default)/documents/`;
  const docs = response.documents || (job.kind === 'collection' ? response.body?.documents : response.body?.name ? [response.body] : []);
  if (!Array.isArray(docs)) return [];
  return docs.flatMap(doc => {
    const path = typeof doc.path === 'string' ? doc.path : typeof doc.name === 'string' && doc.name.startsWith(base) ? doc.name.slice(base.length) : null;
    if (!path || path.split('/').some(p => !p || p === '.' || p === '..')) return [];
    if (job.kind === 'document' ? path !== job.path : !path.startsWith(job.path + '/') || path.split('/').length !== job.path.split('/').length + 1) return [];
    return [{ path, data: doc.data ?? Object.fromEntries(Object.entries(doc.fields || {}).map(([k,v]) => [k,value(v)])) }];
  });
}
export function createSampleStore(maxDocuments = 200, maxBytes = 2 * 1024 * 1024) {
  const sources = new Map(); let size = 0, count = 0, truncated = false;
  return {
    add(project, job, response) {
      for (const doc of sampleDocuments(project, job, response)) {
        const key = `${job.label} · ${response.evidence.engine || 'rest'}`;
        if (!sources.has(key)) sources.set(key, new Map());
        const collection = sources.get(key);
        if (collection.has(doc.path)) continue;
        const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
        if (count >= maxDocuments || size + bytes > maxBytes) { truncated = true; continue; }
        collection.set(doc.path, doc); count++; size += bytes;
      }
    },
    snapshot() { return { count, bytes: size, truncated, sources: [...sources].map(([label,docs]) => ({ label, documents: [...docs.values()] })).filter(s => s.documents.length) }; }
  };
}
