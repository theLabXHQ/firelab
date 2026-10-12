export function createDemo(onIdentity) {
  const docs = new Map([
    ['posts/welcome', { title: 'Welcome to Firelab', published: true, author: 'demo' }],
    ['posts/getting-started', { title: 'Test your rules, understand your access', published: true, author: 'demo' }],
    ['users/demo', { name: 'Demo User', role: 'developer' }],
    ['settings/public', { theme: 'forest', version: '1.0.0' }]
  ]);
  const files = new Map([['images/readme.txt', new Blob(['Firelab demo file'], { type: 'text/plain' })]]);
  let realtimeData = { public: { settings: { enabled: true } } };
  let user = null;
  function allow(path) {
    if (path.split('/')[0] === 'private' || (path.split('/')[0] === 'users' && !user)) throw Object.assign(new Error('Denied by demo rules'), { code: 'permission-denied' });
  }
  return {
    demo: true, config: { projectId: 'firelab-demo' },
    async authenticate(p) { user = { uid: 'demo-user', email: p.email || null, isAnonymous: p.method === 'anonymous' }; onIdentity(user); return user; },
    async signout() { user = null; onIdentity(null); return { signedOut: true }; },
    async firestore(p) {
      allow(p.path);
      if (p.operation === 'query') {
        let results = [...docs].filter(([path]) => path.startsWith(`${p.path}/`) && path.split('/').length === p.path.split('/').length + 1).map(([path, data]) => ({ id: path.split('/').pop(), path, data: structuredClone(data) }));
        const field = (data, key) => key.split('.').reduce((v, k) => v?.[k], data);
        for (const filter of p.filters) results = results.filter(d => {
          const v = field(d.data, filter.field), x = filter.value;
          if (filter.op === '==') return JSON.stringify(v) === JSON.stringify(x);
          if (filter.op === '!=') return v !== undefined && JSON.stringify(v) !== JSON.stringify(x);
          if (filter.op === '<') return v < x;
          if (filter.op === '<=') return v <= x;
          if (filter.op === '>') return v > x;
          if (filter.op === '>=') return v >= x;
          if (filter.op === 'array-contains') return Array.isArray(v) && v.includes(x);
          if (filter.op === 'in') return x.includes(v);
          if (filter.op === 'not-in') return v !== undefined && !x.includes(v);
          if (filter.op === 'array-contains-any') return Array.isArray(v) && x.some(item => v.includes(item));
          return false;
        });
        if (p.order) results = results.filter(d => field(d.data, p.order) !== undefined).sort((a, b) => { const x = field(a.data, p.order), y = field(b.data, p.order); return (x === y ? 0 : x > y ? 1 : -1) * (p.direction === 'desc' ? -1 : 1); });
        results = results.slice(0, p.limit);
        return { count: results.length, documents: results };
      }
      if (p.operation === 'get') return { exists: docs.has(p.path), path: p.path, data: structuredClone(docs.get(p.path) || null) };
      if (p.operation === 'delete') docs.delete(p.path);
      if (p.operation === 'update' && !docs.has(p.path)) throw Object.assign(new Error('Missing document'), { code: 'not-found' });
      if (['set', 'update'].includes(p.operation)) docs.set(p.path, { ...((p.merge || p.operation === 'update') ? docs.get(p.path) : {}), ...p.data });
      return { completed: true, operation: p.operation, path: p.path };
    },
    async realtime(p) {
      allow(p.path);
      const keys = p.path.split('/').filter(Boolean);
      let value = realtimeData;
      for (const key of keys) value = value?.[key];
      if (p.operation === 'get') return { exists: value != null, value: structuredClone(value ?? null) };
      let replacement = p.operation === 'delete' ? null : p.operation === 'update' ? { ...value, ...p.data } : p.data;
      if (!keys.length) realtimeData = replacement;
      else {
        realtimeData ??= {};
        let parent = realtimeData;
        for (const key of keys.slice(0, -1)) { if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {}; parent = parent[key]; }
        if (replacement === null) delete parent[keys.at(-1)]; else parent[keys.at(-1)] = replacement;
      }
      return { completed: true, path: p.path, operation: p.operation };
    },
    async storage(p) {
      allow(p.path);
      if (p.operation === 'list') { const prefix = p.path ? `${p.path}/` : ''; const matching = [...files.keys()].filter(k => k.startsWith(prefix)); return { files: matching.filter(k => !k.slice(prefix.length).includes('/')), folders: [...new Set(matching.filter(k => k.slice(prefix.length).includes('/')).map(k => prefix + k.slice(prefix.length).split('/')[0]))], nextPageToken: null }; }
      if (p.operation === 'upload') files.set(p.path, p.file);
      else if (!files.has(p.path)) throw Object.assign(new Error('Missing file'), { code: 'storage/object-not-found' });
      if (p.operation === 'metadata') return { fullPath: p.path, size: files.get(p.path).size, contentType: files.get(p.path).type };
      if (p.operation === 'download') return { blob: files.get(p.path), filename: p.path.split('/').pop() };
      if (p.operation === 'delete') files.delete(p.path);
      return { completed: true, operation: p.operation, path: p.path };
    },
    async invoke(p) { return { demo: true, function: p.name, region: p.region, received: p.data, message: 'Simulated response; no backend function was invoked.' }; }
  };
}
