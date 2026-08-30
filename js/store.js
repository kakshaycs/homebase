import { quoteOfTheDay } from './quotes.js';

export const PANEL_TYPES = [
  { type: 'links',   label: 'Bookmarks', icon: '🔖', title: 'New panel',  w: 320, h: 280 },
  { type: 'github',  label: 'GitHub PRs', icon: '🐙', title: 'GitHub PRs', w: 560, h: 320 },
  { type: 'clock',   label: 'Clock',     icon: '🕘', title: 'Clock',      w: 400, h: 190 },
  { type: 'weather', label: 'Weather',   icon: '⛅', title: 'Weather',    w: 380, h: 240 },
  { type: 'quote',   label: 'Quote',     icon: '❝',  title: 'Quote',      w: 320, h: 250 },
  { type: 'todo',    label: 'To-do list', icon: '✓',  title: "Today's Tasks", w: 320, h: 520 },
  { type: 'board',   label: 'Board (holds cards)', icon: '▦', title: 'Board', w: 760, h: 440 },
  { type: 'calendar', label: 'Next meeting', icon: '📅', title: 'Next meeting', w: 370, h: 240 }
];

export function typeSpec(type) {
  return PANEL_TYPES.find(t => t.type === type) || PANEL_TYPES[0];
}

export const WALLPAPERS = [
  { id: '',                     label: 'None',        thumb: '' },
  { id: 'builtin:sunset-lake',  label: 'Sunset Lake', thumb: 'img/sunset-lake.jpg' }
];

/** Turn a stored wallpaper value into something CSS can load. */
export function wallpaperSrc(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (v.startsWith('builtin:')) return chrome.runtime.getURL(`img/${v.slice(8)}.jpg`);
  if (/^(https?:|data:image\/)/i.test(v)) return v;
  return '';
}

export const THEMES = [
  { id: 'auto',     label: 'Auto',     swatch: 'linear-gradient(135deg,#eaeef5 0 50%,#121419 50%)' },
  { id: 'mist',     label: 'Mist',     swatch: 'linear-gradient(135deg,#f3f6fb,#c3cffb 60%,#a9d8f0)' },
  { id: 'paper',    label: 'Paper',    swatch: 'linear-gradient(135deg,#faf5ec,#e8c99b 70%,#cfa87c)' },
  { id: 'slate',    label: 'Slate',    swatch: 'linear-gradient(135deg,#2a3038,#3f4d61 70%,#5b7ea8)' },
  { id: 'midnight', label: 'Midnight', swatch: 'linear-gradient(135deg,#12162c,#4a3fb0 65%,#8b7cff)' },
  { id: 'espresso', label: 'Espresso', swatch: 'linear-gradient(135deg,#231a14,#7a4a24 65%,#e0a458)' }
];

export const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#64748b'];

const DEFAULTS = {
  version: 2,
  panels: [],
  settings: {
    theme: 'auto',
    userName: '',
    wallpaper: '',
    wallpaperDim: 55,
    gridSize: 8,
    libraryHidden: false,
    locked: false,
    ghToken: '',
    ghUser: '',
    gcalClientId: ''
  }
};

export const state = structuredClone(DEFAULTS);

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ dashboard: state });
  }, 150);
}

export async function load() {
  const { dashboard } = await chrome.storage.local.get('dashboard');
  if (dashboard && Array.isArray(dashboard.panels)) {
    Object.assign(state, DEFAULTS, dashboard);
    state.settings = { ...DEFAULTS.settings, ...(dashboard.settings || {}) };
  }
  return state;
}

export function panelById(id) {
  return state.panels.find(p => p.id === id);
}

export function newPanel(type, patch = {}) {
  const spec = typeSpec(type);
  const base = {
    id: uid(),
    type,
    title: spec.title,
    color: COLORS[state.panels.length % COLORS.length],
    layout: 'list',
    x: 24, y: 24, w: spec.w, h: spec.h,
    items: [],
    gh: { assigned: true, review: true, created: true, extraQuery: '', limit: 8 },
    clock: { format24: false, showSeconds: false, message: 'Focus on progress, not perfection.' },
    weather: { place: '', label: '', lat: null, lon: null, units: 'metric' },
    quote: { index: quoteOfTheDay(), daily: true },
    cal: { mode: 'oauth', icsUrl: '', calendarId: 'primary', lookAheadHours: 12, max: 3, hideAllDay: true, hideDeclined: true },
    todos: [],
    tabs: [],
    boardTab: '',
    hideHeader: false,
    opacity: 74,        // panel translucency, 20–100 — lower lets the wallpaper through
    showAllTab: false
  };
  return Object.assign(base, patch);
}

/** Lay panels out in a simple flowing grid — used for first-run seeding. */
export function autoPlace(panels, canvasWidth, { w = 320, h = 300, gap = 18, pad = 18, top = pad } = {}) {
  const cols = Math.max(1, Math.floor((canvasWidth - pad) / (w + gap)));
  panels.forEach((p, i) => {
    p.w = w;
    p.h = h;
    p.x = pad + (i % cols) * (w + gap);
    p.y = top + Math.floor(i / cols) * (h + gap);
  });
  return panels;
}

export async function seedFromBookmarks(canvasWidth) {
  const tree = await chrome.bookmarks.getTree();
  const folders = [];

  const walk = (node, trail) => {
    const links = (node.children || [])
      .filter(c => c.url && /^https?:/i.test(c.url))
      .map(c => ({ id: uid(), title: c.title || c.url, url: c.url }));
    if (links.length) {
      folders.push({ title: node.title || trail.at(-1) || 'Bookmarks', links: links.slice(0, 14) });
    }
    for (const c of node.children || []) {
      if (!c.url) walk(c, [...trail, node.title].filter(Boolean));
    }
  };
  for (const root of tree[0].children || []) walk(root, []);

  const ICONS = ['💼', '📚', '🛠️', '🎧', '🧪', '📈', '🗂️', '⭐'];

  /* Layout mirrors the reference design: tall task column on the left, clock +
     weather across the top middle, a board of cards below them, and a headerless
     quote in the right column. */
  const PAD = 18, GAP = 16;
  const W = Math.max(canvasWidth || 1280, 980);
  const LEFT_W = 300, RIGHT_W = 330, ROW_H = 200, BOARD_H = 430;

  const midX = PAD + LEFT_W + GAP;
  const rightX = Math.max(midX + 400, W - PAD - RIGHT_W);
  const midW = Math.max(400, rightX - GAP - midX);
  const clockW = Math.round(midW * 0.54);

  const todo = newPanel('todo', {
    color: COLORS[0], x: PAD, y: PAD, w: LEFT_W, h: ROW_H + GAP + BOARD_H
  });
  const clock = newPanel('clock', {
    color: COLORS[4], x: midX, y: PAD, w: clockW, h: ROW_H
  });
  const weather = newPanel('weather', {
    color: COLORS[5], x: midX + clockW + GAP, y: PAD, w: midW - clockW - GAP, h: ROW_H
  });
  const quote = newPanel('quote', {
    color: COLORS[4], x: rightX, y: PAD, w: RIGHT_W, h: 290, hideHeader: true
  });
  const firstTab = {
    id: uid(),
    title: 'Bookmarks',
    cards: folders.slice(0, 6).map((f, i) => ({
      id: uid(),
      title: f.title,
      icon: ICONS[i % ICONS.length],
      color: COLORS[i % COLORS.length],
      items: f.links,
      expanded: false
    }))
  };
  const board = newPanel('board', {
    title: 'Bookmarks',
    color: COLORS[1],
    x: midX, y: PAD + ROW_H + GAP, w: midW, h: BOARD_H,
    tabs: [firstTab],
    boardTab: firstTab.id
  });
  const gh = newPanel('github', {
    title: 'GitHub PRs',
    color: '#64748b',
    x: midX, y: PAD + ROW_H + GAP + BOARD_H + GAP, w: midW, h: 340
  });

  state.panels = [todo, clock, weather, quote, board, gh];
  save();
}
