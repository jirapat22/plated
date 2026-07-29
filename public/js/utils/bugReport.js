// Bug / idea reporting — manual submissions and automatic crash capture.
// Posts to /api/bug-report (public, works pre-login). Best-effort: never throws
// for auto-capture. Manual submissions are queued offline and retried.

const DEDUPE_MS = 5 * 60 * 1000;
const DEDUPE_KEY = 'bugDedupe';
const OUTBOX_KEY = 'bugOutbox';

let appVersion = 'unknown';
(async () => {
  try {
    const keys = await caches.keys();
    const k = keys.find(k => k.startsWith('plated-'));
    if (k) appVersion = k;
  } catch { /* caches unavailable */ }
})();

function baseContext(extra = {}) {
  return {
    url: location.href,
    screen: location.hash || location.pathname || '/',
    version: appVersion,
    userAgent: navigator.userAgent,
    ...extra,
  };
}

// 5-minute sessionStorage dedupe so an error loop can't spam the backend.
function shouldSend(key) {
  try {
    const now = Date.now();
    const map = JSON.parse(sessionStorage.getItem(DEDUPE_KEY) || '{}');
    for (const k of Object.keys(map)) if (now - map[k] > DEDUPE_MS) delete map[k];
    if (map[key] && now - map[key] < DEDUPE_MS) return false;
    map[key] = now;
    sessionStorage.setItem(DEDUPE_KEY, JSON.stringify(map));
    return true;
  } catch { return true; }
}

function getToken() {
  try { return localStorage.getItem('plated_token'); } catch { return null; }
}

// Low-level post (raw fetch so it works pre-login and never triggers auth
// redirect). Returns true if the backend received it (any HTTP response),
// false only if the network was unreachable (offline) so callers can requeue.
async function postReport(body) {
  try {
    const token = getToken();
    await fetch('/api/bug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return true;
  } catch {
    return false;   // network failure — caller may queue for retry
  }
}

// ── Offline outbox (manual reports only) ──────────────────────
function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function writeOutbox(q) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q.slice(-50))); } catch { /* full / private */ }
}
function enqueue(body) { const q = readOutbox(); q.push(body); writeOutbox(q); }

// Retry queued manual reports; keep any that still fail.
export async function flushOutbox() {
  const q = readOutbox();
  if (!q.length) return;
  const remaining = [];
  for (const body of q) {
    const ok = await postReport(body);
    if (!ok) remaining.push(body);
  }
  writeOutbox(remaining);
}

// Public: submit a manual report. Throws if it had to be queued offline, so the
// UI can tell the user it'll send later.
export async function submitReport({ type = 'bug_report', message, context = {} }) {
  const msg = (message || '').trim();
  if (!msg) return;
  const body = { source: 'manual', type, message: msg, stack: null, context: baseContext(context) };
  const ok = await postReport(body);
  if (!ok) { enqueue(body); throw new Error('Queued — will send when back online'); }
}

// Per-page-load cap so a pathological loop can't flood Orbit. Manual sends and
// the outbox bypass this (they go straight through postReport).
let autoSent = 0;
const AUTO_CAP = 25;
function autoPost(body) {
  if (autoSent >= AUTO_CAP) return;
  autoSent++;
  postReport(body);
}

function autoReport(message, stack, ctx = {}) {
  const msg = (message || 'Unknown error').toString();
  if (!shouldSend(`${msg}@${location.pathname}`)) return;
  autoPost({ source: 'frontend', type: 'bug_report', message: msg, stack: stack || null, context: baseContext(ctx) });
}

// Report a handled API failure (server 5xx or network error the app caught).
// Skips the reporter's own endpoint to avoid loops; deduped by status+path.
export function reportApiError({ method = 'GET', path = '', status = 0, message = '' }) {
  if (String(path).includes('/api/bug-report')) return;
  if (!shouldSend(`api:${status}:${path}`)) return;
  const label = `API ${status || 'network error'} on ${method} ${path}${message ? ` — ${message}` : ''}`;
  autoPost({ source: 'frontend', type: 'bug_report', message: label, stack: null,
    context: baseContext({ kind: 'api_error', method, path, status }) });
}

// Report an error you CAUGHT but that shouldn't normally happen. Use inside a
// catch block instead of silently swallowing:  catch (e) { reportHandled(e, {where:'foo'}); }
// Don't use for expected control-flow (optional fetches, private-mode storage…).
export function reportHandled(err, ctx = {}) {
  const message = err?.message || (typeof err === 'string' ? err : 'Handled error');
  if (!shouldSend(`handled:${message}@${ctx.where || location.pathname}`)) return;
  autoPost({ source: 'frontend', type: 'bug_report', message, stack: err?.stack || null,
    context: baseContext({ ...ctx, kind: 'handled' }) });
}

// Runtime invariant: report (but don't throw) when something that must always
// be true isn't — the only way to surface "impossible state" logic bugs.
export function assert(condition, message, ctx = {}) {
  if (condition) return true;
  if (shouldSend(`invariant:${message}`)) {
    autoPost({ source: 'frontend', type: 'bug_report', message: `Invariant failed: ${message}`,
      stack: new Error().stack || null, context: baseContext({ ...ctx, kind: 'invariant' }) });
  }
  return false;
}

// Wrap console.error so logged-but-swallowed errors are also reported.
function interceptConsole() {
  const orig = console.error.bind(console);
  console.error = (...args) => {
    orig(...args);
    try {
      const msg = args.map(a =>
        a instanceof Error ? (a.stack || a.message)
        : typeof a === 'string' ? a
        : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
      ).join(' ').slice(0, 1000);
      if (!msg || msg.includes('/api/bug-report')) return;   // avoid self-loops
      if (!shouldSend(`console:${msg.slice(0, 160)}`)) return;
      const stack = args.find(a => a instanceof Error)?.stack || null;
      autoPost({ source: 'frontend', type: 'bug_report', message: msg, stack,
        context: baseContext({ kind: 'console' }) });
    } catch { /* never break console */ }
  };
}

// Install global handlers for uncaught errors + unhandled promise rejections,
// plus outbox flushing.
export function installErrorCapture() {
  window.addEventListener('error', e => {
    // Cross-origin scripts without CORS surface as an opaque "Script error."
    // with no detail — useless to report. (CDN tags now set crossorigin to
    // unmask real errors; anything still opaque is dropped as noise.)
    if (!e.error && !e.filename && /^script error\.?$/i.test(e.message || '')) return;
    const message = e.message || e.error?.message || 'Uncaught error';
    const where = e.filename ? { where: `${e.filename}:${e.lineno}:${e.colno}` } : {};
    autoReport(message, e.error?.stack || null, where);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    // Having no connection isn't a bug (see offlineError in api.js) — it was
    // filing itself as a 5xx in Orbit from any write attempted offline.
    if (r?.offline) return;
    const message = r?.message || (typeof r === 'string' ? r : 'Unhandled promise rejection');
    autoReport(message, r?.stack || null);
  });
  interceptConsole();
  // Flush any offline-queued manual reports now and whenever we reconnect.
  window.addEventListener('online', flushOutbox);
  flushOutbox();
}
