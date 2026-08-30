import { state, save, uid, panelById, newPanel, COLORS, typeSpec } from './store.js';
import { faviconUrl, hostOf, el, ago, snap } from './util.js';
import * as gh from './github.js';
import { flatBookmarks } from './library.js';
import * as wx from './weather.js';
import * as quotes from './quotes.js';
import * as cal from './calendar.js';
import * as gcal from './gcal.js';

const canvas = document.getElementById('canvas');
const ctxmenu = document.getElementById('ctxmenu');
const MIME = 'application/x-dash-item';

/* Live panels (the clock) own an interval. Keyed by panel id so a re-render or
   a delete always clears the old one instead of stacking ticks. */
const timers = new Map();

/* Transient per-panel filter text (not persisted — a new tab starts clean). */
const FILTERABLE = new Set(['links', 'board', 'github', 'todo']);
const filters = new Map();

/* Every renderBody bumps a panel's generation. Async renderers (github, weather,
   calendar) capture it and bail if a newer render started while they awaited —
   otherwise a slow in-flight fetch repaints stale content over the fresh one,
   which looks exactly like "refresh does nothing". */
const generation = new Map();
const bumpGen = id => { const n = (generation.get(id) || 0) + 1; generation.set(id, n); return n; };
const isStale = (id, mine) => generation.get(id) !== mine;
const filterOf = panel => filters.get(panel.id) || '';

/** Below this width panels are stacked by CSS, so moving them is meaningless. */
export const isStacked = () => window.matchMedia('(max-width: 900px)').matches;
const hits = (text, q) => !q || String(text).toLowerCase().includes(q);

export function toggleFilter(panel, node) {
  if (filters.has(panel.id)) filters.delete(panel.id); else filters.set(panel.id, '');
  renderBody(panel, node);
  node.querySelector('.panel-filter')?.focus();
}

/** Adds the filter box when the panel is already scrolling, or when it is open. */
function addFilterRow(panel, node, mount, scroller = mount) {
  if (!FILTERABLE.has(panel.type)) return;
  const open = filters.has(panel.id);
  if (!open && scroller.scrollHeight <= scroller.clientHeight + 4) return;

  const input = el('input', {
    class: 'panel-filter', type: 'search', spellcheck: 'false',
    placeholder: 'Filter this panel…', value: filterOf(panel)
  });
  input.addEventListener('input', () => {
    filters.set(panel.id, input.value.trim().toLowerCase());
    renderBody(panel, node);
    const again = node.querySelector('.panel-filter');
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { filters.delete(panel.id); renderBody(panel, node); }
  });
  mount.prepend(el('div', { class: 'filter-row' }, [input]));
}
function setTimer(id, handle) { clearTimer(id); timers.set(id, handle); }
function clearTimer(id) {
  const h = timers.get(id);
  if (h) { clearInterval(h); timers.delete(id); }
}
let activePanel = null;   // { panel, node } — target for the 'a' shortcut

/* Stacking order IS the order of state.panels, so z-index stays in 1..N and
   survives a reload. Previously this was an ever-incrementing counter, which
   eventually climbed above the command bar and context menu. */
function applyStackOrder() {
  state.panels.forEach((p, i) => {
    const n = canvas.querySelector(`.panel[data-id="${p.id}"]`);
    if (n) n.style.zIndex = String(i + 1);
  });
}

export function bringToFront(panel, node) {
  const i = state.panels.indexOf(panel);
  if (i >= 0 && i !== state.panels.length - 1) {
    state.panels.splice(i, 1);
    state.panels.push(panel);
    save();
  }
  if (node) node.style.zIndex = String(state.panels.length);
  applyStackOrder();
}

/* ------------------------------------------------------------------ render */

export function renderAll() {
  canvas.textContent = '';
  for (const p of state.panels) canvas.appendChild(renderPanel(p));
}

function headAction(panel, node) {
  const mk = (glyph, title, fn) => {
    const btn = el('button', { class: 'icon-btn', title }, [document.createTextNode(glyph)]);
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const spins = glyph === '⟳';                 // don't spin the "+" actions
      if (spins) btn.classList.add('spinning');
      try { await fn(); } catch { /* the panel shows its own error */ }
      if (spins) setTimeout(() => btn.classList.remove('spinning'), 350);
    });
    return btn;
  };

  switch (panel.type) {
    case 'github':  return mk('⟳', 'Refresh pull requests', () => refreshGithub(panel, node));   // returns the render promise
    case 'weather': return mk('⟳', 'Refresh weather', () => { wx.invalidate(panel.id); return renderBody(panel, node); });
    case 'calendar': return mk('⟳', 'Refresh calendar', () => { cal.invalidate(panel.id); return renderBody(panel, node); });
    case 'quote':   return mk('⟳', 'Another quote', () => nextQuote(panel, node));
    case 'clock':   return null;
    case 'todo':    return mk('+', 'Add a task', () => focusTodoInput(node));
    case 'board':   return mk('+', 'Add a card', () => addCard(panel, node));
    default:        return mk('+', 'Add a link (or press A with the panel focused)', () => showAddForm(panel, node));
  }
}

export function renderPanel(panel) {
  // normalize panels that came from an older version or an imported layout
  if (!Array.isArray(panel.items)) panel.items = [];
  if (!panel.gh) panel.gh = { assigned: true, review: true, created: true, extraQuery: '', limit: 8 };
  if (!Array.isArray(panel.todos)) panel.todos = [];
  if (typeof panel.opacity !== 'number') panel.opacity = 74;
  if (!Array.isArray(panel.tabs)) panel.tabs = [];
  // v2 boards stored a flat `groups` array — fold it into a single tab
  if (Array.isArray(panel.groups) && panel.groups.length && !panel.tabs.length) {
    panel.tabs = [{ id: uid(), title: 'Bookmarks', cards: panel.groups }];
    delete panel.groups;
  }
  if (panel.type === 'board' && !panel.tabs.length) {
    panel.tabs = [{ id: uid(), title: 'Bookmarks', cards: [] }];
  }
  if (panel.type === 'board' && !panel.tabs.some(t => t.id === panel.boardTab)) {
    panel.boardTab = panel.tabs[0].id;
  }

  const node = el('section', {
    class: 'panel',
    dataset: { id: panel.id, layout: panel.layout || 'list' },
    style: `--pc:${panel.color}; --pa:${panel.opacity ?? 74}; left:${panel.x}px; top:${panel.y}px; width:${panel.w}px; height:${panel.h}px; z-index:${state.panels.indexOf(panel) + 1}`
  });

  const title = el('div', { class: 'panel-title', text: panel.title });
  const count = el('span', { class: 'panel-count' });
  const head = el('div', { class: 'panel-head' }, [
    el('span', { class: 'panel-dot', style: `background:${panel.color}` }),
    title,
    count,
    FILTERABLE.has(panel.type)
      ? el('button', { class: 'icon-btn', title: 'Filter this panel', onclick: e => { e.stopPropagation(); toggleFilter(panel, node); } }, [document.createTextNode('⌕')])
      : null,
    headAction(panel, node),
    el('button', { class: 'icon-btn', title: 'Panel menu', onclick: e => { e.stopPropagation(); openMenu(panel, node, e.clientX, e.clientY); } }, [document.createTextNode('⋯')])
  ]);

  head.addEventListener('pointerdown', e => startDrag(e, panel, node));
  head.addEventListener('dblclick', e => { if (e.target === title) editTitle(panel, title); });
  head.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(panel, node, e.clientX, e.clientY); });

  const body = el('div', { class: 'panel-body' });

  /* A headerless panel still needs somewhere to grab and a way back to the menu:
     a grip that fades in on hover, top-right. */
  const grip = el('div', { class: 'panel-grip', title: 'Drag to move · click for the menu' }, [
    el('span', { class: 'grip-dots', text: '⠿' })
  ]);
  /* startDrag calls preventDefault on pointerdown, which suppresses the follow-up
     click event — so the menu has to be opened from pointerup-without-movement
     rather than from a click listener. */
  grip.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const onMove = ev => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) moved = true; };
    const onUp = ev => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!moved) openMenu(panel, node, ev.clientX, ev.clientY);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    startDrag(e, panel, node);
  });

  if (panel.hideHeader) {
    node.classList.add('no-head');
    node.append(grip, body);
  } else {
    node.append(head, body);
  }
  node.append(
    el('div', { class: 'rz rz-e' }), el('div', { class: 'rz rz-s' }), el('div', { class: 'rz rz-se' }));

  for (const h of node.querySelectorAll('.rz')) {
    h.addEventListener('pointerdown', e => startResize(e, panel, node, h.classList.contains('rz-e') ? 'e' : h.classList.contains('rz-s') ? 's' : 'se'));
  }

  node.addEventListener('pointerdown', () => { activePanel = { panel, node }; bringToFront(panel, node); });
  node.addEventListener('contextmenu', e => {
    if (!panel.hideHeader || e.target.closest('a, input, [contenteditable="true"]')) return;
    e.preventDefault();
    openMenu(panel, node, e.clientX, e.clientY);
  });
  wireDropZone(panel, node, body);
  renderBody(panel, node);
  return node;
}

export function renderBody(panel, node) {
  const body = node.querySelector('.panel-body');
  const count = node.querySelector('.panel-count');   // null when the header is hidden
  const setCount = v => { if (count) count.textContent = v; };
  clearTimer(panel.id);
  const gen = bumpGen(panel.id);
  body.textContent = '';

  if (panel.type !== 'links') {
    setCount('');
    if (panel.type === 'github') return renderGithub(panel, node, gen);
    if (panel.type === 'clock') return renderClock(panel, node);
    if (panel.type === 'weather') return renderWeather(panel, node, gen);
    if (panel.type === 'quote') return renderQuote(panel, node);
    if (panel.type === 'todo') return renderTodo(panel, node);
    if (panel.type === 'board') return renderBoard(panel, node);
    if (panel.type === 'calendar') return renderCalendar(panel, node, gen);
    return;
  }

  setCount(panel.items.length || '');
  if (!panel.items.length) {
    body.appendChild(el('div', {
      class: 'panel-empty clickable',
      text: 'Drag bookmarks in from the library — or click here to paste a URL.',
      onclick: () => showAddForm(panel, node)
    }));
    return;
  }

  const q = filterOf(panel);
  const shown = q ? panel.items.filter(i => hits(i.title, q) || hits(i.url, q)) : panel.items;

  const list = el('ul', { class: 'items' });
  for (const item of shown) list.appendChild(itemEl(panel, item, node));
  body.appendChild(list);
  if (q && !shown.length) body.appendChild(el('div', { class: 'panel-empty', text: 'Nothing matches that filter.' }));
  addFilterRow(panel, node, body);
}

/** Turn a bookmark's name into an editable field (the URL is left alone). */
function startItemEdit(anchor, nameEl, item, onSave) {
  anchor.draggable = false;
  nameEl.contentEditable = 'true';
  nameEl.classList.add('editing');
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    nameEl.contentEditable = 'false';
    nameEl.classList.remove('editing');
    anchor.draggable = true;
    const v = nameEl.textContent.trim();
    if (v) { item.title = v; onSave(); }
    nameEl.textContent = item.title;
    anchor.title = `${item.title}\n${item.url}`;
  };
  nameEl.addEventListener('blur', finish, { once: true });
  nameEl.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = item.title; nameEl.blur(); }
  });
}

function itemEl(panel, item, node) {
  const name = el('span', { class: 'name', text: item.title });
  const a = el('a', {
    class: 'item', href: item.url, draggable: 'true',
    title: `${item.title}\n${item.url}`, dataset: { itemId: item.id }
  }, [
    el('img', { src: faviconUrl(item.url), alt: '' }),
    name,
    el('button', {
      class: 'ed', text: '✎', title: 'Rename',
      onclick: e => { e.preventDefault(); e.stopPropagation(); startItemEdit(a, name, item, () => save()); }
    }),
    el('button', {
      class: 'rm', title: 'Remove',
      onclick: e => {
        e.preventDefault(); e.stopPropagation();
        panel.items = panel.items.filter(i => i.id !== item.id);
        save(); renderBody(panel, node);
      }
    }, [document.createTextNode('×')])
  ]);
  name.addEventListener('dblclick', e => { e.preventDefault(); startItemEdit(a, name, item, () => save()); });
  a.addEventListener('click', e => { if (name.isContentEditable) e.preventDefault(); });

  a.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(MIME, JSON.stringify({ from: panel.id, itemId: item.id, title: item.title, url: item.url }));
    e.dataTransfer.setData('text/uri-list', item.url);
    e.dataTransfer.setData('text/plain', item.url);
    a.classList.add('drag-ghost');
  });
  a.addEventListener('dragend', () => a.classList.remove('drag-ghost'));
  return el('li', {}, [a]);
}

/* ---------------------------------------------------------------- add link */

function normalizeUrl(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(v)) return 'https://' + v;
  return '';
}

/** Best-effort name for a URL: an existing bookmark's title, else the hostname. */
function guessTitle(url) {
  const match = flatBookmarks.find(b => b.url === url)
    || flatBookmarks.find(b => b.url.replace(/\/$/, '') === url.replace(/\/$/, ''));
  return match ? match.title : (hostOf(url) || url);
}

export function showAddForm(panel, node) {
  if (panel.type !== 'links') return;
  const body = node.querySelector('.panel-body');
  body.querySelector('.add-form')?.remove();

  const url = el('input', { class: 'add-url', type: 'text', placeholder: 'Paste a URL…', spellcheck: 'false' });
  const name = el('input', { class: 'add-name', type: 'text', placeholder: 'Name (optional)', spellcheck: 'false' });

  const commit = () => {
    const clean = normalizeUrl(url.value);
    if (!clean) { url.focus(); url.select(); return; }
    panel.items.push({ id: uid(), title: name.value.trim() || guessTitle(clean), url: clean });
    save();
    renderBody(panel, node);
    showAddForm(panel, node);          // stay open so several can be added in a row
  };

  const form = el('div', { class: 'add-form' }, [
    url, name,
    el('div', { class: 'add-actions' }, [
      el('button', { class: 'btn primary', text: 'Add', onclick: commit }),
      el('button', { class: 'btn', text: 'Done', onclick: () => form.remove() })
    ])
  ]);

  for (const input of [url, name]) {
    input.addEventListener('keydown', e => {
      e.stopPropagation();                        // don't trip the global shortcuts
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); form.remove(); }
    });
  }
  // pasting a URL straight into the empty form fills the name too
  url.addEventListener('paste', () => setTimeout(() => {
    const clean = normalizeUrl(url.value);
    if (clean && !name.value) name.placeholder = guessTitle(clean);
  }, 0));

  body.prepend(form);
  url.focus();
}

/* ------------------------------------------------------------------ github */

async function renderGithub(panel, node, gen = generation.get(panel.id)) {
  const body = node.querySelector('.panel-body');
  body.textContent = '';

  if (!gh.hasToken()) {
    const btn = el('button', { text: 'open settings', onclick: () => document.getElementById('settingsBtn').click() });
    body.appendChild(el('div', { class: 'gh-msg' }, [
      document.createTextNode('Add a GitHub token and username in '), btn, document.createTextNode(' to load your PRs.')
    ]));
    return;
  }

  body.appendChild(el('div', { class: 'gh-msg', text: 'Loading pull requests…' }));
  try {
    const sections = await gh.fetchPanel(panel);
    if (isStale(panel.id, gen)) return;
    body.textContent = '';
    const q = filterOf(panel);
    let total = 0;
    for (const s of sections) {
      const prs = q ? s.prs.filter(p => hits(p.title, q) || hits(p.repo, q) || hits(p.number, q)) : s.prs;
      if (!prs.length) continue;
      total += prs.length;
      body.appendChild(el('div', { class: 'gh-section', text: `${s.label} · ${prs.length}` }));
      for (const pr of prs) body.appendChild(prRow(pr));
    }
    const c = node.querySelector('.panel-count'); if (c) c.textContent = total || '';
    if (!total) body.appendChild(el('div', { class: 'gh-msg', text: 'No open pull requests match this panel.' }));
    addFilterRow(panel, node, body);
  } catch (err) {
    body.textContent = '';
    body.appendChild(el('div', { class: 'gh-msg', text: String(err.message || err) }));
  }
}

function prRow(pr) {
  return el('a', { class: 'pr', href: pr.url, title: `${pr.repo}#${pr.number} — ${pr.title}` }, [
    pr.avatar ? el('img', { src: pr.avatar, alt: '' }) : null,
    el('span', { class: 'num', text: `#${pr.number}` }),
    el('span', { class: 't', text: pr.title }),
    pr.draft ? el('span', { class: 'badge draft', text: 'draft' }) : null,
    el('span', { class: 'repo', text: `${pr.repo} · ${ago(pr.updated)}` })
  ]);
}

export function refreshGithub(panel, node) {
  gh.invalidate(panel.id);
  return renderBody(panel, node);
}

export function refreshAllGithub() {
  for (const p of state.panels) {
    if (p.type !== 'github') continue;
    const node = canvas.querySelector(`.panel[data-id="${p.id}"]`);
    if (node) refreshGithub(p, node);
  }
}

/* ------------------------------------------------------------------ clock */

function renderClock(panel, node) {
  const body = node.querySelector('.panel-body');
  const cfg = panel.clock || (panel.clock = { format24: false, showSeconds: false, message: '' });

  const dateEl = el('div', { class: 'clock-date' });
  const timeEl = el('div', { class: 'clock-time' });
  const msgEl = el('div', { class: 'clock-msg', text: cfg.message || '' });
  body.appendChild(el('div', { class: 'clock' }, [dateEl, timeEl, msgEl]));

  const tick = () => {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    const opts = { hour: '2-digit', minute: '2-digit', hour12: !cfg.format24 };
    if (cfg.showSeconds) opts.second = '2-digit';
    const str = now.toLocaleTimeString(undefined, opts);

    timeEl.textContent = '';
    const suffix = /\s*([AP]M)\s*$/i.exec(str);
    if (suffix) {
      timeEl.append(
        document.createTextNode(str.slice(0, suffix.index)),
        el('span', { class: 'ampm', text: suffix[1].toUpperCase() })
      );
    } else {
      timeEl.textContent = str;
    }
  };

  tick();
  setTimer(panel.id, setInterval(tick, cfg.showSeconds ? 1000 : 10000));
}

/* ---------------------------------------------------------------- weather */

function setWeatherLocation(panel, node) {
  const body = node.querySelector('.panel-body');
  clearTimer(panel.id);
  body.textContent = '';

  const input = el('input', {
    class: 'add-url', type: 'text', spellcheck: 'false',
    placeholder: 'City — e.g. Bengaluru, Singapore', value: panel.weather?.place || ''
  });
  const status = el('div', { class: 'gh-msg' });

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    status.textContent = `Looking up “${name}”…`;
    try {
      const place = await wx.geocode(name);
      panel.weather = { units: 'metric', ...(panel.weather || {}), place: name, ...place };
      if (!panel.title || panel.title === 'Weather') {
        panel.title = place.label;
        const t = node.querySelector('.panel-title');
        if (t) t.textContent = place.label;
      }
      save();
      wx.invalidate(panel.id);
      renderBody(panel, node);
    } catch (err) {
      status.textContent = String(err.message || err);
    }
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();                       // keep the global shortcuts out of it
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); renderBody(panel, node); }
  });

  body.appendChild(el('div', { class: 'add-form' }, [
    input,
    el('div', { class: 'add-actions' }, [
      el('button', { class: 'btn primary', text: 'Set location', onclick: submit })
    ]),
    status
  ]));
  input.focus();
}

function weatherPrompt(panel, node, message) {
  const body = node.querySelector('.panel-body');
  body.textContent = '';
  body.appendChild(el('div', { class: 'gh-msg' }, [
    document.createTextNode(message + ' '),
    el('button', { text: 'Set a location', onclick: () => setWeatherLocation(panel, node) })
  ]));
}

async function renderWeather(panel, node, gen = generation.get(panel.id)) {
  const body = node.querySelector('.panel-body');
  const cfg = panel.weather || (panel.weather = { units: 'metric', lat: null, lon: null });

  if (cfg.lat == null || cfg.lon == null) {
    weatherPrompt(panel, node, 'No location yet.');
    return;
  }

  body.appendChild(el('div', { class: 'gh-msg', text: 'Loading weather…' }));
  try {
    const d = await wx.fetchWeather(panel);
    if (isStale(panel.id, gen)) return;
    const now = wx.describe(d.code, d.isDay);
    body.textContent = '';

    body.appendChild(el('div', { class: 'wx' }, [
      el('div', { class: 'wx-now' }, [
        el('div', { class: 'wx-icon', text: now.icon }),
        el('div', { class: 'wx-temp' }, [
          document.createTextNode(String(d.temp)),
          el('span', { class: 'wx-unit', text: d.unit })
        ]),
        el('div', { class: 'wx-meta' }, [
          el('div', { class: 'wx-cond', text: now.label }),
          el('div', { class: 'wx-place', text: '📍 ' + (cfg.label || cfg.place || '') }),
          el('div', { class: 'wx-feels', text: `Feels ${d.feels}${d.unit}` })
        ])
      ]),
      el('div', { class: 'wx-days' }, d.days.map(day => {
        const di = wx.describe(day.code, true);
        return el('div', { class: 'wx-day' }, [
          el('div', { class: 'wx-dname', text: day.day }),
          el('div', { class: 'wx-dicon', text: di.icon, title: di.label }),
          el('div', { class: 'wx-dtemp' }, [
            document.createTextNode(`${day.max}°`),
            el('span', { class: 'wx-dmin', text: `${day.min}°` })
          ])
        ]);
      }))
    ]));
  } catch (err) {
    weatherPrompt(panel, node, String(err.message || err) + '.');
  }
}

/* ------------------------------------------------------------------ quote */

function currentQuote(panel) {
  const cfg = panel.quote || (panel.quote = { index: quotes.quoteOfTheDay(), daily: true });
  return quotes.quoteAt(cfg.daily ? quotes.quoteOfTheDay() : cfg.index);
}

function nextQuote(panel, node) {
  const cfg = panel.quote || (panel.quote = { index: 0, daily: false });
  cfg.daily = false;
  cfg.index = quotes.randomIndex(cfg.index);
  save();
  renderBody(panel, node);
}

function renderQuote(panel, node) {
  const body = node.querySelector('.panel-body');
  const q = currentQuote(panel);
  body.appendChild(el('div', { class: 'quote' }, [
    el('div', { class: 'quote-mark', text: '“' }),
    el('div', { class: 'quote-text', text: q.text }),
    el('div', { class: 'quote-author', text: '— ' + q.author })
  ]));
}

/* --------------------------------------------------------------- calendar */

function calConfig(panel) {
  if (!panel.cal) panel.cal = {};
  const c = panel.cal;
  if (!c.mode) c.mode = c.icsUrl ? 'ics' : 'oauth';
  if (!c.calendarId) c.calendarId = 'primary';
  if (!c.lookAheadHours) c.lookAheadHours = 12;
  if (!c.max) c.max = 3;
  if (c.hideAllDay === undefined) c.hideAllDay = true;
  return c;
}

/* ---- setup screens ---- */

function copyRow(label, value) {
  const field = el('input', { class: 'copy-field', type: 'text', value, readonly: 'readonly', spellcheck: 'false' });
  field.addEventListener('focus', () => field.select());
  return el('div', { class: 'copy-row' }, [
    el('span', { class: 'copy-label', text: label }),
    field,
    el('button', {
      class: 'btn', text: 'Copy',
      onclick: e => {
        navigator.clipboard?.writeText(value);
        e.target.textContent = 'Copied';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
      }
    })
  ]);
}

/** Grow a panel so a setup form actually fits, instead of hiding it below the fold.
    The original height is remembered and restored once setup is done. */
const preSetupHeight = new Map();

function ensureHeight(panel, node, min) {
  if (panel.h >= min) return;
  if (!preSetupHeight.has(panel.id)) preSetupHeight.set(panel.id, { prev: panel.h, applied: min });
  else preSetupHeight.get(panel.id).applied = min;
  panel.h = min;
  node.style.height = min + 'px';
  save();
}

function restoreHeight(panel, node) {
  const saved = preSetupHeight.get(panel.id);
  if (!saved) return;
  preSetupHeight.delete(panel.id);
  if (panel.h !== saved.applied) return;      // the user resized it themselves — leave it
  panel.h = saved.prev;
  node.style.height = saved.prev + 'px';
  save();
}

function calendarSetup(panel, node, message) {
  const cfg = calConfig(panel);
  const body = node.querySelector('.panel-body');
  clearTimer(panel.id);
  body.textContent = '';

  if (cfg.mode === 'ics') { icsSetup(panel, node, message); return; }

  const input = el('input', {
    class: 'add-url', type: 'text', spellcheck: 'false',
    placeholder: '1234567890-abc….apps.googleusercontent.com',
    value: gcal.clientId()
  });
  const status = el('div', { class: 'gh-msg', text: message || '' });

  const submit = async () => {
    const id = input.value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(id)) {
      status.textContent = 'That should end in .apps.googleusercontent.com';
      return;
    }
    state.settings.gcalClientId = id;
    save();
    status.textContent = 'Opening Google sign-in…';
    try {
      await gcal.getToken({ interactive: true });
      renderBody(panel, node);
    } catch (err) {
      status.textContent = String(err.message || err);
    }
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  const steps = el('ol', { class: 'cal-steps', hidden: 'hidden' }, [
    el('li', { text: 'console.cloud.google.com → create (or pick) a project' }),
    el('li', { text: 'APIs & Services → Library → enable “Google Calendar API”' }),
    el('li', { text: 'OAuth consent screen → External → add yourself under Test users' }),
    el('li', { text: 'Credentials → Create credentials → OAuth client ID → Web application' }),
    el('li', { text: 'Under “Authorised redirect URIs”, paste the Redirect URI above — exactly' }),
    el('li', { text: 'Copy the Client ID it gives you into the box above' })
  ]);
  const toggle = el('button', {
    class: 'link-btn', text: 'How do I get a client ID? ▾',
    onclick: () => {
      steps.hidden = !steps.hidden;
      toggle.textContent = steps.hidden ? 'How do I get a client ID? ▾' : 'Hide the steps ▴';
      if (!steps.hidden) ensureHeight(panel, node, 430);
    }
  });

  ensureHeight(panel, node, 300);

  body.appendChild(el('div', { class: 'add-form' }, [
    el('div', { class: 'cal-help' }, [el('b', { text: 'Google Calendar client ID' })]),
    input,
    el('div', { class: 'add-actions' }, [
      el('button', { class: 'btn', text: 'Use an iCal URL', onclick: () => { cfg.mode = 'ics'; save(); renderBody(panel, node); } }),
      el('button', { class: 'btn primary', text: 'Connect', onclick: submit })
    ]),
    status,
    copyRow('Redirect URI', gcal.redirectUri()),
    toggle,
    steps
  ]));
  input.focus();
}

function icsSetup(panel, node, message) {
  const cfg = calConfig(panel);
  const body = node.querySelector('.panel-body');
  clearTimer(panel.id);
  body.textContent = '';

  const input = el('input', {
    class: 'add-url', type: 'text', spellcheck: 'false',
    placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
    value: cfg.icsUrl || ''
  });
  const status = el('div', { class: 'gh-msg', text: message || '' });

  const submit = () => {
    const url = input.value.trim();
    if (!/^https:\/\/.+\.ics(\?.*)?$/i.test(url)) {
      status.textContent = 'That should be a https URL ending in .ics';
      return;
    }
    cfg.icsUrl = url;
    cfg.mode = 'ics';
    save();
    cal.invalidate(panel.id);
    renderBody(panel, node);
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); renderBody(panel, node); }
  });

  ensureHeight(panel, node, 320);

  body.appendChild(el('div', { class: 'add-form' }, [
    input,
    el('div', { class: 'add-actions' }, [
      el('button', { class: 'btn', text: 'Sign in with Google', onclick: () => { cfg.mode = 'oauth'; save(); renderBody(panel, node); } }),
      el('button', { class: 'btn primary', text: 'Connect', onclick: submit })
    ]),
    status,
    el('div', { class: 'cal-help' }, [
      el('b', { text: 'Where to find this URL' }),
      el('ol', { class: 'cal-steps' }, [
        el('li', { text: 'Open calendar.google.com on a computer (not the phone app)' }),
        el('li', { text: 'Left sidebar → My calendars → hover your calendar → ⋮ → Settings and sharing' }),
        el('li', { text: 'Scroll to the bottom, to the “Integrate calendar” section' }),
        el('li', { text: 'Copy “Secret address in iCal format” (click the eye icon to reveal it)' })
      ]),
      el('div', { class: 'cal-warn', text: 'No “Secret address”? A Workspace admin disabled it — use the Google sign-in option instead.' })
    ])
  ]));
  input.focus();
}

function connectScreen(panel, node, message) {
  const body = node.querySelector('.panel-body');
  clearTimer(panel.id);
  ensureHeight(panel, node, 300);
  body.textContent = '';

  const id = gcal.clientId();
  const diag = el('div', { class: 'cal-diag', hidden: 'hidden' }, [
    el('div', {}, [el('b', { text: 'identity API: ' }), document.createTextNode(gcal.identityReady() ? 'available' : 'MISSING — reload the extension')]),
    el('div', {}, [el('b', { text: 'client ID: ' }), document.createTextNode(id ? `…${id.slice(-28)}` : 'not set')]),
    el('div', {}, [el('b', { text: 'redirect URI: ' }), document.createTextNode(gcal.redirectUri())]),
    el('div', {}, [el('b', { text: 'last step: ' }), document.createTextNode(gcal.diagnostics.lastStep || '—')]),
    el('div', { class: 'cal-diag-err' }, [el('b', { text: 'last error: ' }), document.createTextNode(gcal.diagnostics.lastError || '—')])
  ]);
  const toggle = el('button', {
    class: 'link-btn', text: 'Show diagnostics ▾',
    onclick: () => {
      diag.hidden = !diag.hidden;
      toggle.textContent = diag.hidden ? 'Show diagnostics ▾' : 'Hide diagnostics ▴';
      if (!diag.hidden) ensureHeight(panel, node, 420);
    }
  });

  body.appendChild(el('div', { class: 'add-form' }, [
    el('div', { class: 'cal-help', text: message || 'Connect your Google account to show your next meeting.' }),
    el('div', { class: 'add-actions' }, [
      el('button', { class: 'btn', text: 'Client ID…', onclick: () => calendarSetup(panel, node) }),
      el('button', {
        class: 'btn primary', text: 'Sign in with Google',
        onclick: async e => {
          e.target.textContent = 'Opening…';
          try {
            await gcal.getToken({ interactive: true });
            renderBody(panel, node);
          } catch (err) {
            connectScreen(panel, node, String(err.message || err));
          }
        }
      })
    ]),
    toggle,
    diag
  ]));
}

/* ---- the panel itself ---- */

async function renderCalendar(panel, node, gen = generation.get(panel.id)) {
  const cfg = calConfig(panel);
  const body = node.querySelector('.panel-body');
  const lookAhead = cfg.lookAheadHours * 3600000;

  if (cfg.mode === 'oauth' && !gcal.isConfigured()) { calendarSetup(panel, node); return; }
  if (cfg.mode === 'ics' && !cfg.icsUrl) { icsSetup(panel, node); return; }

  body.appendChild(el('div', { class: 'gh-msg', text: 'Loading your calendar…' }));

  const from = Date.now() - 30 * 60000;      // keep just-started meetings visible
  const to = Date.now() + lookAhead;
  let list;

  try {
    if (cfg.mode === 'ics') {
      const events = await cal.fetchCalendar(panel);
      list = cal.expand(events, from, to).map(o => ({ ...o, link: cal.meetingLink(o) }));
    } else {
      try {
        await gcal.getToken({ interactive: false });
      } catch (err) {
        connectScreen(panel, node, 'Click “Sign in with Google” to authorise read-only access to your calendar.');
        return;
      }
      list = await gcal.fetchEvents(cfg.calendarId, from, to);
      if (!state.settings.gcalAccount) {
        gcal.accountEmail()
          .then(email => { if (email) { state.settings.gcalAccount = email; save(); } })
          .catch(() => { /* display only */ });
      }
    }
  } catch (err) {
    if (isStale(panel.id, gen)) return;
    const msg = String(err.message || err);
    if (cfg.mode === 'oauth') connectScreen(panel, node, msg);
    else icsSetup(panel, node, msg);
    return;
  }
  if (isStale(panel.id, gen)) return;
  restoreHeight(panel, node);

  const paint = () => {
    const now = Date.now();
    const shown = list.filter(o =>
      (cfg.hideAllDay ? !o.allDay : true) &&
      !(cfg.hideDeclined && o.declined) &&
      o.end > now - 30 * 60000 &&
      o.start < now + lookAhead
    );

    body.textContent = '';
    if (!shown.length) {
      body.appendChild(el('div', { class: 'gh-msg', text: `Nothing scheduled in the next ${cfg.lookAheadHours} hours.` }));
      return;
    }

    const [next, ...later] = shown;
    const live = next.start <= now && next.end > now;
    const when = live ? `ends ${cal.relative(next.end - now)}` : cal.relative(next.start - now);
    const time = d => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    body.appendChild(el('div', { class: 'cal' }, [
      el('div', { class: 'cal-next' }, [
        el('div', { class: 'cal-when' + (live ? ' live' : '') }, [
          live ? el('span', { class: 'cal-dot' }) : null,
          el('span', { text: live ? 'Happening now' : when })
        ]),
        el('div', { class: 'cal-title', text: next.summary, title: next.summary }),
        el('div', { class: 'cal-meta' }, [
          el('span', { text: `${time(next.start)} – ${time(next.end)}` }),
          live ? el('span', { class: 'cal-sub', text: `· ${when}` }) : null,
          next.link ? el('a', { class: 'cal-join', href: next.link, target: '_blank', text: 'Join →' }) : null
        ])
      ]),
      later.length ? el('div', { class: 'cal-later' }, [
        el('div', { class: 'gh-section', text: 'Later' }),
        ...later.slice(0, cfg.max).map(o => el('div', { class: 'cal-row', title: o.summary }, [
          el('span', { class: 'cal-row-time', text: o.allDay ? 'all day' : time(o.start) }),
          el('span', { class: 'cal-row-title', text: o.summary }),
          el('span', { class: 'cal-row-rel', text: cal.relative(o.start - now) })
        ]))
      ]) : null
    ]));
  };

  paint();

  /* Tick the relative labels every 30s; refetch every 5 minutes. */
  let ticks = 0;
  setTimer(panel.id, setInterval(() => {
    ticks++;
    if (ticks % 10 === 0) renderBody(panel, node);
    else paint();
  }, 30000));
}

async function chooseCalendar(panel, node) {
  ctxmenu.textContent = '';
  ctxmenu.appendChild(el('div', { class: 'menu-label', text: 'Loading calendars…' }));
  try {
    const list = await gcal.listCalendars();
    ctxmenu.textContent = '';
    ctxmenu.appendChild(el('div', { class: 'menu-label', text: 'Show calendar' }));
    for (const c of list) {
      ctxmenu.appendChild(el('button', {
        text: `${panel.cal.calendarId === c.id || (c.primary && panel.cal.calendarId === 'primary') ? '✓ ' : '   '}${c.name}`,
        onclick: () => {
          closeMenu();
          panel.cal.calendarId = c.primary ? 'primary' : c.id;
          panel.cal.calendarName = c.name;
          if (panel.title === 'Next meeting' || !panel.title) {
            const t = node.querySelector('.panel-title');
            if (t) t.textContent = panel.title;
          }
          save();
          renderBody(panel, node);
        }
      }));
    }
  } catch (err) {
    ctxmenu.textContent = '';
    ctxmenu.appendChild(el('div', { class: 'menu-label', text: String(err.message || err).slice(0, 90) }));
  }
}

/* ------------------------------------------------------------------ tasks */

const PRIORITIES = ['high', 'medium', 'low'];

export function focusTodoInput(node) {
  const input = node.querySelector('.todo-input');
  if (input) { input.focus(); input.scrollIntoView({ block: 'nearest' }); }
}

function todoRow(panel, node, t) {
  const check = el('button', {
    class: 'todo-check' + (t.done ? ' on' : ''),
    title: t.done ? 'Mark as not done' : 'Mark as done',
    onclick: () => { t.done = !t.done; save(); renderBody(panel, node); }
  }, [document.createTextNode(t.done ? '✓' : '')]);

  const text = el('span', { class: 'todo-text', text: t.text, title: 'Double-click to edit' });
  text.addEventListener('dblclick', () => {
    text.contentEditable = 'true';
    text.focus();
    const finish = () => {
      text.contentEditable = 'false';
      const v = text.textContent.trim();
      if (v) { t.text = v; save(); } else { text.textContent = t.text; }
    };
    text.addEventListener('blur', finish, { once: true });
    text.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); text.blur(); }
      if (ev.key === 'Escape') { text.textContent = t.text; text.blur(); }
    });
  });

  const pri = el('button', {
    class: `pri pri-${t.priority}`,
    text: t.priority[0].toUpperCase() + t.priority.slice(1),
    title: 'Click to change priority',
    onclick: () => {
      t.priority = PRIORITIES[(PRIORITIES.indexOf(t.priority) + 1) % PRIORITIES.length];
      save(); renderBody(panel, node);
    }
  });

  const rm = el('button', {
    class: 'rm', text: '×', title: 'Remove task',
    onclick: () => { panel.todos = panel.todos.filter(x => x.id !== t.id); save(); renderBody(panel, node); }
  });

  return el('li', { class: 'todo-row' + (t.done ? ' is-done' : '') }, [check, text, pri, rm]);
}

function renderTodo(panel, node) {
  const body = node.querySelector('.panel-body');
  const todos = panel.todos;
  const c = node.querySelector('.panel-count');
  if (c) c.textContent = todos.filter(t => !t.done).length || '';

  const q = filterOf(panel);
  const shown = q ? todos.filter(t => hits(t.text, q) || hits(t.priority, q)) : todos;

  const list = el('ul', { class: 'todos' });
  if (!todos.length) {
    list.appendChild(el('li', { class: 'panel-empty', text: 'Nothing yet. Add your first task below.' }));
  } else if (!shown.length) {
    list.appendChild(el('li', { class: 'panel-empty', text: 'Nothing matches that filter.' }));
  }
  for (const t of shown) list.appendChild(todoRow(panel, node, t));

  const input = el('input', { class: 'todo-input', type: 'text', placeholder: '+  Add a task…', spellcheck: 'false' });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (!text) return;
      panel.todos.push({ id: uid(), text, done: false, priority: 'medium' });
      save();
      renderBody(panel, node);
      focusTodoInput(node);
    }
    if (e.key === 'Escape') input.blur();
  });

  const done = todos.filter(t => t.done).length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;

  const wrap = el('div', { class: 'todo' }, [
    list,
    el('div', { class: 'todo-add' }, [input]),
    el('div', { class: 'todo-foot' }, [
      el('div', { class: 'todo-stat', text: todos.length ? `${done} of ${todos.length} tasks completed` : 'No tasks yet' }),
      el('div', { class: 'todo-bar' }, [el('div', { class: 'todo-fill', style: `width:${pct}%` })])
    ])
  ]);
  body.appendChild(wrap);
  addFilterRow(panel, node, wrap, list);
}

/* ------------------------------------------------------------------ board */

const CARD_PREVIEW = 12;   // links shown per board card before “View all”

function activeTab(panel) {
  return panel.tabs.find(t => t.id === panel.boardTab) || panel.tabs[0];
}

function findCard(panel, cardId) {
  for (const t of panel.tabs || []) {
    const c = (t.cards || []).find(x => x.id === cardId);
    if (c) return c;
  }
  return null;
}

function addTab(panel, node) {
  const tab = { id: uid(), title: 'New tab', cards: [] };
  panel.tabs.push(tab);
  panel.boardTab = tab.id;
  save();
  renderBody(panel, node);
  const btn = node.querySelector('.board-tab.sel');
  if (btn) renameTab(panel, btn, tab);
  return tab;
}

function addCard(panel, node) {
  const tab = activeTab(panel);
  if (!tab) return;

  const card = {
    id: uid(),
    title: 'New card',
    icon: '📁',
    color: COLORS[tab.cards.length % COLORS.length],
    items: [],
    expanded: false
  };
  tab.cards.push(card);
  save();

  // an active filter would hide the brand-new (empty) card
  if (filters.get(panel.id)) filters.set(panel.id, '');
  renderBody(panel, node);

  // drop straight into renaming, the way a new tab does
  const title = node.querySelector(`.bgroup[data-card-id="${card.id}"] .bgroup-title`);
  if (title) {
    title.scrollIntoView({ block: 'nearest' });
    inlineRename(title, () => card.title, v => { card.title = v; save(); });
  }
  return card;
}

/** Shared inline-rename for a tab button or a card title. */
function inlineRename(el_, getValue, setValue, done) {
  el_.contentEditable = 'true';
  el_.classList.add('editing');
  el_.focus();
  const range = document.createRange();
  range.selectNodeContents(el_);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = commit => {
    el_.contentEditable = 'false';
    el_.classList.remove('editing');
    const v = el_.textContent.trim();
    if (commit && v) setValue(v);
    el_.textContent = getValue();
    if (done) done();
  };
  el_.addEventListener('blur', () => finish(true), { once: true });
  el_.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); el_.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); el_.textContent = getValue(); el_.blur(); }
  });
}

function renameTab(panel, btn, tab) {
  inlineRename(btn, () => tab.title, v => { tab.title = v; save(); });
}

function tabMenu(panel, node, tab, x, y) {
  ctxmenu.textContent = '';
  const add = (label, fn) => ctxmenu.appendChild(el('button', { text: label, onclick: () => { closeMenu(); fn(); } }));

  add('Rename tab', () => {
    const btn = [...node.querySelectorAll('.board-tab')].find(b => b.dataset.tabId === tab.id);
    if (btn) renameTab(panel, btn, tab);
  });
  add('Add a card here', () => { panel.boardTab = tab.id; save(); renderBody(panel, node); addCard(panel, node); });
  add('New tab', () => addTab(panel, node));
  if (panel.tabs.length > 1) {
    add('Delete tab', () => {
      const n = tab.cards.reduce((a, c) => a + c.items.length, 0);
      if (n && !confirm(`Delete “${tab.title}” with ${tab.cards.length} card(s) and ${n} link(s)?`)) return;
      panel.tabs = panel.tabs.filter(t => t.id !== tab.id);
      if (panel.boardTab === tab.id) panel.boardTab = panel.tabs[0].id;
      save();
      renderBody(panel, node);
    });
  }
  ctxmenu.hidden = false;
  const r = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  ctxmenu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}

function cardEl(panel, node, tab, card, items) {
  const box = el('section', {
    class: 'bgroup',
    dataset: { cardId: card.id },
    style: `--gc:${card.color || 'var(--accent)'}`
  });

  const icon = el('button', {
    class: 'bgroup-icon', text: card.icon || '📁', title: 'Click to change the icon',
    onclick: () => {
      const v = prompt('Icon for this card (one emoji)', card.icon || '📁');
      if (v === null) return;
      card.icon = v.trim().slice(0, 4) || '📁';
      save(); renderBody(panel, node);
    }
  });

  const title = el('div', { class: 'bgroup-title', text: card.title, title: 'Double-click to rename' });
  title.addEventListener('dblclick', () =>
    inlineRename(title, () => card.title, v => { card.title = v; save(); }));

  const head = el('div', { class: 'bgroup-head' }, [
    icon, title,
    el('span', { class: 'bgroup-count', text: String(card.items.length) }),
    el('button', {
      class: 'rm', text: '×', title: 'Delete this card',
      onclick: () => {
        if (card.items.length && !confirm(`Delete “${card.title}” and its ${card.items.length} links?`)) return;
        tab.cards = tab.cards.filter(x => x.id !== card.id);
        save(); renderBody(panel, node);
      }
    })
  ]);

  const limit = panel.cardPreview ?? CARD_PREVIEW;
  const list = el('ul', { class: 'bgroup-items' });
  const shown = card.expanded ? items : items.slice(0, limit);
  for (const item of shown) list.appendChild(cardItem(panel, node, card, item));
  if (!items.length) list.appendChild(el('li', { class: 'bgroup-empty', text: 'Drag bookmarks here' }));

  box.append(head, list);
  if (items.length > limit) {
    box.appendChild(el('button', {
      class: 'bgroup-more',
      text: card.expanded ? 'Show less ↑' : `View all ${items.length} →`,
      onclick: () => { card.expanded = !card.expanded; save(); renderBody(panel, node); }
    }));
  }

  wireCardDrop(panel, node, card, box);
  return box;
}

function cardItem(panel, node, card, item) {
  const name = el('span', { class: 'name', text: item.title });
  const a = el('a', {
    class: 'item', href: item.url, draggable: 'true',
    title: `${item.title}\n${item.url}`, dataset: { itemId: item.id }
  }, [
    el('img', { src: faviconUrl(item.url), alt: '' }),
    name,
    el('button', {
      class: 'ed', text: '✎', title: 'Rename',
      onclick: e => { e.preventDefault(); e.stopPropagation(); startItemEdit(a, name, item, () => save()); }
    }),
    el('button', {
      class: 'rm', text: '×', title: 'Remove',
      onclick: e => {
        e.preventDefault(); e.stopPropagation();
        card.items = card.items.filter(i => i.id !== item.id);
        save(); renderBody(panel, node);
      }
    })
  ]);
  name.addEventListener('dblclick', e => { e.preventDefault(); startItemEdit(a, name, item, () => save()); });
  a.addEventListener('click', e => { if (name.isContentEditable) e.preventDefault(); });
  a.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(MIME, JSON.stringify({
      from: panel.id, cardId: card.id, itemId: item.id, title: item.title, url: item.url
    }));
    e.dataTransfer.setData('text/uri-list', item.url);
    a.classList.add('drag-ghost');
  });
  a.addEventListener('dragend', () => a.classList.remove('drag-ghost'));
  return el('li', {}, [a]);
}

function wireCardDrop(panel, node, card, box) {
  box.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MIME) ? 'move' : 'copy';
    box.classList.add('drop-target');
  });
  box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) box.classList.remove('drop-target'); });
  box.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    box.classList.remove('drop-target');

    const raw = e.dataTransfer.getData(MIME);
    let dropped = [];
    let sourcePanel = null;

    if (raw) {
      const payload = JSON.parse(raw);
      if (payload.from === panel.id && payload.cardId === card.id) return;
      sourcePanel = payload.from ? panelById(payload.from) : null;
      dropped = extractDragged(payload);
    } else {
      const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      for (const line of (uri || '').split(/\r?\n/)) {
        const u = line.trim();
        if (/^https?:\/\//i.test(u)) dropped.push({ id: uid(), title: hostOf(u) || u, url: u });
      }
    }
    if (!dropped.length) return;

    card.items.push(...dropped);
    save();
    if (sourcePanel && sourcePanel.id !== panel.id) {
      const srcNode = canvas.querySelector(`.panel[data-id="${sourcePanel.id}"]`);
      if (srcNode) renderBody(sourcePanel, srcNode);
    }
    renderBody(panel, node);
  });
}

/** Pull the dragged item out of wherever it came from (panel list, board card,
    or the library) and return it as a fresh array. */
function extractDragged(payload) {
  if (payload.items) return payload.items.map(i => ({ id: uid(), title: i.title, url: i.url }));

  const src = payload.from ? panelById(payload.from) : null;
  if (!src) return [{ id: uid(), title: payload.title, url: payload.url }];

  const cardId = payload.cardId || payload.groupId;      // groupId: pre-tabs payloads
  const bucket = cardId ? findCard(src, cardId) : src;
  if (!bucket || !Array.isArray(bucket.items)) return [];
  const idx = bucket.items.findIndex(i => i.id === payload.itemId);
  if (idx < 0) return [];
  return bucket.items.splice(idx, 1);
}

function renderBoard(panel, node) {
  const body = node.querySelector('.panel-body');
  const c = node.querySelector('.panel-count');
  if (c) c.textContent = panel.tabs.reduce((n, t) => n + t.cards.reduce((m, x) => m + x.items.length, 0), 0) || '';

  const bar = el('div', { class: 'board-tabs' });
  for (const t of panel.tabs) {
    const btn = el('button', {
      class: 'board-tab' + (t.id === panel.boardTab ? ' sel' : ''),
      text: t.title,
      dataset: { tabId: t.id },
      title: 'Double-click to rename · right-click for options',
      onclick: () => { if (!btn.isContentEditable) { panel.boardTab = t.id; save(); renderBody(panel, node); } }
    });
    btn.addEventListener('dblclick', e => { e.preventDefault(); renameTab(panel, btn, t); });
    btn.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); tabMenu(panel, node, t, e.clientX, e.clientY); });
    bar.appendChild(btn);
  }
  bar.appendChild(el('button', { class: 'board-tab add', text: '+', title: 'New tab', onclick: () => addTab(panel, node) }));

  body.appendChild(el('div', { class: 'board-bar' }, [
    bar,
    el('button', { class: 'board-add', text: '+ Add card', onclick: () => addCard(panel, node) })
  ]));

  const tab = activeTab(panel);
  const q = filterOf(panel);
  const grid = el('div', { class: 'board-grid' });
  const cards = tab ? tab.cards : [];
  let visible = 0;

  for (const card of cards) {
    const items = q ? card.items.filter(i => hits(i.title, q) || hits(i.url, q)) : card.items;
    if (q && !items.length && !hits(card.title, q)) continue;
    visible++;
    grid.appendChild(cardEl(panel, node, tab, card, items));
  }

  if (!cards.length) {
    grid.appendChild(el('div', {
      class: 'panel-empty clickable',
      text: 'No cards in this tab — click to add one, then drag bookmarks into it.',
      onclick: () => addCard(panel, node)
    }));
  } else if (!visible) {
    grid.appendChild(el('div', { class: 'panel-empty', text: 'Nothing matches that filter.' }));
  }

  body.appendChild(grid);
  addFilterRow(panel, node, body);
}

/* -------------------------------------------------------------- drop zones */

function wireDropZone(panel, node, body) {
  const clear = () => {
    node.classList.remove('drop-target');
    for (const n of body.querySelectorAll('.drop-before,.drop-after')) n.classList.remove('drop-before', 'drop-after');
  };

  node.addEventListener('dragover', e => {
    if (panel.type !== 'links') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MIME) ? 'move' : 'copy';
    node.classList.add('drop-target');
    const target = e.target.closest?.('.item');
    for (const n of body.querySelectorAll('.drop-before,.drop-after')) n.classList.remove('drop-before', 'drop-after');
    if (target) {
      const r = target.getBoundingClientRect();
      const after = (panel.layout === 'grid' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2);
      target.classList.add(after ? 'drop-after' : 'drop-before');
    }
  });
  node.addEventListener('dragleave', e => { if (!node.contains(e.relatedTarget)) clear(); });

  node.addEventListener('drop', e => {
    if (panel.type !== 'links') return;
    e.preventDefault();
    e.stopPropagation();

    const target = e.target.closest?.('.item');
    let index = panel.items.length;
    if (target) {
      const r = target.getBoundingClientRect();
      const after = (panel.layout === 'grid' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2);
      index = panel.items.findIndex(i => i.id === target.dataset.itemId) + (after ? 1 : 0);
    }
    clear();

    const raw = e.dataTransfer.getData(MIME);
    let dropped = [];

    if (raw) {
      const payload = JSON.parse(raw);
      if (payload.items) {
        dropped = payload.items.map(i => ({ id: uid(), title: i.title, url: i.url }));
      } else {
        const src = payload.from ? panelById(payload.from) : null;
        if (src && src.id === panel.id && !payload.groupId) {
          const cur = panel.items.findIndex(i => i.id === payload.itemId);
          if (cur < 0) return;
          const [moved] = panel.items.splice(cur, 1);
          panel.items.splice(cur < index ? index - 1 : index, 0, moved);
          save(); renderBody(panel, node);
          return;
        }
        dropped = extractDragged(payload);
        if (src) {
          const srcNode = canvas.querySelector(`.panel[data-id="${src.id}"]`);
          if (srcNode) renderBody(src, srcNode);
        }
      }
    } else {
      const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      for (const line of uri.split(/\r?\n/)) {
        const u = line.trim();
        if (/^https?:\/\//i.test(u)) dropped.push({ id: uid(), title: hostOf(u) || u, url: u });
      }
    }

    if (!dropped.length) return;
    panel.items.splice(index, 0, ...dropped);
    save();
    renderBody(panel, node);
  });
}

/* ------------------------------------------------------- move + resize */

function startDrag(e, panel, node) {
  if (state.settings.locked || isStacked()) return;        // locked, or stacked on a narrow window
  if (e.target.closest('.icon-btn') || e.target.isContentEditable) return;
  if (e.button !== 0) return;
  e.preventDefault();
  const grid = state.settings.gridSize || 1;
  const startX = e.clientX, startY = e.clientY;
  const ox = panel.x, oy = panel.y;
  node.classList.add('dragging');
  bringToFront(panel, node);
  node.setPointerCapture(e.pointerId);

  const move = ev => {
    const maxX = Math.max(0, canvas.clientWidth - panel.w - 12);
    panel.x = Math.min(maxX, Math.max(0, snap(ox + ev.clientX - startX, grid)));
    panel.y = Math.max(0, snap(oy + ev.clientY - startY, grid));
    node.style.left = panel.x + 'px';
    node.style.top = panel.y + 'px';
  };
  const up = () => {
    node.classList.remove('dragging');
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    save();
  };
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
}

function startResize(e, panel, node, dir) {
  if (state.settings.locked || isStacked()) return;
  e.preventDefault();
  e.stopPropagation();
  const grid = state.settings.gridSize || 1;
  const startX = e.clientX, startY = e.clientY;
  const ow = panel.w, oh = panel.h;
  node.classList.add('resizing');
  node.setPointerCapture(e.pointerId);

  const move = ev => {
    const maxW = Math.max(180, canvas.clientWidth - panel.x - 12);
    if (dir !== 's') panel.w = Math.min(maxW, Math.max(180, snap(ow + ev.clientX - startX, grid)));
    if (dir !== 'e') panel.h = Math.max(78, snap(oh + ev.clientY - startY, grid));
    node.style.width = panel.w + 'px';
    node.style.height = panel.h + 'px';
  };
  const up = () => {
    node.classList.remove('resizing');
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    save();
  };
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
}

/* ------------------------------------------------------------- title + menu */

function editTitle(panel, titleEl) {
  titleEl.contentEditable = 'true';
  titleEl.focus();
  document.execCommand?.('selectAll', false, null);
  const done = () => {
    titleEl.contentEditable = 'false';
    panel.title = titleEl.textContent.trim() || 'Untitled';
    titleEl.textContent = panel.title;
    save();
  };
  titleEl.addEventListener('blur', done, { once: true });
  titleEl.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); titleEl.blur(); }
    if (ev.key === 'Escape') { titleEl.textContent = panel.title; titleEl.blur(); }
  });
}

export function closeMenu() { ctxmenu.hidden = true; ctxmenu.textContent = ''; }

function openMenu(panel, node, x, y) {
  ctxmenu.textContent = '';
  const add = (label, fn) => ctxmenu.appendChild(el('button', { text: label, onclick: () => { closeMenu(); fn(); } }));

  if (!panel.hideHeader) add('Rename', () => editTitle(panel, node.querySelector('.panel-title')));
  add(panel.hideHeader ? 'Show header' : 'Hide header', () => {
    panel.hideHeader = !panel.hideHeader;
    save();
    node.replaceWith(renderPanel(panel));
  });

  if (panel.type === 'links') {
    add(panel.layout === 'grid' ? 'List layout' : 'Icon grid layout', () => {
      panel.layout = panel.layout === 'grid' ? 'list' : 'grid';
      node.dataset.layout = panel.layout;
      save(); renderBody(panel, node);
    });
    add('Open all in tabs', () => panel.items.forEach(i => window.open(i.url, '_blank')));
    add('Sort A → Z', () => {
      panel.items.sort((a, b) => a.title.localeCompare(b.title));
      save(); renderBody(panel, node);
    });
  } else if (panel.type === 'github') {
    add('Refresh now', () => refreshGithub(panel, node));
    for (const [key, label] of [['created', 'Created by me'], ['review', 'Review requested'], ['assigned', 'Assigned to me']]) {
      add(`${panel.gh[key] ? '✓ ' : '   '}${label}`, () => {
        panel.gh[key] = !panel.gh[key];
        save(); gh.invalidate(panel.id); renderBody(panel, node);
      });
    }
    add('Set custom query…', () => {
      const q = prompt('Extra GitHub search query (e.g. org:syfe review:required)', panel.gh.extraQuery || '');
      if (q === null) return;
      panel.gh.extraQuery = q;
      save(); gh.invalidate(panel.id); renderBody(panel, node);
    });

  } else if (panel.type === 'clock') {
    add(`${panel.clock.format24 ? '✓ ' : '   '}24-hour time`, () => {
      panel.clock.format24 = !panel.clock.format24;
      save(); renderBody(panel, node);
    });
    add(`${panel.clock.showSeconds ? '✓ ' : '   '}Show seconds`, () => {
      panel.clock.showSeconds = !panel.clock.showSeconds;
      save(); renderBody(panel, node);
    });
    add('Edit the line below…', () => {
      const m = prompt('Line shown under the clock (leave blank for none)', panel.clock.message || '');
      if (m === null) return;
      panel.clock.message = m;
      save(); renderBody(panel, node);
    });

  } else if (panel.type === 'weather') {
    add('Change location…', () => setWeatherLocation(panel, node));
    add(panel.weather.units === 'imperial' ? 'Use °C' : 'Use °F', () => {
      panel.weather.units = panel.weather.units === 'imperial' ? 'metric' : 'imperial';
      save(); wx.invalidate(panel.id); renderBody(panel, node);
    });
    add('Refresh now', () => { wx.invalidate(panel.id); renderBody(panel, node); });

  } else if (panel.type === 'quote') {
    add('Another quote', () => nextQuote(panel, node));
    add(`${panel.quote.daily ? '✓ ' : '   '}Quote of the day`, () => {
      panel.quote.daily = !panel.quote.daily;
      save(); renderBody(panel, node);
    });
    add('Copy quote', () => {
      const q = currentQuote(panel);
      navigator.clipboard?.writeText(`“${q.text}” — ${q.author}`);
    });

  } else if (panel.type === 'calendar') {
    const cfg = calConfig(panel);
    if (cfg.mode === 'oauth') {
      if (state.settings.gcalAccount) {
        ctxmenu.appendChild(el('div', { class: 'menu-label', text: state.settings.gcalAccount }));
      }
      add('Switch Google account…', async () => {
        await gcal.signOut({ forgetAccount: true });
        try {
          await gcal.getToken({ interactive: true });     // prompt=select_account
        } catch { /* the panel shows the error */ }
        renderBody(panel, node);
      });
      add('Choose calendar…', () => chooseCalendar(panel, node));
      add('Google account settings…', () => calendarSetup(panel, node));
      add('Sign out of Google', async () => { await gcal.signOut({ forgetAccount: true }); renderBody(panel, node); });
      add('Use an iCal URL instead', () => { cfg.mode = 'ics'; save(); renderBody(panel, node); });
    } else {
      add('Change calendar URL…', () => icsSetup(panel, node));
      add('Sign in with Google instead', () => { cfg.mode = 'oauth'; save(); renderBody(panel, node); });
    }
    add(`${panel.cal.hideDeclined ? '✓ ' : '   '}Hide declined`, () => {
      panel.cal.hideDeclined = !panel.cal.hideDeclined;
      save(); renderBody(panel, node);
    });
    add('Refresh now', () => { cal.invalidate(panel.id); renderBody(panel, node); });
    add(`${panel.cal.hideAllDay ? '✓ ' : '   '}Hide all-day events`, () => {
      panel.cal.hideAllDay = !panel.cal.hideAllDay;
      save(); renderBody(panel, node);
    });
    for (const h of [6, 12, 24]) {
      add(`${panel.cal.lookAheadHours === h ? '✓ ' : '   '}Look ahead ${h}h`, () => {
        panel.cal.lookAheadHours = h;
        save(); renderBody(panel, node);
      });
    }

  } else if (panel.type === 'todo') {
    add('Add a task', () => focusTodoInput(node));
    add('Clear completed', () => {
      panel.todos = panel.todos.filter(t => !t.done);
      save(); renderBody(panel, node);
    });
    add('Sort by priority', () => {
      const rank = { high: 0, medium: 1, low: 2 };
      panel.todos.sort((a, b) => (a.done - b.done) || (rank[a.priority] - rank[b.priority]));
      save(); renderBody(panel, node);
    });

  } else if (panel.type === 'board') {
    add('Add a card', () => addCard(panel, node));
    add('New tab', () => addTab(panel, node));
    add('Rename current tab', () => {
      const btn = node.querySelector('.board-tab.sel');
      const tab = activeTab(panel);
      if (btn && tab) renameTab(panel, btn, tab);
    });
    add('Collapse every card', () => {
      panel.tabs.forEach(t => t.cards.forEach(c => { c.expanded = false; }));
      save(); renderBody(panel, node);
    });
    ctxmenu.appendChild(el('div', { class: 'menu-label', text: 'Links per card' }));
    for (const n of [6, 12, 25, 9999]) {
      const current = panel.cardPreview ?? CARD_PREVIEW;
      add(`${current === n ? '✓ ' : '   '}${n === 9999 ? 'Show all' : n}`, () => {
        panel.cardPreview = n;
        save(); renderBody(panel, node);
      });
    }
  }

  ctxmenu.appendChild(el('hr'));
  const swatches = el('div', { class: 'swatches' });
  for (const c of COLORS) {
    swatches.appendChild(el('div', {
      class: 'swatch', style: `background:${c}`, title: c,
      onclick: () => {
        panel.color = c;
        node.style.setProperty('--pc', c);
        const dot = node.querySelector('.panel-dot');
        if (dot) dot.style.background = c;
        save(); closeMenu();
      }
    }));
  }
  ctxmenu.appendChild(swatches);

  const value = el('span', { class: 'menu-val', text: `${panel.opacity ?? 74}%` });
  const range = el('input', {
    type: 'range', min: '20', max: '100', step: '2',
    value: String(panel.opacity ?? 74), class: 'menu-range-input'
  });
  range.addEventListener('input', () => {
    panel.opacity = Number(range.value);
    node.style.setProperty('--pa', String(panel.opacity));
    value.textContent = `${panel.opacity}%`;
  });
  range.addEventListener('change', save);
  range.addEventListener('pointerdown', e => e.stopPropagation());
  ctxmenu.appendChild(el('div', { class: 'menu-range' }, [
    el('span', { class: 'menu-label', text: 'Opacity' }), range, value
  ]));

  ctxmenu.appendChild(el('hr'));

  add('Duplicate', () => {
    const copy = newPanel(panel.type, {
      ...structuredClone(panel), id: uid(), x: panel.x + 24, y: panel.y + 24,
      items: panel.items.map(i => ({ ...i, id: uid() }))
    });
    state.panels.push(copy);
    save();
    canvas.appendChild(renderPanel(copy));
  });
  if (state.settings.locked) {
    ctxmenu.appendChild(el('div', { class: 'menu-label', text: '🔒 Locked — unlock to delete' }));
  } else add('Delete panel', () => {
    if (!confirm(`Delete panel “${panel.title}”?`)) return;
    clearTimer(panel.id);
    state.panels = state.panels.filter(p => p.id !== panel.id);
    save();
    node.remove();
    applyStackOrder();
  });

  ctxmenu.hidden = false;
  const r = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  ctxmenu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}

document.addEventListener('pointerdown', e => {
  if (!ctxmenu.hidden && !ctxmenu.contains(e.target)) closeMenu();
});

/* ------------------------------------------------------------ public adds */

export function addPanel(type) {
  const spec = typeSpec(type);
  const p = newPanel(type, {
    x: snap(canvas.scrollLeft + 40, 8),
    y: snap(canvas.scrollTop + 40, 8),
    w: spec.w,
    h: spec.h
  });
  state.panels.push(p);
  save();
  const node = renderPanel(p);
  canvas.appendChild(node);
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (type === 'weather') setWeatherLocation(p, node);
  return p;
}

/** Opens the add-link form on the last panel you touched (the 'a' shortcut). */
export function addLinkToActivePanel() {
  const target = activePanel && state.panels.includes(activePanel.panel)
    ? activePanel
    : (() => {
        const p = state.panels.find(x => x.type === 'links');
        const n = p && canvas.querySelector(`.panel[data-id="${p.id}"]`);
        return n ? { panel: p, node: n } : null;
      })();
  if (!target || target.panel.type !== 'links') return;
  bringToFront(target.panel, target.node);
  showAddForm(target.panel, target.node);
}

/** Reflow every panel into the current canvas width, keeping reading order. */
export function fitToWindow() {
  const W = canvas.clientWidth;
  const PAD = 16, GAP = 14;
  const avail = Math.max(220, W - 2 * PAD);

  const ordered = [...state.panels].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  let x = PAD, y = PAD, rowH = 0;

  for (const p of ordered) {
    p.w = Math.min(p.w, avail);
    if (x > PAD && x + p.w > W - PAD) { x = PAD; y += rowH + GAP; rowH = 0; }
    p.x = x;
    p.y = y;
    x += p.w + GAP;
    rowH = Math.max(rowH, p.h);
  }
  save();
  renderAll();
}

/* ---------------------------------------------------- keep inside the width */

/** Pull one panel inside the canvas: never wider than the viewport, never
    positioned past the right edge. Returns true if anything changed. */
function clampToCanvas(panel, avail) {
  const before = `${panel.x}:${panel.w}`;
  panel.w = Math.max(180, Math.min(panel.w, avail - 24));
  panel.x = Math.max(0, Math.min(panel.x, avail - panel.w - 12));
  return before !== `${panel.x}:${panel.w}`;
}

/** Called on load and on every window resize: guarantees no horizontal scroll
    without reflowing the arrangement — panels that stick out are pulled in,
    everything else is left exactly where it was. */
export function fitWidth() {
  if (isStacked()) return false;
  const avail = canvas.clientWidth;
  if (!avail) return false;

  let changed = false;
  for (const panel of state.panels) {
    if (!clampToCanvas(panel, avail)) continue;
    changed = true;
    const node = canvas.querySelector(`.panel[data-id="${panel.id}"]`);
    if (node) {
      node.style.left = panel.x + 'px';
      node.style.width = panel.w + 'px';
    }
  }
  if (changed) save();
  return changed;
}
