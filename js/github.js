import { state } from './store.js';

const API = 'https://api.github.com';
const cache = new Map();          // panelId -> { at, sections }
const TTL = 4 * 60 * 1000;

export function hasToken() {
  return Boolean(state.settings.ghToken && state.settings.ghUser);
}

async function gh(path) {
  const res = await fetch(API + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${state.settings.ghToken}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 140)}`);
  }
  return res.json();
}

export async function verifyToken(token) {
  const res = await fetch(API + '/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function searchPRs(query, limit) {
  const q = encodeURIComponent(`is:pr is:open ${query}`);
  return gh(`/search/issues?q=${q}&sort=updated&order=desc&per_page=${limit}`)
    .then(d => (d.items || []).map(normalize));
}

function normalize(item) {
  const m = /repos\/([^/]+\/[^/]+)\//.exec(item.repository_url + '/');
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    url: item.html_url,
    repo: m ? m[1] : '',
    author: item.user?.login || '',
    avatar: item.user?.avatar_url || '',
    draft: Boolean(item.draft),
    updated: item.updated_at
  };
}

/** Returns [{ label, prs }] for a github panel; cached for 4 minutes. */
export async function fetchPanel(panel, { force = false } = {}) {
  const hit = cache.get(panel.id);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.sections;

  const user = state.settings.ghUser;
  const limit = panel.gh?.limit || 8;
  const wanted = [];
  if (panel.gh?.created)  wanted.push(['Created by me',    `author:${user}`]);
  if (panel.gh?.review)   wanted.push(['Review requested', `review-requested:${user}`]);
  if (panel.gh?.assigned) wanted.push(['Assigned to me',   `assignee:${user}`]);
  if (panel.gh?.extraQuery?.trim()) wanted.push(['Custom', panel.gh.extraQuery.trim()]);

  const sections = await Promise.all(wanted.map(async ([label, q]) => ({
    label,
    prs: await searchPRs(q, limit)
  })));

  cache.set(panel.id, { at: Date.now(), sections });
  return sections;
}

export function invalidate(panelId) {
  if (panelId) cache.delete(panelId); else cache.clear();
}

/** Flat list of every PR currently cached — powers the command bar. */
export function cachedPRs() {
  const out = [];
  const seen = new Set();
  for (const { sections } of cache.values()) {
    for (const s of sections) {
      for (const pr of s.prs) {
        if (seen.has(pr.url)) continue;
        seen.add(pr.url);
        out.push(pr);
      }
    }
  }
  return out;
}
