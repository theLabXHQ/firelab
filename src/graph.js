import { validatePath } from './core.js?v=1.14.1';
import { icon } from './icons.js?v=1.14.1';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 278, HEIGHT = 188, MAX_NODES = 300;
const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
const keyFor = path => `${path.split('/').length % 2 ? 'c' : 'd'}:${path}`;
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : value?.constructor?.name === 'Timestamp' ? 'timestamp' : typeof value;

export function createGraph({ onRead, onOpen, onExport, notify }) {
  let sessionProject = null, auditProject = null;
  let nodes = new Map(), project = null, selected = null, locked = false, identity = 'signed out';
  let workspaceNodes = null, workspaceIdentity = null, auditSources = [], auditView = false;
  let view = { x: 30, y: 35, scale: 1 }, drag = null;
  let listMode = false;
  let collapsed = new Set(), focusRoot = null;
  const canvas = $('graph-canvas'), world = $('graph-world');
  function transform() { world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.scale})`; $('graph-zoom').textContent = `${Math.round(view.scale * 100)}%`; }
  function ancestors(id) { const chain = []; let node = nodes.get(id); while (node) { chain.unshift(node); node = nodes.get(node.parent); } return chain; }
  function matches(node) {
    const query = $('graph-search').value.trim().toLowerCase();
    return (!$('graph-kind').value || node.kind === $('graph-kind').value)
      && (!$('graph-status-filter').value || node.status === $('graph-status-filter').value)
      && (!query || [node.path || node.label, ...Object.keys(node.data || {})].some(value => value.toLowerCase().includes(query)));
  }
  function filtering() { return Boolean($('graph-search').value.trim() || $('graph-kind').value || $('graph-status-filter').value); }
  function visibleNodes() {
    let list = [...nodes.values()].filter(n => !n.hidden);
    if (focusRoot && nodes.has(focusRoot)) {
      const parents = new Set(ancestors(focusRoot).map(n => n.id));
      list = list.filter(n => parents.has(n.id) || ancestors(n.id).some(p => p.id === focusRoot));
    }
    if (filtering()) {
      const included = new Set(list.filter(matches).flatMap(n => ancestors(n.id).map(p => p.id)));
      return list.filter(n => included.has(n.id));
    }
    return list.filter(n => !ancestors(n.id).slice(0, -1).some(p => collapsed.has(p.id)));
  }
  function resetView() { collapsed.clear(); focusRoot = null; $('graph-search').value = ''; $('graph-kind').value = ''; $('graph-status-filter').value = ''; }
  function arrange(force = false) {
    const children = new Map();
    for (const node of visibleNodes()) { if (!children.has(node.parent)) children.set(node.parent, []); children.get(node.parent).push(node); }
    let row = 0;
    function place(node, depth) {
      const group = children.get(node.id) || [];
      const positions = group.map(child => place(child, depth + 1));
      const y = positions.length ? (positions[0] + positions.at(-1)) / 2 : row++ * (HEIGHT + 24);
      if (force) node.pinned = false;
      if (!node.pinned) { node.x = depth * 340; node.y = y; }
      return y;
    }
    if (nodes.has('project')) place(nodes.get('project'), 0);
    render();
  }
  function fit() {
    if (!canvas.clientWidth) return;
    const list = visibleNodes(); if (!list.length) return;
    const left = Math.min(...list.map(n => n.x)), top = Math.min(...list.map(n => n.y));
    const width = Math.max(...list.map(n => n.x + WIDTH)) - left, height = Math.max(...list.map(n => n.y + HEIGHT)) - top;
    view.scale = Math.max(.02, Math.min(1.15, (canvas.clientWidth - 70) / width, (canvas.clientHeight - 100) / height));
    view.x = (canvas.clientWidth - width * view.scale) / 2 - left * view.scale;
    view.y = (canvas.clientHeight - height * view.scale) / 2 - top * view.scale;
    transform();
  }
  function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    const next = Math.max(.02, Math.min(2, view.scale * factor)), ratio = next / view.scale;
    view.x = x - (x - view.x) * ratio; view.y = y - (y - view.y) * ratio; view.scale = next; transform();
  }
  function readable() {
    const node = nodes.get(selected) || nodes.get('project'); if (!node || !canvas.clientWidth) return;
    view.scale = 1;
    view.x = (canvas.clientWidth - WIDTH) / 2 - node.x;
    view.y = (canvas.clientHeight - HEIGHT) / 2 - node.y;
    transform();
  }
  function switchView(list) {
    listMode = list;
    $('graph-list-view').hidden = !list;
    canvas.hidden = list;
    for (const name of ['.canvas-label', '.graph-controls', '.canvas-help']) document.querySelector(name).hidden = list;
    for (const [id, active] of [['graph-view-map', !list], ['graph-view-list', list]]) { $(id).classList.toggle('selected', active); $(id).setAttribute('aria-pressed', String(active)); }
    for (const id of ['graph-fit', 'graph-layout', 'graph-readable']) { $(id).disabled = list; $(id).hidden = list; }
    if (!list) requestAnimationFrame(readable);
  }
  function addPaths(paths, rerender = true) {
    if (!project) throw new Error('Connect a project or start the demo first.');
    const pending = new Map();
    for (const path of paths) {
      const parts = validatePath(path, 'collection').split('/');
      for (let i = 1; i <= parts.length; i++) {
        const part = parts.slice(0, i).join('/'), id = keyFor(part);
        if (!nodes.has(id)) pending.set(id, { id, path: part, label: parts[i - 1], kind: i % 2 ? 'collection' : 'document', parent: i === 1 ? 'project' : keyFor(parts.slice(0, i - 1).join('/')), status: 'not loaded', x: 0, y: 0 });
      }
    }
    if (nodes.size + pending.size > MAX_NODES) throw new Error(`Graph limit is ${MAX_NODES} nodes. Disconnect to start a fresh workspace.`);
    pending.forEach((node, id) => nodes.set(id, node));
    if (rerender) { arrange(); fit(); }
  }
  function drawEdges() {
    const svg = $('graph-edges'); svg.replaceChildren();
    const visible = visibleNodes(), ids = new Set(visible.map(n => n.id)), selectedBranch = new Set(ancestors(selected).map(n => n.id));
    for (const node of visible) {
      const parent = nodes.get(node.parent); if (!parent || !ids.has(parent.id)) continue;
      const a = { x: parent.x + WIDTH, y: parent.y + 43 }, b = { x: node.x, y: node.y + 43 };
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + 55} ${a.y}, ${b.x - 55} ${b.y}, ${b.x} ${b.y}`);
      path.setAttribute('class', `graph-edge ${node.kind}${selectedBranch.has(node.id) ? ' highlighted' : ''}`); svg.append(path);
    }
  }
  function select(id) {
    if (!nodes.has(id)) return;
    if (!visibleNodes().some(n => n.id === id)) { resetView(); ancestors(id).forEach(n => collapsed.delete(n.id)); arrange(); }
    selected = id; render();
  }
  function button(text, action, cls = 'secondary') { const b = el('button', cls, text); b.type = 'button'; b.onclick = action; return b; }
  function renderInspector() {
    const box = $('inspector-content'); box.replaceChildren(); const node = nodes.get(selected);
    if (!node) { box.append(el('div', 'inspector-empty', 'Select a node to inspect its fields, read documents, or open a query.')); return; }
    box.append(el('div', `node-kind ${node.kind}`, `${node.kind.toUpperCase()} / ${node.status.toUpperCase()}`), el('h2', '', node.label), el('p', 'inspector-path', node.path || project.projectId));
    const trail = el('nav', 'graph-breadcrumbs'); trail.setAttribute('aria-label', 'Selected node ancestors');
    for (const parent of ancestors(node.id).slice(0, -1)) trail.append(button(parent.label, () => { select(parent.id); readable(); }, 'text-button'));
    if (trail.children.length) box.append(trail);
    const tools = el('div', 'graph-node-actions');
    const copy = async text => { try { await navigator.clipboard.writeText(text); notify('Copied to clipboard.'); } catch { notify('Clipboard unavailable. Select and copy the displayed text.', true); } };
    tools.append(button('Copy path', () => copy(node.path || project.projectId)));
    if (node.data !== undefined) tools.append(button('Copy JSON', () => copy(JSON.stringify(node.data, null, 2))));
    if (node.kind !== 'project') tools.append(button('Focus branch', () => { resetView(); focusRoot = node.id; arrange(); fit(); }));
    if ([...nodes.values()].some(n => n.parent === node.id)) {
      const fold = button(collapsed.has(node.id) ? 'Expand children' : 'Collapse children', () => { if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id); arrange(); fit(); });
      fold.disabled = filtering(); fold.title = filtering() ? 'Clear search and filters to collapse branches.' : '';
      fold.setAttribute('aria-expanded', String(!collapsed.has(node.id))); tools.append(fold);
    }
    box.append(tools);
    if (node.kind === 'project') {
      box.append(el('p', '', 'Add collection paths above to start mapping. Adding a node makes no request; use Load documents to read it.'), el('div', 'inspector-fact', `Identity: ${identity}`));
      if (project.demo) box.append(el('div', 'callout', 'DEMO · Simulated documents and permissions.'));
      const exportButton = button('Export graph JSON ↓', () => onExport({ project: project.projectId, demo: project.demo, identity, nodes: [...nodes.values()] })); box.append(exportButton); return;
    }
    if (node.kind === 'collection') {
      box.append(el('div', 'inspector-fact', `${node.count ?? 0} sampled documents · max 10 per graph read`));
      const load = button(node.status === 'loading' ? 'Loading…' : '↳ Load documents', () => onRead(node.path), 'primary graph-load'); load.disabled = locked || auditView; box.append(load);
      const open = button('Open query editor ↗', () => onOpen(node.path, 'query', project.projectId)); open.disabled = !sessionProject || sessionProject.projectId !== project.projectId; box.append(open);
      if (node.status === 'readable' && !node.count) box.append(el('p', '', 'The query succeeded with no matching documents. This does not prove the collection exists.'));
    } else {
      const open = button('Open document editor ↗', () => onOpen(node.path, 'get', project.projectId)); open.disabled = !sessionProject || sessionProject.projectId !== project.projectId; box.append(open);
      const form = el('form', 'subcollection-form'); const label = el('label', '', 'Known subcollection name'); label.htmlFor = 'graph-subcollection';
      const input = el('input'); input.id = 'graph-subcollection'; input.placeholder = 'comments'; input.required = true;
      const add = el('button', 'secondary', '+ Add subcollection'); add.type = 'submit'; add.disabled = locked || auditView;
      form.append(label, input, add); form.onsubmit = e => { e.preventDefault(); if (locked || auditView) return; try { if (!input.value.trim() || input.value.includes('/')) throw new Error('Enter one subcollection name.'); addPaths([`${node.path}/${input.value.trim()}`]); select(keyFor(`${node.path}/${input.value.trim()}`)); } catch (error) { notify(error.message, true); } }; box.append(form);
    }
    if (node.error) box.append(el('div', 'inspector-error', node.error));
    if (node.data !== undefined) {
      box.append(el('h3', 'fields-heading', 'DOCUMENT FIELDS'));
      const search = el('input'); search.type = 'search'; search.placeholder = 'Find a field…'; search.setAttribute('aria-label', 'Find document field'); box.append(search);
      const fields = el('div', 'inspector-fields');
      for (const [key, value] of Object.entries(node.data || {})) {
        const row = el('div', 'field-row'); row.append(el('strong', '', key), el('span', 'field-type', typeOf(value)), el('pre', '', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); fields.append(row);
      }
      box.append(fields);
      const empty = el('p', 'muted', 'No matching fields.'); empty.hidden = true; box.append(empty);
      search.oninput = () => { let count = 0; for (const row of fields.children) { row.hidden = !row.querySelector('strong').textContent.toLowerCase().includes(search.value.toLowerCase()); if (!row.hidden) count++; } empty.hidden = count !== 0; };
      const details = el('details', 'raw-document'); details.append(el('summary', '', 'Raw JSON'), el('pre', '', JSON.stringify(node.data, null, 2))); box.append(details);
    } else if (node.kind === 'document') box.append(el('p', '', 'Path added; no document data has been read for this identity.'));
  }
  function render() {
    const holder = $('graph-nodes'); holder.replaceChildren();
    const list = $('graph-list-view'); list.replaceChildren();
    const options = [];
    const visible = visibleNodes();
    for (const node of visible) {
      const iconName = node.kind === 'collection' ? 'firestore' : node.kind;
      const row = button('', () => select(node.id), `graph-list-row ${node.kind}${selected === node.id ? ' selected' : ''}`);
      row.dataset.listNodeId = node.id;
      const rowCopy = el('span', 'list-node-copy'); rowCopy.append(el('strong', '', node.label), el('small', '', node.path || project.projectId));
      const rowMeta = el('span', 'list-node-meta'); rowMeta.append(el('span', '', node.kind), el('span', `list-status ${node.status}`, node.status));
      row.append(icon(iconName), rowCopy, rowMeta); list.append(row);
      options.push(new Option(`${node.kind === 'project' ? 'Project' : node.kind === 'collection' ? 'Collection' : 'Document'} · ${node.path || node.label}`, node.id));
      const card = el('article', `graph-node ${node.kind} ${node.status.replaceAll(' ', '-')} ${selected === node.id ? 'selected' : ''}`);
      card.dataset.nodeId = node.id; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
      card.dataset.context = String(filtering() && !matches(node));
      row.dataset.context = card.dataset.context;
      card.ondblclick = () => { select(node.id); readable(); };
      const heading = button('', () => select(node.id), 'node-heading'); heading.setAttribute('aria-label', `Inspect ${node.kind} ${node.path || node.label}`);
      const symbol = el('span', 'node-symbol'); symbol.append(icon(iconName));
      heading.append(symbol, el('span', 'node-title', node.label), el('span', 'node-menu', '⠿'));
      const meta = el('div', 'node-meta'); meta.append(el('span', '', node.kind.toUpperCase()), el('span', 'node-status', node.status.toUpperCase()));
      card.append(heading, meta);
      const body = el('div', 'node-body');
      if (node.kind === 'project') { body.append(el('span', 'node-project-id', project.projectId), el('small', '', project.demo ? 'SIMULATED WORKSPACE' : 'FIREBASE CLIENT SDK')); }
      else if (node.kind === 'collection') {
        const fieldNames = new Set([...nodes.values()].filter(n => n.parent === node.id && n.data).flatMap(n => Object.keys(n.data)));
        if (fieldNames.size) { body.append(el('div', 'node-fields', [...fieldNames].slice(0, 3).join('  ·  '))); }
        else body.append(el('span', 'node-placeholder', node.status === 'denied' ? 'Access denied for this identity' : node.status === 'error' ? 'Request failed · inspect details' : 'Select node to load documents'));
        body.append(el('small', '', node.count !== undefined ? `${node.count} SAMPLED DOCUMENTS →` : 'COLLECTION PATH'));
      } else {
        const entries = Object.entries(node.data || {}).slice(0, 2);
        if (!entries.length) body.append(el('span', 'node-placeholder', node.data ? 'Empty document' : 'Document path · not read'));
        for (const [key, value] of entries) { const line = el('div', 'node-field'); line.append(el('span', '', key), el('code', '', typeof value === 'object' ? typeOf(value) : String(value))); body.append(line); }
      }
      card.append(body); holder.append(card);
    }
    $('graph-summary').textContent = `${visible.length} / ${nodes.size} nodes shown`;
    $('graph-filter-status').textContent = `${filtering() ? visible.filter(matches).length + ' matches · ancestor nodes kept for context' : visible.filter(n => n.kind === 'collection').length + ' collections · ' + visible.filter(n => n.kind === 'document').length + ' documents'}${focusRoot ? ' · focused branch' : ''}`;
    $('graph-empty-results').hidden = visible.length > 0;
    if (!visible.length) list.append(el('p', 'empty', 'No matching nodes. Clear filters to see the full graph.'));
    $('graph-jump').replaceChildren(...options); $('graph-jump').value = selected || '';
    drawEdges(); renderInspector(); transform();
  }
  function documentNode(path, data, exists = true) {
    const parentPath = path.split('/').slice(0, -1).join('/'); addPaths([parentPath], false);
    const id = keyFor(path), parent = nodes.get(keyFor(parentPath));
    if (!nodes.has(id) && nodes.size >= MAX_NODES) return;
    const node = nodes.get(id) || { id, parent: parent.id, kind: 'document', path, label: path.split('/').at(-1), x: parent.x + 340, y: parent.y };
    Object.assign(node, { data: exists ? data : undefined, status: exists ? 'readable' : 'missing', error: undefined }); nodes.set(id, node);
  }
  $('graph-add-form').onsubmit = e => { e.preventDefault(); if (locked) return; if (auditView) { notify('Choose Workspace to add collection paths.', true); return; } try { const paths = [...new Set($('graph-paths').value.split(/[,\n]+/).map(p => p.trim()).filter(Boolean))]; if (!paths.length || paths.length > 50) throw new Error('Add 1–50 collection paths at a time.'); addPaths(paths); $('graph-paths').value = ''; select(keyFor(validatePath(paths[0], 'collection'))); } catch (error) { notify(error.message, true); } };
  $('graph-layout').onclick = () => { arrange(true); fit(); }; $('graph-fit').onclick = fit;
  for (const id of ['graph-search', 'graph-kind', 'graph-status-filter']) $(id).addEventListener('input', () => { if (!visibleNodes().some(n => n.id === selected)) selected = null; arrange(); fit(); });
  $('graph-search').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const first = visibleNodes().find(matches); if (first) { select(first.id); readable(); } } if (e.key === 'Escape') { e.preventDefault(); $('graph-search').value = ''; arrange(); fit(); } });
  $('graph-show-all').onclick = () => { resetView(); arrange(); fit(); };
  $('graph-view-map').onclick = () => switchView(false); $('graph-view-list').onclick = () => switchView(true);
  $('graph-readable').onclick = readable;
  $('graph-jump').onchange = () => { select($('graph-jump').value); if (!listMode) readable(); };
  $('graph-zoom-in').onclick = () => zoom(1.2); $('graph-zoom-out').onclick = () => zoom(1 / 1.2);
  $('graph-reset').onclick = () => { view = { x: 30, y: 35, scale: 1 }; transform(); };
  canvas.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const card = e.target.closest('.graph-node');
    if (card && !e.target.closest('.node-heading')) return;
    drag = { id: card?.dataset.nodeId, x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.id) { const node = nodes.get(drag.id); node.pinned = true; node.x += dx / view.scale; node.y += dy / view.scale; const card = [...$('graph-nodes').children].find(c => c.dataset.nodeId === node.id); card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; drawEdges(); }
    else { view.x += dx; view.y += dy; transform(); }
  });
  canvas.addEventListener('pointerup', e => { const state = drag; drag = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); if (state?.id && !state.moved) select(state.id); });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  $('graph-nodes').addEventListener('click', e => { const body = e.target.closest('.node-body'); if (body) select(body.closest('.graph-node').dataset.nodeId); });
  canvas.addEventListener('keydown', e => { if (e.target !== canvas) return; if (e.key === '/') { e.preventDefault(); $('graph-search').focus(); return; } if (e.key.toLowerCase() === 'f') { fit(); return; } if (e.key === '0') { readable(); return; } const shifts = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] }; if (shifts[e.key]) { e.preventDefault(); view.x += shifts[e.key][0]; view.y += shifts[e.key][1]; transform(); } if (e.key === '+' || e.key === '=') zoom(1.2); if (e.key === '-') zoom(1 / 1.2); });
  function syncContext() {
    $('graph-connected').hidden = !project; $('graph-disconnected').hidden = !!project;
    $('graph-session').textContent = project ? `${auditView ? 'AUDIT SNAPSHOT' : project.demo ? 'DEMO' : 'SDK READY'} / ${project.projectId}` : 'NO PROJECT';
    if ($('graph-source').options.length) $('graph-source').options[0].disabled = !sessionProject;
  }
  function workspace() {
    if (workspaceNodes) nodes = workspaceNodes;
    if (workspaceIdentity !== null) identity = workspaceIdentity;
    workspaceNodes = null; workspaceIdentity = null; auditView = false; project = sessionProject; syncContext();
    $('graph-source').value = ''; $('graph-source-note').textContent = 'Workspace · requests use your current signed-in identity.';
  }
  function resetAudit() { workspace(); resetView(); auditSources = []; auditProject = null; $('graph-source').replaceChildren(new Option('Workspace · current session', '')); }
  $('graph-source').onchange = () => {
    resetView();
    const index = $('graph-source').value;
    if (index === '') { workspace(); selected = 'project'; arrange(); return; }
    const source = auditSources[Number(index)]; if (!source || !auditProject) return;
    if (!auditView) { workspaceNodes = nodes; workspaceIdentity = identity; }
    auditView = true; project = auditProject; identity = source.label; syncContext();
    nodes = new Map([['project', { id: 'project', label: project.projectId, kind: 'project', status: 'audit sample', x: 0, y: 0 }]]);
    for (const doc of source.documents) {
      try { addPaths([doc.path.split('/').slice(0, -1).join('/')], false); documentNode(doc.path, doc.data, true); const parent = nodes.get(keyFor(doc.path.split('/').slice(0,-1).join('/'))); if (parent) { parent.status = 'readable'; parent.count = (parent.count || 0) + 1; } } catch { break; }
    }
    for (const node of nodes.values()) if (node.kind === 'collection' && [...nodes.values()].filter(child => child.parent === node.id).length > 8) collapsed.add(node.id);
    selected = 'project'; $('graph-source-note').textContent = `Audit snapshot: ${source.label}. Showing ${[...nodes.values()].filter(n => n.kind === 'document' && n.data).length} of ${source.documents.length} retained document samples (300-node graph limit). Not a complete database. ${sessionProject?.projectId === project.projectId ? 'Choose Workspace to load more with the current session.' : 'Connect this project to run SDK requests.'}`;
    arrange(); fit();
  };
  const full = $('graph-connected');
  function fullLabel() { const active = document.fullscreenElement === full || full.classList.contains('graph-fullscreen'); $('graph-fullscreen').textContent = active ? 'Exit fullscreen' : 'Fullscreen'; $('graph-fullscreen').setAttribute('aria-pressed', String(active)); requestAnimationFrame(fit); }
  $('graph-fullscreen').onclick = async () => {
    if (document.fullscreenElement === full) await document.exitFullscreen();
    else if (full.classList.contains('graph-fullscreen')) full.classList.remove('graph-fullscreen');
    else { try { if (!full.requestFullscreen) throw Error(); await full.requestFullscreen(); } catch { full.classList.add('graph-fullscreen'); } }
    fullLabel();
  };
  document.addEventListener('fullscreenchange', fullLabel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && full.classList.contains('graph-fullscreen')) { full.classList.remove('graph-fullscreen'); fullLabel(); } });
  return {
    setSession(s) {
      resetView();
      resetAudit(); full.classList.remove('graph-fullscreen'); if (document.fullscreenElement === full) document.exitFullscreen().catch(() => {});
      project = sessionProject = s ? { projectId: s.config.projectId, demo: s.demo } : null; nodes = new Map(); selected = null; identity = 'signed out';
      $('graph-connected').hidden = !s; $('graph-disconnected').hidden = !!s; $('graph-paths').value = '';
      $('graph-session').textContent = s ? `${s.demo ? 'DEMO' : 'SDK READY'} / ${s.config.projectId}` : 'NO PROJECT';
      if (s) { nodes.set('project', { id: 'project', label: s.config.projectId, kind: 'project', status: s.demo ? 'demo' : 'initialized', x: 0, y: 0 }); selected = 'project'; }
      syncContext(); view = { x: 30, y: 35, scale: 1 }; render(); switchView(window.matchMedia('(max-width: 760px)').matches);
    },
    addPaths,
    clearAudit() { resetAudit(); render(); },
    auditSamples(projectId, samples) {
      resetAudit(); auditProject = { projectId, demo: sessionProject?.projectId === projectId && sessionProject.demo }; auditSources = samples.sources;
      auditSources.forEach((source, i) => $('graph-source').append(new Option(`${source.label} · ${source.documents.length} documents`, String(i))));
      if (auditSources.length) { $('graph-source').value = '0'; $('graph-source').onchange(); }
    },
    show() { requestAnimationFrame(() => { if (!listMode) fit(); }); },
    setBusy(value) { locked = value; document.querySelectorAll('.graph-load,.subcollection-form button').forEach(b => b.disabled = value || auditView); },
    select,
    identityChanged(user) {
      resetView();
      resetAudit();
      identity = user ? user.email || user.uid : 'signed out';
      for (const n of nodes.values()) if (n.kind !== 'project') { n.status = 'not loaded'; delete n.data; delete n.count; delete n.error; }
      render();
    },
    loading(path) { workspace(); addPaths([path], false); nodes.get(keyFor(path)).status = 'loading'; render(); },
    knownPaths() { return [...(workspaceNodes || nodes).values()].filter(n => n.path).map(n => n.path); },
    ingest(p, result) {
      workspace();
      if (!project) return;
      if (p.operation === 'query') {
        addPaths([p.path], false);
        const node = nodes.get(keyFor(p.path)); node.status = 'readable'; node.count = result.count; delete node.error;
        for (const child of nodes.values()) if (child.parent === node.id) { delete child.data; child.status = 'not loaded'; }
        for (const doc of result.documents) documentNode(doc.path, doc.data);
      } else if (p.operation === 'get') documentNode(p.path, result.data, result.exists);
      else {
        const node = nodes.get(keyFor(p.path));
        if (node) { delete node.data; node.status = p.operation === 'delete' ? 'deleted' : 'changed · reload'; }
        const parent = nodes.get(keyFor(p.path.split('/').slice(0, -1).join('/'))); if (parent) { parent.status = 'changed · reload'; delete parent.count; }
      }
      arrange();
    },
    failure(p, status, error) {
      workspace();
      if (!project) return;
      if (p.operation === 'query') addPaths([p.path], false);
      const node = nodes.get(keyFor(p.path));
      if (node) { node.status = status; node.error = error; delete node.count; delete node.data; for (const child of nodes.values()) if (child.path?.startsWith(`${node.path}/`)) { delete child.data; delete child.count; delete child.error; child.status = 'not loaded'; } }
      render();
    }
  };
}
