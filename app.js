'use strict';

// ---- Minimal read-only scope ----
// Google has no per-calendar OAuth scope, so any read scope covers ALL calendars
// regardless of the fact that we only query /calendars/primary/events.
// calendar.events.readonly is the narrowest scope that lets us read events +
// their reminders; it does NOT grant calendar settings, ACLs, or calendar list.
const SCOPES = 'https://www.googleapis.com/auth/calendar.events.readonly';

const LS_CLIENT_ID = 'auditcal.clientId';
// Hardcoded default OAuth Client ID (public by design). Used to pre-populate the
// field on a fresh load; a saved/edited value in localStorage overrides it.
const DEFAULT_CLIENT_ID =
  '273641572214-1tq5baha8ib06aac65nsdvfva1vmgnkj.apps.googleusercontent.com';
const LS_BLESSED = 'auditcal.blessed';
const LS_SHOW_BLESSED = 'auditcal.showBlessed';

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const el = {
  clientId: $('clientId'),
  saveClientId: $('saveClientId'),
  connect: $('connect'),
  disconnect: $('disconnect'),
  refresh: $('refresh'),
  status: $('status'),
  results: $('results'),
  summary: $('summary'),
  list: $('list'),
  showBlessed: $('showBlessed'),
};

let tokenClient = null;
let accessToken = null;
let lastData = null; // most recently loaded {rows,start,end}, for re-render on toggle

// ---- Status helpers ----
function setStatus(msg, isError) {
  el.status.textContent = msg || '';
  el.status.classList.toggle('error', !!isError);
}

// ---- Blessed storage ----
// A "blessed" entry is keyed by event name + notification signature, so that an
// event is considered blessed only when BOTH its name and its exact set of
// notifications match a previously blessed combination.
function loadBlessed() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_BLESSED) || '[]')); }
  catch { return new Set(); }
}
function saveBlessed(set) {
  localStorage.setItem(LS_BLESSED, JSON.stringify([...set]));
}
let blessed = loadBlessed();

function blessKey(name, notifSig) {
  return JSON.stringify([name || '', notifSig]);
}

// ---- Date range: Monday of this week .. Sunday of next week (local time) ----
function weekRange(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // JS: 0=Sun..6=Sat. Convert so Monday=0.
  const dow = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow);
  const end = new Date(monday);
  end.setDate(monday.getDate() + 14); // exclusive: start of the Monday after next week
  return { start: monday, end };
}

// ---- Reminder / notification formatting ----
function fmtMinutes(m) {
  if (m == null) return '?';
  if (m === 0) return 'at time';
  if (m % 1440 === 0) return (m / 1440) + 'd';
  if (m % 60 === 0) return (m / 60) + 'h';
  return m + 'm';
}
function methodLabel(method) {
  return ({ popup: 'popup', email: 'email', sms: 'sms' })[method] || method;
}

// Returns { list: [{method, minutes}], sig: string } resolving useDefault.
function resolveReminders(ev, calDefaultReminders) {
  let arr;
  const r = ev.reminders;
  if (!r) {
    arr = [];
  } else if (r.useDefault) {
    arr = calDefaultReminders || [];
  } else {
    arr = r.overrides || [];
  }
  const list = arr.map((x) => ({ method: x.method, minutes: x.minutes }))
    .sort((a, b) => (a.method + a.minutes).localeCompare(b.method + b.minutes));
  const sig = list.length
    ? list.map((x) => x.method + ':' + x.minutes).join(',')
    : 'none';
  return { list, sig };
}

// ---- Google API fetch helper ----
async function gapi(url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (res.status === 401) throw new Error('auth-expired');
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error('API ' + res.status + (detail ? ': ' + detail : ''));
  }
  return res.json();
}

async function gapiPaged(baseUrl, itemsKey, extra) {
  // Returns { items: [...], meta: <first page json> }
  let items = [];
  let pageToken = '';
  let firstPage = null;
  do {
    const u = new URL(baseUrl);
    for (const [k, v] of Object.entries(extra || {})) u.searchParams.set(k, v);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const json = await gapi(u.toString());
    if (!firstPage) firstPage = json;
    items = items.concat(json[itemsKey] || []);
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return { items, meta: firstPage };
}

// ---- Data loading ----
async function loadAll() {
  const { start, end } = weekRange();
  const timeMin = start.toISOString();
  const timeMax = end.toISOString();

  setStatus('Loading events…');
  const rows = [];

  // Only the user's primary calendar.
  const page = await gapiPaged(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    'items',
    { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });

  const calName = page.meta.summary || 'Primary';
  const calDefaults = page.meta.defaultReminders || [];
  for (const ev of page.items) {
    if (ev.status === 'cancelled') continue;
    const startInfo = parseEventTime(ev.start);
    if (!startInfo) continue;
    const { list, sig } = resolveReminders(ev, calDefaults);
    rows.push({
      name: ev.summary || '(no title)',
      start: startInfo.date,
      allDay: startInfo.allDay,
      notifs: list,
      notifSig: sig,
      link: ev.htmlLink || null,
      calName,
    });
  }

  rows.sort((a, b) => a.start - b.start);
  return { rows, start, end };
}

function parseEventTime(s) {
  if (!s) return null;
  if (s.dateTime) return { date: new Date(s.dateTime), allDay: false };
  if (s.date) {
    // All-day: 'YYYY-MM-DD' -> local midnight
    const [y, m, d] = s.date.split('-').map(Number);
    return { date: new Date(y, m - 1, d), allDay: true };
  }
  return null;
}

// ---- Rendering ----
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function render(data) {
  const { rows, start, end } = data;
  el.results.hidden = false;
  el.list.innerHTML = '';

  const blessedCount = rows.filter((r) => blessed.has(blessKey(r.name, r.notifSig))).length;
  const unblessedCount = rows.length - blessedCount;
  const showBlessed = el.showBlessed.checked;
  el.summary.textContent =
    rows.length + ' event(s) from ' + DAY_FMT.format(start) + ' through ' +
    DAY_FMT.format(new Date(end - 1)) + ' — ' + blessedCount + ' blessed, ' +
    unblessedCount + ' unblessed' +
    (showBlessed ? '.' : ' (blessed hidden).');

  if (!rows.length) {
    el.list.innerHTML = '<div class="empty">No events in range.</div>';
    return;
  }

  const visible = showBlessed
    ? rows
    : rows.filter((r) => !blessed.has(blessKey(r.name, r.notifSig)));

  if (!visible.length) {
    el.list.innerHTML = '<div class="empty">All events blessed — nothing to review. ' +
      'Enable “Show blessed events” to see them.</div>';
    return;
  }

  const today = new Date();
  let lastDayKey = null;
  for (const r of visible) {
    const dayKey = r.start.toDateString();
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      const sep = document.createElement('div');
      sep.className = 'day-sep' + (sameDay(r.start, today) ? ' today' : '');
      sep.textContent = DAY_FMT.format(r.start) + (sameDay(r.start, today) ? ' — today' : '');
      el.list.appendChild(sep);
    }
    el.list.appendChild(renderRow(r, data));
  }
}

function renderRow(r, data) {
  const key = blessKey(r.name, r.notifSig);
  const isBlessed = blessed.has(key);

  const row = document.createElement('div');
  row.className = 'event' + (isBlessed ? ' blessed' : '');

  const main = document.createElement('div');
  main.className = 'main';
  main.title = r.link ? 'Open in Google Calendar' : '';

  const time = document.createElement('div');
  time.className = 'time';
  const timeStr = r.allDay ? 'all day' : TIME_FMT.format(r.start);
  time.innerHTML = '<span>' + timeStr + '</span>';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = r.name;
  name.title = r.name;

  const notifs = document.createElement('div');
  notifs.className = 'notifs';
  if (!r.notifs.length) {
    notifs.innerHTML = '<span class="notif none">no notifications</span>';
  } else {
    notifs.innerHTML = r.notifs
      .map((n) => '<span class="notif">' + methodLabel(n.method) + ' ' + fmtMinutes(n.minutes) + '</span>')
      .join('');
  }

  main.appendChild(time);
  main.appendChild(name);
  main.appendChild(notifs);
  if (r.link) main.addEventListener('click', () => window.open(r.link, '_blank', 'noopener'));

  const actions = document.createElement('div');
  actions.className = 'actions';
  const btn = document.createElement('button');
  btn.className = 'bless-btn ' + (isBlessed ? 'do-unbless' : 'do-bless');
  btn.textContent = isBlessed ? '✕' : '✓';
  btn.title = isBlessed ? 'Unbless this name+notification combo' : 'Bless this name+notification combo';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (blessed.has(key)) blessed.delete(key); else blessed.add(key);
    saveBlessed(blessed);
    render(data); // re-render to update all matching rows
  });
  actions.appendChild(btn);

  row.appendChild(main);
  row.appendChild(actions);
  return row;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- OAuth flow (Google Identity Services) ----
function ensureTokenClient() {
  const clientId = localStorage.getItem(LS_CLIENT_ID) || el.clientId.value.trim() || DEFAULT_CLIENT_ID;
  if (!clientId) { setStatus('Enter and save a Client ID first.', true); return null; }
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    setStatus('Google Identity script not loaded yet — try again in a moment.', true);
    return null;
  }
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: onToken,
    });
  }
  return tokenClient;
}

function onToken(resp) {
  if (resp.error) {
    setStatus('OAuth error: ' + resp.error, true);
    return;
  }
  accessToken = resp.access_token;
  el.connect.hidden = true;
  el.disconnect.hidden = false;
  el.refresh.hidden = false;
  setStatus('Connected. Loading…');
  loadAndRender();
}

async function loadAndRender() {
  try {
    const data = await loadAll();
    lastData = data;
    render(data);
    setStatus('Loaded ' + data.rows.length + ' event(s).');
  } catch (e) {
    if (e.message === 'auth-expired') {
      setStatus('Session expired — click Connect again.', true);
      accessToken = null;
      el.connect.hidden = false;
      el.disconnect.hidden = true;
      el.refresh.hidden = true;
    } else {
      setStatus('Error: ' + e.message, true);
      console.error(e);
    }
  }
}

function connect() {
  const tc = ensureTokenClient();
  if (!tc) return;
  tc.requestAccessToken({ prompt: ''}); // Empty prompt bypasses consent if already granted.
}

function disconnect() {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  el.connect.hidden = false;
  el.disconnect.hidden = true;
  el.refresh.hidden = true;
  el.results.hidden = true;
  setStatus('Disconnected.');
}

// ---- Wire up ----
function init() {
  const savedId = localStorage.getItem(LS_CLIENT_ID);
  el.clientId.value = savedId || DEFAULT_CLIENT_ID;

  el.saveClientId.addEventListener('click', () => {
    const v = el.clientId.value.trim();
    if (!v) { setStatus('Client ID is empty.', true); return; }
    localStorage.setItem(LS_CLIENT_ID, v);
    tokenClient = null; // force re-init with new id
    setStatus('Client ID saved.');
  });

  el.showBlessed.checked = localStorage.getItem(LS_SHOW_BLESSED) === '1';
  el.showBlessed.addEventListener('change', () => {
    localStorage.setItem(LS_SHOW_BLESSED, el.showBlessed.checked ? '1' : '0');
    if (lastData) render(lastData);
  });

  el.connect.addEventListener('click', connect);
  el.disconnect.addEventListener('click', disconnect);
  el.refresh.addEventListener('click', loadAndRender);
}

init();
