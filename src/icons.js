const NS = 'http://www.w3.org/2000/svg';
const shapes = {
  security: ['M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z', 'm8 12 3 3 5-6'],
  tokens: ['M9 15a6 6 0 1 1 4-4L5 19H2v-3l5-5'],
  overview: ['M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z'],
  graph: ['M8 6h8M6 8v8m12-8v8M8 18h8', 'M4 4h4v4H4zm12 0h4v4h-4zM4 16h4v4H4zm12 0h4v4h-4z'],
  auth: ['M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z', 'm8 12 3 3 5-6'],
  firestore: ['M4 4h16v16H4zM4 9h16M4 14h16M9 9v11'],
  realtime: ['m13 2-9 12h7l-1 8 10-13h-7Z'],
  storage: ['M3 7h7l2 2h9v11H3ZM3 7V4h7l2 3h7v2'],
  functions: ['m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18'],
  checks: ['M8 3H4v5m12-5h4v5M4 16v5h4m8 0h4v-5', 'm7 12 3 3 7-7'],
  activity: ['M4 5h16M4 12h16M4 19h16', 'M8 3v4m8 3v4m-6 3v4'],
  project: ['M12 2 3 7v10l9 5 9-5V7ZM3 7l9 5 9-5M12 12v10', 'm7 5 10 6'],
  document: ['M5 2h9l5 5v15H5ZM14 2v6h5M8 12h8M8 16h6'],
  spark: ['m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z'],
  saber: ['M6 17 17 6a2.12 2.12 0 0 0-3-3L3 14ZM4 16l4 4m-5-3 4 4m-5-3 4 4M2 22l2-2']
};

export function icon(name, className = '') {
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `ui-icon ${className}` })) svg.setAttribute(key, value);
  for (const d of shapes[name] || shapes.spark) { const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}

export function installIcons() {
  document.querySelectorAll('.nav[data-tab]').forEach(button => button.firstElementChild.replaceChildren(icon(button.dataset.tab)));
  for (const key of document.querySelectorAll('.nav kbd')) { key.title = 'Keyboard shortcut ' + key.textContent; key.setAttribute('aria-label', key.title); }
  document.getElementById('autopwn-quick').firstElementChild.replaceChildren(icon('checks'));
  document.querySelectorAll('.toolkit [data-tab]').forEach(button => button.firstElementChild.replaceChildren(icon(button.dataset.tab)));


}
