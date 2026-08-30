import { state } from './store.js';
import { faviconUrl, hostOf, el } from './util.js';
import { flatBookmarks } from './library.js';
import * as gh from './github.js';

const overlay = document.getElementById('overlay');
const input = document.getElementById('cmdInput');
const results = document.getElementById('cmdResults');

let rows = [];   // [{ label, sub, icon, run }]
let sel = 0;

export function openCmd(prefill = '') {
  overlay.hidden = false;
  input.value = prefill;
  input.focus();
  input.select();
  update();
}

export function closeCmd() {
  overlay.hidden = true;
  input.value = '';
  results.textContent = '';
  rows = [];
}

function panelItems() {
  const out = [];
  for (const p of state.panels) {
    if (p.type !== 'links') continue;
    for (const i of p.items) out.push({ ...i, panel: p.title });
  }
  return out;
}

function build(q) {
  const query = q.trim();
  const lower = query.toLowerCase();
  const groups = [];
  if (!lower) {
    const recent = panelItems().slice(0, 8);
    if (recent.length) {
      groups.push(['On your dashboard', recent.map(i => ({
        label: i.title, sub: i.panel, icon: faviconUrl(i.url), run: () => go(i.url)
      }))]);
    }
    return groups;
  }

  const match = t => t.toLowerCase().includes(lower);

  const dash = panelItems().filter(i => match(i.title) || match(i.url)).slice(0, 6);
  if (dash.length) groups.push(['Dashboard', dash.map(i => ({
    label: i.title, sub: i.panel, icon: faviconUrl(i.url), run: () => go(i.url)
  }))]);

  const seen = new Set(dash.map(i => i.url));
  const marks = flatBookmarks.filter(b => !seen.has(b.url) && (match(b.title) || match(b.url))).slice(0, 8);
  if (marks.length) groups.push(['Bookmarks', marks.map(b => ({
    label: b.title, sub: b.folder || hostOf(b.url), icon: faviconUrl(b.url), run: () => go(b.url)
  }))]);

  const prs = gh.cachedPRs().filter(p => match(p.title) || match(p.repo) || match(String(p.number))).slice(0, 8);
  if (prs.length) groups.push(['Pull requests', prs.map(p => ({
    label: `#${p.number} ${p.title}`, sub: p.repo, icon: p.avatar, run: () => go(p.url)
  }))]);

  const actions = [];
  if (/^https?:\/\//i.test(query) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(query)) {
    const url = /^https?:/i.test(query) ? query : 'https://' + query;
    actions.push({ label: `Open ${url}`, sub: 'URL', icon: faviconUrl(url), run: () => go(url) });
  }
  actions.push({
    label: `Search the web for “${query}”`, sub: 'Google', icon: '',
    run: () => go('https://www.google.com/search?q=' + encodeURIComponent(query))
  });
  groups.push(['Actions', actions]);

  return groups;
}

function go(url) {
  closeCmd();
  location.href = url;
}

function update() {
  const groups = build(input.value);
  results.textContent = '';
  rows = [];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    results.appendChild(el('div', { class: 'cmd-group', text: label }));
    for (const item of items) {
      const idx = rows.length;
      const row = el('div', { class: 'cmd-row', dataset: { i: String(idx) } }, [
        item.icon ? el('img', { src: item.icon, alt: '' }) : el('span', { class: 'cmd-icon', text: '→' }),
        el('span', { class: 't', text: item.label }),
        item.sub ? el('span', { class: 'sub', text: item.sub }) : null
      ]);
      row.addEventListener('click', item.run);
      row.addEventListener('pointerenter', () => { sel = idx; paint(); });
      results.appendChild(row);
      rows.push(item);
    }
  }
  sel = 0;
  paint();
}

function paint() {
  const nodes = results.querySelectorAll('.cmd-row');
  nodes.forEach((n, i) => n.classList.toggle('sel', i === sel));
  nodes[sel]?.scrollIntoView({ block: 'nearest' });
}

input.addEventListener('input', update);

input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); paint(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
  else if (e.key === 'Enter') { e.preventDefault(); rows[sel]?.run(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCmd(); }
});

overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeCmd(); });
