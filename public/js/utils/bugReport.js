// Bug / idea reporting — manual submissions and automatic crash capture.
// Posts to /api/bug-report (public, works pre-login). Best-effort: never throws.

const DEDUPE_MS = 5 * 60 * 1000;
const DEDUPE_KEY = 'bugDedupe';

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

// Low-level post (raw fetch so it works pre-login and never triggers auth redirect)
async function postReport(body) {
  try {
    const token = getToken();
    await fetch('/api/bug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch { /* offline / best-effort */ }
}

// Public: submit a manual report. Returns nothing meaningful (fire-and-forget-ish).
export async function submitReport({ type = 'bug_report', message, context = {} }) {
  const msg = (message || '').trim();
  if (!msg) return;
  await postReport({ source: 'manual', type, message: msg, stack: null, context: baseContext(context) });
}

function autoReport(message, stack) {
  const msg = (message || 'Unknown error').toString();
  if (!shouldSend(`${msg}@${location.pathname}`)) return;
  postReport({ source: 'frontend', type: 'bug_report', message: msg, stack: stack || null, context: baseContext() });
}

// Install global handlers for uncaught errors + unhandled promise rejections.
export function installErrorCapture() {
  window.addEventListener('error', e => {
    const message = e.message || e.error?.message || 'Uncaught error';
    autoReport(message, e.error?.stack || null);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    const message = r?.message || (typeof r === 'string' ? r : 'Unhandled promise rejection');
    autoReport(message, r?.stack || null);
  });
}
