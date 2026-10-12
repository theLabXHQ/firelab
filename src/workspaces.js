import { parseConfig, validatePath } from './core.js?v=1.14.1';

const KEY = 'firelab.workspaces.v1', SCHEMA = 'firelab.workspaces/v1';
export const WORKSPACE_SETTINGS = {
  'audit-profile': ['standard','aggressive'], 'audit-scope-mode': ['auto','discovery','custom'],
  'audit-engine': ['rest','sdk'], 'audit-concurrency': ['1','5','10','25','50'],
  'audit-rate': ['0','5','10','25','50','100'], 'audit-sample': ['1','5','25','100']
};
function paths(value, collections = false) {
  if (!Array.isArray(value) || value.length > (collections ? 100 : 500)) throw new Error('Workspace contains too many paths.');
  return [...new Set(value.map(path => {
    if (typeof path !== 'string' || path.length > 1500 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid workspace path.');
    const result = validatePath(path, collections ? 'collection' : path.split('/').filter(Boolean).length % 2 ? 'collection' : 'document');
    if (result.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid workspace path segment.');
    return result;
  }))];
}
export function cleanWorkspace(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new Error('Use a workspace name of 1–80 characters.');
  if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)) throw new Error('Workspace requires a Firebase config.');
  const config = parseConfig(JSON.stringify(value.config));
  const settings = {};
  for (const [key, allowed] of Object.entries(WORKSPACE_SETTINGS)) {
    if (value.settings?.[key] !== undefined) {
      if (!allowed.includes(value.settings[key])) throw new Error('Unsupported workspace scan setting.');
      settings[key] = value.settings[key];
    }
  }
  return { name: value.name.trim(), config, collectionPaths: paths(value.collectionPaths || [], true), scanPaths: paths(value.scanPaths || []), settings };
}
export function workspaceStore(storage) {
  function read() {
    let raw; try { raw = storage().getItem(KEY); } catch { throw new Error('Browser storage is unavailable. Allow site storage to save workspaces.'); }
    if (!raw) return [];
    let doc; try { doc = JSON.parse(raw); } catch { throw new Error('Saved workspace data is unreadable. Existing data was not overwritten.'); }
    if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.items) || doc.items.length > 50) throw new Error('Unsupported saved workspace data.');
    const ids = new Set();
    return doc.items.map(item => {
      if (typeof item?.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('Invalid saved workspace identifier.');
      ids.add(item.id);
      return { ...cleanWorkspace(item), id: item.id, updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '' };
    });
  }
  function write(items) { try { storage().setItem(KEY, JSON.stringify({ schema: SCHEMA, items })); } catch { throw new Error('Workspace could not be saved. Browser storage may be full or blocked.'); } }
  return {
    read,
    save(value, id = null) {
      const clean = cleanWorkspace(value), items = read();
      if (id && !items.some(item => item.id === id)) throw new Error('This workspace was removed. Save a new workspace instead.');
      if (!id && items.length >= 50) throw new Error('Workspace limit is 50. Export or remove one first.');
      const item = { ...clean, id: id || Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join(''), updatedAt: new Date().toISOString() };
      write(id ? items.map(old => old.id === id ? item : old) : [...items, item]); return item;
    },
    remove(id) { write(read().filter(item => item.id !== id)); },
    export(item) { return JSON.stringify({ schema: SCHEMA, workspace: cleanWorkspace(item) }, null, 2); },
    import(raw) {
      if (raw.length > 1024 * 1024) throw new Error('Workspace file must be under 1 MB.');
      let doc; try { doc = JSON.parse(raw); } catch { throw new Error('Choose a valid workspace JSON file.'); }
      if (!doc || doc.schema !== SCHEMA) throw new Error('Unsupported workspace file version.');
      return this.save(doc.workspace);
    }
  };
}
export function setupWorkspaces({ snapshot, open, isBusy, notify, download }) {
  const $ = id => document.getElementById(id), store = workspaceStore(() => localStorage);
  let working = false;
  function refresh(selected = $('workspace-list').value) {
    const items = store.read();
    $('workspace-list').replaceChildren(new Option('Choose a saved workspace…',''), ...items.map(item => new Option(`${item.name} · ${item.config.projectId}`,item.id)));
    $('workspace-list').value = items.some(item => item.id === selected) ? selected : '';
    for (const id of ['workspace-open','workspace-update','workspace-delete','workspace-export']) $(id).disabled = !$('workspace-list').value;
    $('workspace-status').textContent = `${items.length} saved locally in this browser. Opening prepares setup; it sends no project requests.`;
  }
  function selected() { const item = store.read().find(item => item.id === $('workspace-list').value); if (!item) throw new Error('Select a saved workspace.'); return item; }
  const action = fn => async () => {
    if (working || isBusy()) { notify('Wait for the current operation or stop the scan before changing workspaces.', true); return; }
    working = true;
    try { await fn(); } catch (e) { notify(e.message || 'Workspace operation failed.',true); }
    finally { working = false; }
  };
  $('workspace-save').onclick = action(() => { const item = store.save({ ...snapshot(), name: $('workspace-name').value }); refresh(item.id); notify(`Saved workspace: ${item.name}`); });
  $('workspace-update').onclick = action(() => { const old = selected(), item = store.save({ ...snapshot(), name: $('workspace-name').value || old.name },old.id); refresh(item.id); notify(`Updated workspace: ${item.name}`); });
  $('workspace-open').onclick = action(async () => { const item = selected(); await open(item); $('workspace-name').value = item.name; notify(`Opened ${item.name}. Review setup, then Connect and sign in again.`); });
  $('workspace-list').onchange = action(() => { if ($('workspace-list').value) $('workspace-name').value = selected().name; refresh(); });
  $('workspace-delete').onclick = action(() => { const item = selected(); if (!confirm(`Delete saved workspace “${item.name}” from this browser?`)) return; store.remove(item.id); refresh(); notify('Saved workspace deleted.'); });
  $('workspace-export').onclick = action(() => { download(new Blob([store.export(selected())],{type:'application/json'}),'firelab-workspace.json'); });
  $('workspace-import').onclick = () => $('workspace-file').click();
  $('workspace-file').onchange = action(async () => {
    const file = $('workspace-file').files[0]; if (!file) return;
    try { if (file.size > 1024 * 1024) throw new Error('Workspace file must be under 1 MB.'); const item = store.import(await file.text()); refresh(item.id); $('workspace-name').value = item.name; notify('Workspace imported. Select Open to prepare it.'); }
    finally { $('workspace-file').value = ''; }
  });
  window.addEventListener('storage', event => { if (event.key === KEY) { try { refresh(); } catch (e) { notify(e.message,true); } } });
  try { refresh(); } catch (e) { $('workspace-status').textContent = e.message; }
}
