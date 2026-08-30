/* Google Calendar API via chrome.identity.launchWebAuthFlow.

   Uses the implicit flow (response_type=token) so no client secret is needed and
   the client ID can live in settings rather than the manifest. Tokens last ~1h;
   we cache them and renew silently (prompt=none) while the browser still has a
   Google session, falling back to an interactive prompt. */

import { state, save } from './store.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';

let token = null;          // { access_token, expires }

/** Surfaced in the panel so a failed sign-in says what actually went wrong. */
export const diagnostics = { lastStep: '', lastError: '' };

/** What Chrome derives from the extension ID — always a valid interception target. */
export function derivedRedirectUri() {
  try {
    if (chrome.identity?.getRedirectURL) return chrome.identity.getRedirectURL();
  } catch { /* chrome.identity is undefined until the extension is reloaded */ }
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
}

/** The URI actually sent to Google — a user override wins if one is set. */
export function redirectUri() {
  const override = (state.settings.gcalRedirect || '').trim();
  return override || derivedRedirectUri();
}

/** Chrome only intercepts redirects on its own chromiumapp.org origin, so an
    override pointing anywhere else can never complete the flow. Reported, not
    blocked — the value is the user's call. */
export function redirectLooksWrong() {
  const override = (state.settings.gcalRedirect || '').trim();
  if (!override) return '';
  try {
    if (new URL(override).origin !== new URL(derivedRedirectUri()).origin) {
      return 'Chrome only intercepts redirects on ' + new URL(derivedRedirectUri()).origin
           + ' — sign-in will hang on any other host.';
    }
  } catch {
    return 'That is not a valid URL.';
  }
  return '';
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

  if (!interactive) {
    u.searchParams.set('prompt', 'none');
    // renew silently against the account we already connected, not the default one
    const known = (state.settings.gcalAccount || '').trim();
    if (known) u.searchParams.set('login_hint', known);
  } else {
    // Force the chooser, and deliberately send NO login_hint: a hint makes
    // Google honour that account and skip the chooser entirely, which is
    // exactly wrong when the remembered account is the one you want to change.
    u.searchParams.set('prompt', 'select_account');
  }
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
/* chrome.identity allows exactly one web auth flow at a time. Everything that
   might launch one goes through this chain, so a silent renewal and a user's
   "Sign in" can never collide — the second simply queues behind the first. */
let flowChain = Promise.resolve();

function friendly(message) {
  if (/one web auth flow/i.test(message)) {
    return 'A Google sign-in window is already open — finish or close it, then try again.';
  }
  return message;
}

async function launchFlow(interactive) {
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
    let msg = friendly(String(err?.message || runtime || err));
    if (/did not approve|cancel/i.test(msg)) {
      // Chrome reports a Google-side error page the same way as a real
      // cancellation, and by far the most common cause is an unregistered
      // redirect URI.
      msg += ` — if you saw a Google error page rather than the account chooser, add `
           + `${redirectUri()} to "Authorised redirect URIs" on your OAuth client.`;
    }
    diagnostics.lastError = msg;
    throw new Error(msg);
  }
}

/** Get a usable token. interactive=false never opens a window.
    force=true means "the user asked to sign in": skip the cached token (which
    may belong to the wrong account) and always show the chooser. */
export async function getToken({ interactive = false, force = false } = {}) {
  if (!isConfigured()) throw new Error('No Google client ID configured');
  if (!identityReady()) throw new Error('Reload the extension at chrome://extensions to enable Google sign-in');

  const run = flowChain.catch(() => {}).then(async () => {
    if (!force) {
      const cached = await loadCached();
      if (cached && cached.expires > Date.now()) return cached.access_token;
    } else {
      // Forget the remembered address too, so the account that actually answers
      // is re-read afterwards instead of the stale one lingering as a hint.
      await signOut({ forgetAccount: true });
    }
    return launchFlow(interactive);
  });

  flowChain = run.catch(() => {});     // keep the chain alive after a failure
  return run;
}

export async function signOut({ forgetAccount = false, revoke = false } = {}) {
  const dying = token?.access_token || (await loadCached())?.access_token;
  token = null;
  await chrome.storage.local.remove('gcalToken');

  if (revoke && dying) {
    // Drop the grant at Google's end too, so the next flow is a clean choice.
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(dying)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch { /* best effort */ }
  }
  if (forgetAccount) {
    state.settings.gcalAccount = '';
    save();
  }
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

/** The email of the account the current token belongs to (primary calendar id). */
export async function accountEmail(opts) {
  const data = await api('/calendars/primary', opts);
  return data.id || '';
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
