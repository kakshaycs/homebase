import { state, load, save, seedFromBookmarks, THEMES, PANEL_TYPES, WALLPAPERS, wallpaperSrc, storageBytes } from './store.js';
import { renderAll, addPanel, refreshAllGithub, closeMenu, addLinkToActivePanel, fitWidth } from './panels.js';
import { loadLibrary } from './library.js';
import { openCmd, closeCmd } from './search.js';
import * as gh from './github.js';
import { redirectUri } from './gcal.js';
import { el } from './util.js';

const canvas = document.getElementById('canvas');
const settings = document.getElementById('settings');
const ghToken = document.getElementById('ghToken');
const ghUser = document.getElementById('ghUser');
const gridSize = document.getElementById('gridSize');
const ghStatus = document.getElementById('ghStatus');
const ioBox = document.getElementById('ioBox');

/* ---------------------------------------------------------------- topbar */

const ctxmenu = document.getElementById('ctxmenu');

document.getElementById('addBtn').addEventListener('click', e => {
  e.stopPropagation();
  ctxmenu.textContent = '';
  ctxmenu.appendChild(el('div', { class: 'menu-label', text: 'Add a panel' }));
  for (const t of PANEL_TYPES) {
    ctxmenu.appendChild(el('button', {
      text: `${t.icon}  ${t.label}`,
      onclick: () => { closeMenu(); addPanel(t.type); }
    }));
  }
  ctxmenu.appendChild(el('hr'));
  ctxmenu.appendChild(el('button', {
    text: '🖼  Wallpaper…',
    onclick: () => { closeMenu(); openSettings('wallpaperPicker'); }
  }));
  ctxmenu.appendChild(el('button', {
    text: '⚙  Settings…',
    onclick: () => { closeMenu(); openSettings(); }
  }));
  ctxmenu.hidden = false;
  const btn = e.currentTarget.getBoundingClientRect();
  const menu = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = Math.max(8, btn.right - menu.width) + 'px';
  ctxmenu.style.top = (btn.bottom + 6) + 'px';
});
document.getElementById('omni').addEventListener('click', () => openCmd());
document.getElementById('omni').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCmd(); }
});

const lockBtn = document.getElementById('lockBtn');

function paintLock() {
  const on = Boolean(state.settings.locked);
  document.body.classList.toggle('locked', on);
  lockBtn.textContent = on ? '🔒' : '🔓';
  lockBtn.classList.toggle('on', on);
  lockBtn.title = on
    ? 'Layout locked — panels cannot be moved, resized or deleted (click to unlock)'
    : 'Lock the layout so panels cannot be moved, resized or deleted';
}

lockBtn.addEventListener('click', () => {
  state.settings.locked = !state.settings.locked;
  save();
  paintLock();
});

function setLibrary(hidden) {
  document.body.classList.toggle('lib-hidden', hidden);
  state.settings.libraryHidden = hidden;
  save();
}
document.getElementById('libToggle').addEventListener('click', () => setLibrary(!state.settings.libraryHidden));
document.getElementById('libClose').addEventListener('click', () => setLibrary(true));

/* ------------------------------------------------------- greeting + wallpaper */

function partOfDay(h) {
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Good night';
}

function paintGreeting() {
  const box = document.getElementById('greeting');
  const name = (state.settings.userName || '').trim();
  const hello = partOfDay(new Date().getHours());
  box.textContent = name ? `${hello}, ${name} ` : `${hello} `;
  box.appendChild(el('span', { class: 'wave', text: '👋' }));
}

function applyWallpaper() {
  const src = wallpaperSrc(state.settings.wallpaper);
  const dim = Math.min(0.9, Math.max(0, (state.settings.wallpaperDim ?? 55) / 100));
  const root = document.documentElement;
  if (src) {
    root.style.setProperty('--wallpaper', `url("${src.replace(/["\\]/g, '')}")`);
    root.style.setProperty('--wallpaper-dim', String(dim));
    document.body.classList.add('has-wallpaper');
  } else {
    root.style.removeProperty('--wallpaper');
    document.body.classList.remove('has-wallpaper');
  }
}

function setWallpaper(value) {
  state.settings.wallpaper = value;
  save();
  applyWallpaper();
  buildWallpaperPicker();
  const field = document.getElementById('wallpaper');
  field.value = /^(https?:)/i.test(value) ? value : '';
}

function buildWallpaperPicker() {
  const box = document.getElementById('wallpaperPicker');
  const current = state.settings.wallpaper || '';
  box.textContent = '';

  const options = [...WALLPAPERS];
  if (current.startsWith('data:image/')) {
    options.push({ id: current, label: 'Uploaded', thumb: current });
  }

  for (const w of options) {
    const chip = el('button', {
      class: 'wall-chip' + (w.id === current ? ' sel' : ''),
      type: 'button',
      title: w.label,
      onclick: () => setWallpaper(w.id)
    }, [
      el('span', {
        class: 'wall-thumb' + (w.thumb ? '' : ' none'),
        style: w.thumb ? `background-image:url("${w.thumb.startsWith('data:') ? w.thumb : chrome.runtime.getURL(w.thumb)}")` : ''
      }),
      el('span', { text: w.label })
    ]);
    box.appendChild(chip);
  }
}

/** Downscale a picked file and stash it as a data URL (storage has a hard quota). */
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image Chrome can read'));
      img.onload = () => {
        const MAX = 2560;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ----------------------------------------------------------------- theme */

// if anything below throws, still show the page
setTimeout(() => document.body.classList.add('ready'), 800);

function applyTheme(id) {
  if (!id || id === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
}

function buildThemePicker() {
  const box = document.getElementById('themePicker');
  box.textContent = '';
  for (const t of THEMES) {
    const chip = el('button', {
      class: 'theme-chip' + (t.id === (state.settings.theme || 'auto') ? ' sel' : ''),
      type: 'button',
      dataset: { theme: t.id },
      onclick: () => {
        state.settings.theme = t.id;
        save();
        applyTheme(t.id);
        for (const c of box.children) c.classList.toggle('sel', c.dataset.theme === t.id);
      }
    }, [
      el('span', { class: 'theme-swatch', style: `background:${t.swatch}` }),
      el('span', { text: t.label })
    ]);
    box.appendChild(chip);
  }
}

/* -------------------------------------------------------------- settings */

function openSettings(scrollToId) {
  // Show the sheet first: a failure populating any one field must never leave
  // the button looking dead.
  settings.hidden = false;

  const set = (id, value) => {
    try { document.getElementById(id).value = value; } catch (err) { console.warn('settings field', id, err); }
  };
  set('userName', state.settings.userName || '');
  set('wallpaper', state.settings.wallpaper || '');
  set('wallpaperDim', state.settings.wallpaperDim ?? 55);
  set('gcalClientId', state.settings.gcalClientId || '');
  set('gcalRedirect', redirectUri());
  set('ghToken', state.settings.ghToken || '');
  set('ghUser', state.settings.ghUser || '');
  set('gridSize', state.settings.gridSize || 8);

  try {
    ghStatus.textContent = '';
    buildThemePicker();
    buildWallpaperPicker();
    document.getElementById('wallNote').textContent = '';
  } catch (err) {
    console.warn('settings pickers', err);
  }
  if (scrollToId) {
    const target = document.getElementById(scrollToId);
    target?.scrollIntoView({ block: 'center' });
  } else {
    ghUser.focus();
  }
}

document.getElementById('settingsBtn').addEventListener('click', () => openSettings());

function applySettings() {
  state.settings.userName = document.getElementById('userName').value.trim();
  state.settings.wallpaperDim = Number(document.getElementById('wallpaperDim').value);
  state.settings.gcalClientId = document.getElementById('gcalClientId').value.trim();
  state.settings.ghToken = ghToken.value.trim();
  state.settings.ghUser = ghUser.value.trim();
  state.settings.gridSize = Math.max(1, Number(gridSize.value) || 8);
  save();
}

document.getElementById('settingsClose').addEventListener('click', async () => {
  const tokenChanged = ghToken.value.trim() !== (state.settings.ghToken || '');
  applySettings();
  paintGreeting();
  applyWallpaper();
  settings.hidden = true;
  if (tokenChanged && state.settings.ghToken) {
    try {
      const me = await gh.verifyToken(state.settings.ghToken);
      if (!state.settings.ghUser) { state.settings.ghUser = me.login; ghUser.value = me.login; save(); }
    } catch { /* surfaced inside the panel */ }
  }
  gh.invalidate();
  refreshAllGithub();
});

document.getElementById('wallpaper').addEventListener('input', e => {
  const v = e.target.value.trim();
  if (!v || /^https?:\/\//i.test(v)) {
    state.settings.wallpaper = v;
    applyWallpaper();
    buildWallpaperPicker();
  }
});

document.getElementById('wallpaperDim').addEventListener('input', e => {
  state.settings.wallpaperDim = Number(e.target.value);
  applyWallpaper();
});

document.getElementById('wallUpload').addEventListener('click', () => document.getElementById('wallFile').click());

document.getElementById('wallFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  const note = document.getElementById('wallNote');
  if (!file) return;
  note.textContent = 'Processing image…';
  try {
    const dataUrl = await readImageFile(file);
    const mb = (dataUrl.length / 1048576).toFixed(1);
    if (dataUrl.length > 6 * 1048576) {
      note.textContent = `That image is ${mb} MB after compression — too big to store. Try a smaller one.`;
      return;
    }
    setWallpaper(dataUrl);
    note.textContent = `Using your uploaded image (${mb} MB).`;
  } catch (err) {
    note.textContent = String(err.message || err);
  } finally {
    e.target.value = '';
  }
});

settings.addEventListener('pointerdown', e => { if (e.target === settings) document.getElementById('settingsClose').click(); });

document.getElementById('gcalRedirect').addEventListener('focus', e => e.target.select());
document.getElementById('gcalCopy').addEventListener('click', e => {
  navigator.clipboard?.writeText(redirectUri());
  e.target.textContent = 'Copied';
  setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
});

function toast(message, kind = 'info') {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.className = 'toast ' + kind;
  box.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.hidden = true; }, 6000);
}
window.addEventListener('homebase:error', e => toast(e.detail, 'error'));

/** Layout minus anything secret or too big to move as text. */
function exportPayload() {
  const settings = { ...state.settings, ghToken: '' };
  let droppedWallpaper = false;
  if ((settings.wallpaper || '').startsWith('data:')) {
    settings.wallpaper = '';                 // a multi-MB base64 image cannot travel in JSON
    droppedWallpaper = true;
  }
  return {
    payload: {
      ...state,
      settings,
      panels: state.panels.map(p => (p.cal?.icsUrl ? { ...p, cal: { ...p.cal, icsUrl: '' } } : p))
    },
    droppedWallpaper
  };
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const { payload, droppedWallpaper } = exportPayload();
  const json = JSON.stringify(payload, null, 2);
  ioBox.value = json;

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `homebase-layout-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  const kb = Math.round(json.length / 1024);
  ghStatus.textContent = `Exported ${payload.panels.length} panels (${kb} KB)`
    + (droppedWallpaper ? ' — uploaded wallpaper not included, re-pick it on the other machine.' : '')
    + ' GitHub token and iCal URL are never exported.';
});

document.getElementById('importFileBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    applyImport(await file.text());
  } catch (err) {
    ghStatus.textContent = 'Import failed: ' + (err.message || err);
  } finally {
    e.target.value = '';
  }
});

/** Import, then VERIFY it actually persisted — the old version reported success
    whether or not the storage write went through. */
function applyImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    ghStatus.textContent = 'Import failed: that is not valid JSON (was the whole file copied?)';
    return;
  }
  if (!data || !Array.isArray(data.panels)) {
    ghStatus.textContent = 'Import failed: no "panels" array in that file.';
    return;
  }
  if (!data.panels.length) {
    ghStatus.textContent = 'Import failed: that layout has zero panels.';
    return;
  }

  const keptToken = state.settings.ghToken;
  state.panels = data.panels;
  if (data.settings) Object.assign(state.settings, data.settings, { ghToken: keptToken });

  const bytes = storageBytes();
  if (bytes > 9 * 1024 * 1024) {
    ghStatus.textContent = `Import too large (${Math.round(bytes / 1048576)} MB) — Chrome's limit is 10 MB.`;
    return;
  }

  chrome.storage.local.set({ dashboard: state }, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      ghStatus.textContent = `Import failed to save: ${err.message}`;
      return;
    }
    chrome.storage.local.get('dashboard', got => {
      const n = got?.dashboard?.panels?.length ?? 0;
      applyTheme(state.settings.theme);
      applyWallpaper();
      paintGreeting();
      paintLock();
      renderAll();
      ghStatus.textContent = n === data.panels.length
        ? `Imported and saved ${n} panels. Re-enter your GitHub token and calendar URL.`
        : `Imported ${data.panels.length} but only ${n} were stored — check the console.`;
    });
  });
}

document.getElementById('importBtn').addEventListener('click', () => applyImport(ioBox.value));

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('Reset the dashboard and rebuild panels from your bookmark folders?')) return;
  await seedFromBookmarks(canvas.clientWidth);
  renderAll();
  settings.hidden = true;
});

/* -------------------------------------------------------------- keyboard */

document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.getElementById('overlay').hidden ? openCmd() : closeCmd();
    return;
  }
  if (e.key === 'Escape') {
    closeMenu();
    if (!settings.hidden) document.getElementById('settingsClose').click();
    return;
  }
  if (typing) return;

  if (e.key === '/') { e.preventDefault(); openCmd(); }
  if (e.key === 'a') { e.preventDefault(); addLinkToActivePanel(); }
  if (e.key === 'n') addPanel('links');
  if (e.key === 'b') setLibrary(!state.settings.libraryHidden);
  if (e.key === 'l') { state.settings.locked = !state.settings.locked; save(); paintLock(); }
  if (e.key === 'r') refreshAllGithub();
});

/* dropping a link onto empty canvas creates a panel for it */
canvas.addEventListener('dragover', e => {
  if (e.target !== canvas) return;
  e.preventDefault();
  canvas.classList.add('dropping');
});
canvas.addEventListener('dragleave', () => canvas.classList.remove('dropping'));
canvas.addEventListener('drop', e => {
  if (e.target !== canvas) return;
  e.preventDefault();
  canvas.classList.remove('dropping');
  const p = addPanel('links');
  p.x = Math.max(0, e.offsetX - 40);
  p.y = Math.max(0, e.offsetY - 20);
  save();
  renderAll();
});

/* ------------------------------------------------------------------ boot */

(async () => {
  await load();
  applyTheme(state.settings.theme);
  applyWallpaper();
  paintGreeting();
  paintLock();
  document.body.classList.toggle('lib-hidden', Boolean(state.settings.libraryHidden));
  document.body.classList.add('ready');
  setInterval(paintGreeting, 60 * 1000);   // rolls over morning → afternoon → evening
  await loadLibrary();
  if (!state.panels.length) await seedFromBookmarks(canvas.clientWidth || 1200);
  renderAll();
  fitWidth();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitWidth, 180);
  });

  setInterval(refreshAllGithub, 5 * 60 * 1000);
})();
