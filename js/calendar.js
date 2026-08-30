/* Google Calendar via its private iCal (.ics) address — no OAuth, no Cloud
   project. Parses VEVENTs, expands simple recurrences inside the look-ahead
   window, and returns occurrences sorted by start time. */

const cache = new Map();      // panelId -> { at, events }
const TTL = 5 * 60 * 1000;

/* ------------------------------------------------------------ ICS parsing */

/** RFC 5545 line unfolding: a CRLF followed by a space or tab continues the line. */
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return String(v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** "DTSTART;TZID=Asia/Kolkata:20260830T093000" -> {name, params, value} */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/** Offset (ms) between a named zone and UTC at a given instant. */
function zoneOffset(utcMs, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    for (const part of dtf.formatToParts(new Date(utcMs))) {
      if (part.type !== 'literal') p[part.type] = part.value;
    }
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return asUTC - utcMs;
  } catch {
    return 0;
  }
}

/** Wall-clock fields in a named zone -> epoch ms (two passes handles DST edges). */
function zonedToMs(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = guess - zoneOffset(guess, tz);
  ms = guess - zoneOffset(ms, tz);
  return ms;
}

/** Parse a DATE or DATE-TIME value; returns { ms, allDay }. */
export function parseDate(value, params = {}) {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number);
    return { ms: new Date(y, m - 1, d).getTime(), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  if (params.TZID) return { ms: zonedToMs(+y, +mo, +d, +h, +mi, +s, params.TZID), allDay: false };
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };   // floating
}

export function parseICS(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;

    const p = parseLine(line);
    if (!p) continue;

    switch (p.name) {
      case 'UID':         cur.uid = p.value; break;
      case 'SUMMARY':     cur.summary = unescapeText(p.value); break;
      case 'LOCATION':    cur.location = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'STATUS':      cur.status = p.value.toUpperCase(); break;
      case 'RRULE':       cur.rrule = p.value; break;
      case 'DTSTART':     cur.start = parseDate(p.value, p.params); break;
      case 'DTEND':       cur.end = parseDate(p.value, p.params); break;
      case 'RECURRENCE-ID': {
        const d = parseDate(p.value, p.params);
        if (d) cur.recurrenceId = d.ms;
        break;
      }
      case 'EXDATE':
        for (const one of p.value.split(',')) {
          const d = parseDate(one, p.params);
          if (d) cur.exdates.push(d.ms);
        }
        break;
    }
  }
  return events.filter(e => e.start);
}

/* -------------------------------------------------------- recurrence ---- */

const DAY = 86400000;
const BYDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(rrule) {
  const out = {};
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

/** Occurrences of one VEVENT that overlap [from, to]. Handles DAILY/WEEKLY/
    MONTHLY/YEARLY with INTERVAL, BYDAY, COUNT and UNTIL — enough for the
    meetings people actually run. */
function expandOne(ev, from, to) {
  const duration = ev.end ? Math.max(0, ev.end.ms - ev.start.ms) : (ev.start.allDay ? DAY : 30 * 60000);
  const base = { summary: ev.summary || '(no title)', location: ev.location, description: ev.description, allDay: ev.start.allDay, uid: ev.uid };
  const out = [];

  if (!ev.rrule) {
    if (ev.start.ms + duration >= from && ev.start.ms <= to) {
      out.push({ ...base, start: ev.start.ms, end: ev.start.ms + duration });
    }
    return out;
  }

  const r = parseRRule(ev.rrule);
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10));
  const until = r.UNTIL ? (parseDate(r.UNTIL, {})?.ms ?? Infinity) : Infinity;
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const byday = r.BYDAY ? r.BYDAY.split(',').map(d => BYDAY_INDEX[d.slice(-2).toUpperCase()]).filter(n => n !== undefined) : null;
  const exclude = new Set(ev.exdates);

  const startDate = new Date(ev.start.ms);
  let emitted = 0;
  const cap = 2000;   // hard stop, whatever the rule says

  for (let i = 0; i < cap && emitted < count; i++) {
    let occ;
    switch ((r.FREQ || '').toUpperCase()) {
      case 'DAILY':
        occ = ev.start.ms + i * interval * DAY;
        break;
      case 'WEEKLY': {
        const weekStart = ev.start.ms + i * interval * 7 * DAY;
        if (byday && byday.length) {
          const anchor = new Date(weekStart);
          const dow = anchor.getDay();
          for (const target of byday) {
            const shifted = weekStart + (target - dow) * DAY;
            if (shifted < ev.start.ms || shifted > until) continue;
            if (exclude.has(shifted)) continue;
            if (shifted + duration >= from && shifted <= to) out.push({ ...base, start: shifted, end: shifted + duration });
            emitted++;
          }
          occ = null;
        } else {
          occ = weekStart;
        }
        break;
      }
      case 'MONTHLY': {
        const d = new Date(startDate);
        d.setMonth(d.getMonth() + i * interval);
        occ = d.getTime();
        break;
      }
      case 'YEARLY': {
        const d = new Date(startDate);
        d.setFullYear(d.getFullYear() + i * interval);
        occ = d.getTime();
        break;
      }
      default:
        return out;
    }

    if (occ === null) { if (ev.start.ms + i * interval * 7 * DAY > to) break; continue; }
    if (occ > until) break;
    if (occ > to && occ > from) break;
    emitted++;
    if (exclude.has(occ)) continue;
    if (occ + duration >= from && occ <= to) out.push({ ...base, start: occ, end: occ + duration });
  }
  return out;
}

export function expand(events, from, to) {
  /* A VEVENT carrying RECURRENCE-ID replaces that one occurrence of its series. */
  const overrides = new Map();
  for (const ev of events) {
    if (ev.recurrenceId) overrides.set(`${ev.uid}@${ev.recurrenceId}`, ev);
  }

  const out = [];
  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    if (ev.recurrenceId) {
      const d = ev.end ? ev.end.ms - ev.start.ms : 30 * 60000;
      if (ev.start.ms + d >= from && ev.start.ms <= to) {
        out.push({ summary: ev.summary || '(no title)', location: ev.location, description: ev.description, allDay: ev.start.allDay, uid: ev.uid, start: ev.start.ms, end: ev.start.ms + d });
      }
      continue;
    }
    for (const occ of expandOne(ev, from, to)) {
      if (overrides.has(`${occ.uid}@${occ.start}`)) continue;   // superseded
      out.push(occ);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ----------------------------------------------------------------- fetch */

const MEET = /(https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|[\w.-]*webex\.com)\/[^\s>"']+)/i;

export function meetingLink(ev) {
  const hit = MEET.exec(`${ev.location || ''}\n${ev.description || ''}`);
  return hit ? hit[1].replace(/[).,]+$/, '') : '';
}

export async function fetchCalendar(panel, { force = false } = {}) {
  const url = (panel.cal?.icsUrl || '').trim();
  if (!url) throw new Error('No calendar URL set');

  const hit = cache.get(panel.id);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.events;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Calendar failed (HTTP ${res.status})`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That URL did not return an iCal feed');

  const events = parseICS(text);
  cache.set(panel.id, { at: Date.now(), events });
  return events;
}

export function invalidate(panelId) {
  if (panelId) cache.delete(panelId); else cache.clear();
}

/** "in 10 min" · "started 10 min ago" · "in 2h 15m" · "now". */
export function relative(ms) {
  const mins = Math.round(ms / 60000);
  const abs = Math.abs(mins);
  if (abs < 1) return 'now';
  const label = abs < 60
    ? `${abs} min`
    : abs < 60 * 24
      ? `${Math.floor(abs / 60)}h ${abs % 60 ? `${abs % 60}m` : ''}`.trim()
      : `${Math.round(abs / (60 * 24))}d`;
  return mins > 0 ? `in ${label}` : `${label} ago`;
}
