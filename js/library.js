import { faviconUrl, el } from './util.js';

const MIME = 'application/x-dash-item';
const treeBox = document.getElementById('libTree');
const filterInput = document.getElementById('libSearch');

let roots = [];
export let flatBookmarks = [];   // [{ title, url, folder }]

function collectLinks(node, out = []) {
  for (const c of node.children || []) {
    if (c.url) { if (/^https?:/i.test(c.url)) out.push({ title: c.title || c.url, url: c.url }); }
    else collectLinks(c, out);
  }
  return out;
}

function flatten(node, trail) {
  for (const c of node.children || []) {
    if (c.url) {
      if (/^https?:/i.test(c.url)) flatBookmarks.push({ title: c.title || c.url, url: c.url, folder: trail.join(' / ') });
    } else {
      flatten(c, [...trail, c.title].filter(Boolean));
    }
  }
}

function linkRow(node) {
  const row = el('div', { class: 'lib-row', draggable: 'true', title: `${node.title}\n${node.url}` }, [
    el('img', { src: faviconUrl(node.url), alt: '' }),
    el('span', { text: node.title || node.url })
  ]);
  row.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(MIME, JSON.stringify({ from: null, title: node.title || node.url, url: node.url }));
    e.dataTransfer.setData('text/uri-list', node.url);
  });
  return row;
}

function folderNode(node) {
  const wrap = el('div', { class: 'lib-folder closed' });
  const caret = el('span', { class: 'caret', text: '▸' });
  const row = el('div', { class: 'lib-row', draggable: 'true', title: `Drag to copy all links in “${node.title}”` }, [
    caret, el('span', { text: node.title || 'Folder' })
  ]);
  row.addEventListener('click', () => {
    wrap.classList.toggle('closed');
    caret.textContent = wrap.classList.contains('closed') ? '▸' : '▾';
  });
  row.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(MIME, JSON.stringify({ items: collectLinks(node) }));
  });

  const kids = el('div', { class: 'lib-children' });
  for (const c of node.children || []) kids.appendChild(c.url ? linkRow(c) : folderNode(c));
  wrap.append(row, kids);
  return wrap;
}

function renderTree() {
  treeBox.textContent = '';
  for (const r of roots) {
    const box = folderNode(r);
    box.classList.remove('closed');
    box.querySelector('.caret').textContent = '▾';
    treeBox.appendChild(box);
  }
}

function renderFiltered(q) {
  treeBox.textContent = '';
  const hits = flatBookmarks
    .filter(b => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q))
    .slice(0, 200);
  if (!hits.length) {
    treeBox.appendChild(el('p', { class: 'lib-hint', text: 'No matches.' }));
    return;
  }
  for (const b of hits) treeBox.appendChild(linkRow({ title: b.title, url: b.url }));
}

export async function loadLibrary() {
  const tree = await chrome.bookmarks.getTree();
  roots = (tree[0].children || []).filter(r => (r.children || []).length);
  flatBookmarks = [];
  for (const r of roots) flatten(r, [r.title].filter(Boolean));
  const q = filterInput.value.trim().toLowerCase();
  if (q) renderFiltered(q); else renderTree();
}

filterInput.addEventListener('input', () => {
  const q = filterInput.value.trim().toLowerCase();
  if (q) renderFiltered(q); else renderTree();
});

for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) {
  chrome.bookmarks[ev].addListener(() => loadLibrary());
}
