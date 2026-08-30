/* Google Calendar API via chrome.identity.launchWebAuthFlow.

   Uses the implicit flow (response_type=token) so no client secret is needed and
   the client ID can live in settings rather than the manifest. Tokens last ~1h;
   we cache them and renew silently (prompt=none) while the browser still has a
   Google session, falling back to an interactive prompt. */

import { state, save } from './store.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';

let token = null;          // { access_token, expires }
let inflight = null;

/** Surfaced in the panel so a failed sign-in says what actually went wrong. */
export const diagnostics = { lastStep: '', lastError: '' };

export function redirectUri() {
  // chrome.identity is undefined until the extension is reloaded with the
  // "identity" permission — fall back to the documented URL shape.
  try {
    if (chrome.identity?.getRedirectURL) return chrome.identity.getRedirectURL();
  } catch { /* fall through */ }
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
}

/** Whether the identity API is actually available in this context. */
export function identityReady() {
  return Boolean(chrome.identity?.launchWebAuthFlow);
}

export function clientId() {
  return (state.settings.gcalClientId || '').trim();
}

export function isConfigured() {
  return Boolean(clientId());
}

function authUrl(interactive) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('response_type', 'token');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('include_granted_scopes', 'true');
  if (!interactive) u.searchParams.set('prompt', 'none');
  return u.toString();
}

function parseFragment(url) {
  const hash = new URL(url).hash.replace(/^#/, '');
  const p = new URLSearchParams(hash);
  if (p.get('error')) throw new Error(p.get('error'));
  const access = p.get('access_token');
  if (!access) throw new Error('No access token returned');
  return {
    access_token: access,
    expires: Date.now() + (Number(p.get('expires_in') || 3600) - 60) * 1000
  };
}

async function loadCached() {
  if (token) return token;
  const { gcalToken } = await chrome.storage.local.get('gcalToken');
  if (gcalToken?.expires > Date.now()) token = gcalToken;
  return token;
}

/** Get a usable token. interactive=false never opens a window. */
export async function getToken({ interactive = false } = {}) {
  if (!isConfigured()) throw new Error('No Google client ID configured');
  if (!identityReady()) throw new Error('Reload the extension at chrome://extensions to enable Google sign-in');

  const cached = await loadCached();
  if (cached && cached.expires > Date.now()) return cached.access_token;

  if (inflight) return inflight;
  inflight = (async () => {
    diagnostics.lastStep = interactive ? 'interactive sign-in' : 'silent token renewal';
    try {
      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl(interactive),
        interactive
      });
      if (!responseUrl) throw new Error('Sign-in window closed before finishing');
      token = parseFragment(responseUrl);
      await chrome.storage.local.set({ gcalToken: token });
      diagnostics.lastError = '';
      return token.access_token;
    } catch (err) {
      const runtime = chrome.runtime.lastError?.message;
      diagnostics.lastError = String(err?.message || runtime || err);
      throw new Error(diagnostics.lastError);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function signOut() {
  token = null;
  await chrome.storage.local.remove('gcalToken');
}

export async function isSignedIn() {
  return Boolean(await loadCached());
}

async function api(path, { interactive = false } = {}) {
  let access = await getToken({ interactive });
  let res = await fetch(API + path, { cache: 'no-store', headers: { Authorization: `Bearer ${access}` } });

  if (res.status === 401) {                 // expired or revoked — one silent retry
    await signOut();
    access = await getToken({ interactive });
    res = await fetch(API + path, { cache: 'no-store', headers: { Authorization: `Bearer ${access}` } });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    diagnostics.lastStep = `GET ${path.split('?')[0]}`;
    diagnostics.lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
    throw new Error(diagnostics.lastError);
  }
  return res.json();
}

export async function listCalendars(opts) {
  const data = await api('/users/me/calendarList?minAccessRole=reader&maxResults=100', opts);
  return (data.items || []).map(c => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    primary: Boolean(c.primary),
    selected: c.selected !== false
  }));
}

function conferenceLink(item) {
  if (item.hangoutLink) return item.hangoutLink;
  for (const ep of item.conferenceData?.entryPoints || []) {
    if (ep.entryPointType === 'video' && ep.uri) return ep.uri;
  }
  return '';
}

/** Occurrences between two Dates, already expanded by the API (singleEvents). */
export async function fetchEvents(calendarId, timeMin, timeMax, opts) {
  const q = new URLSearchParams({
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '25'
  });
  const data = await api(`/calendars/${encodeURIComponent(calendarId || 'primary')}/events?${q}`, opts);

  return (data.items || [])
    .filter(i => i.status !== 'cancelled')
    .map(i => {
      const allDay = Boolean(i.start?.date);
      const start = allDay ? new Date(i.start.date + 'T00:00:00').getTime() : Date.parse(i.start.dateTime);
      const end = allDay
        ? new Date(i.end.date + 'T00:00:00').getTime()
        : Date.parse(i.end?.dateTime || i.start.dateTime);
      return {
        summary: i.summary || '(no title)',
        location: i.location || '',
        description: i.description || '',
        link: conferenceLink(i),
        htmlLink: i.htmlLink || '',
        allDay,
        start,
        end: end || start + 30 * 60000,
        declined: (i.attendees || []).some(a => a.self && a.responseStatus === 'declined')
      };
    })
    .filter(e => Number.isFinite(e.start))
    .sort((a, b) => a.start - b.start);
}
