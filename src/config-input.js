import { inspectConfig, parseConfig } from './core.js?v=1.14.1';

export function setupConfigInput(notify) {
  const $ = id => document.getElementById(id);
  const fields = [...document.querySelectorAll('[id^="cfg-"]')];
  let manual = false, extra = {}, timer;
  const manualValue = () => ({ ...extra, ...Object.fromEntries(fields.map(f => [f.id.slice(4), f.value.trim()]).filter(([, v]) => v)) });
  function source() { return manual ? JSON.stringify(manualValue()) : $('config').value; }
  function feedback() {
    clearTimeout(timer);
    const box = $('config-feedback'); box.replaceChildren();
    if (!source().trim()) { box.textContent = 'Waiting for config. Nothing is sent until you connect.'; box.className = 'config-feedback'; return; }
    try {
      const result = inspectConfig(source());
      box.className = `config-feedback ${result.missing.length ? 'incomplete' : 'ready'}`;
      const title = document.createElement('strong'); title.textContent = `${result.missing.length ? '○' : '✓'} ${manual ? 'Manual configuration' : result.format} ${result.missing.length ? '· needs ' + result.missing.join(', ') : '· ready to initialize'}`;
      box.append(title);
      const chips = document.createElement('div'); chips.className = 'config-chips';
      for (const key of ['projectId', 'storageBucket', 'appId']) {
        if (!result.config[key]) continue;
        const chip = document.createElement('span'); chip.textContent = `${key}: ${result.config[key]}${result.inferred.includes(key) ? ' (inferred)' : ''}`; chips.append(chip);
      }
      box.append(chips);
      for (const warning of result.warnings) { const p = document.createElement('p'); p.textContent = warning; box.append(p); }
    } catch (e) { box.className = 'config-feedback incomplete'; box.textContent = e.message; }
  }
  function mode(toManual) {
    if (manual === toManual) return;
    if (toManual) {
      try {
        const { config } = inspectConfig($('config').value);
        extra = Object.fromEntries(Object.entries(config).filter(([key]) => !fields.some(f => f.id === `cfg-${key}`)));
        fields.forEach(f => f.value = config[f.id.slice(4)] || '');
      } catch { if ($('config').value.trim()) notify('The snippet could not be parsed. Fill in the manual fields directly.', true); }
    } else $('config').value = JSON.stringify(manualValue(), null, 2);
    manual = toManual;
    $('paste-input').hidden = manual; $('manual-input').hidden = !manual;
    for (const [id, selected] of [['mode-paste', !manual], ['mode-manual', manual]]) { $(id).classList.toggle('selected', selected); $(id).setAttribute('aria-pressed', String(selected)); }
    feedback();
  }
  $('mode-paste').onclick = () => mode(false); $('mode-manual').onclick = () => mode(true);
  $('config').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(feedback, 100); });
  fields.forEach(f => f.addEventListener('input', feedback));
  async function loadFile(file) {
    if (!file) return;
    if (file.size > 1024 * 1024 || !/\.(json|xml|js|txt)$/i.test(file.name)) { notify('Choose a JSON, XML, JavaScript, or text config file under 1 MB.', true); return; }
    try { const text = await file.text(); mode(false); $('config').value = text; feedback(); notify(`Imported ${file.name}. Review the detected values, then connect.`); }
    catch { notify('Could not read this file.', true); }
    $('config-file').value = '';
  }
  $('import-config').onclick = () => $('config-file').click();
  $('config-file').onchange = () => loadFile($('config-file').files[0]);
  const drop = $('config-drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('dragging'); };
  drop.ondragleave = () => drop.classList.remove('dragging');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('dragging'); if (e.dataTransfer.files.length !== 1) notify('Drop one configuration file at a time.', true); else loadFile(e.dataTransfer.files[0]); };
  return {
    read() { feedback(); return parseConfig(source()); },
    clear() { extra = {}; fields.forEach(f => f.value = ''); $('config').value = ''; $('config-file').value = ''; feedback(); },
    set(config) { mode(false); $('config').value = JSON.stringify(config, null, 2); feedback(); }
  };
}
