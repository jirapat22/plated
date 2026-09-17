// Fetch wrapper — injects the profile session token and handles auth errors
import { reportApiError } from './utils/bugReport.js';
import { putRead, getRead } from './utils/offlineStore.js';

let _token = null;
let _onUnauthorized = null;
// Whose data this is. Set alongside the token, and used to key the offline
// cache — without it a second profile on the same phone would read the first
// one's cached day.
let _profileId = null;

export function setToken(t) { _token = t; }
export function getToken() { return _token; }
export function setProfileId(id) { _profileId = id ?? null; }
export function onUnauthorized(fn) { _onUnauthorized = fn; }

// GETs worth keeping a copy of: the ones that make the app readable at all.
// Deliberately a list rather than "everything" — search results and Open Food
// Facts lookups go stale meaninglessly, and caching them would bloat the store
// with one row per query anyone ever typed.
const CACHEABLE = [
  /^\/api\/meals\/day\//,
  /^\/api\/meals\/summary/,
  /^\/api\/settings$/,
  /^\/api\/weight(\?|$)/,
  // …and the single-day read, which the pattern above does NOT match. Today
  // calls getCached on it, so offline it always fell to the `null` fallback and
  // the bodyweight card rendered "Not weighed today" for a day that WAS
  // weighed — with the value sitting in the cached /api/weight?limit=10 list
  // right beside it. It also reported stale:false, so it never contributed to
  // the "showing what was saved" banner either.
  /^\/api\/weight\/day\//,
  /^\/api\/batches$/,
  /^\/api\/leftovers$/,
  /^\/api\/foods\/recent$/,
  /^\/api\/foods\/favourites$/,
];
const isCacheable = path => CACHEABLE.some(re => re.test(path));

// One shape for "this device has no connection", however we found out. Carries
// .offline so callers can tell it apart from a real failure without string
// matching, and a message that's safe to put straight into a toast.
function offlineError(method) {
  const msg = method === 'GET'
    ? "You're offline — can't load this right now."
    : "You're offline — that didn't save. Try again once you're back on.";
  return Object.assign(new Error(msg), { status: 503, offline: true });
}

// 502/503/504 come from the proxy in front of the app, not from the app: the
// container is restarting, or briefly unreachable. From the client these are
// indistinguishable from a deploy, and a deploy is the usual cause — three of
// these landed in Orbit as "bugs" 48 seconds after a push, from a browser that
// happened to have the app open. Not faults, and not worth paging over.
// A 500 still is: that's the app itself throwing.
const UNREACHABLE = new Set([502, 503, 504]);
function unreachableError(status) {
  return Object.assign(
    new Error('The server is restarting — try again in a moment.'),
    { status, unreachable: true },
  );
}

// The last-seen copy of a GET, thrown as an error carrying the data. Callers
// that want to survive offline catch it and render `err.cached`; everything
// else sees the same offline error it always did, so nothing breaks by default.
async function cachedOr(method, path, fallbackErr) {
  if (method !== 'GET' || !isCacheable(path)) throw fallbackErr;
  const hit = await getRead(_profileId, path);
  if (!hit) throw fallbackErr;
  return Object.assign(fallbackErr, { cached: hit.data, cachedAt: hit.at });
}

// Whether the last attempt found the server unreachable. The write queue needs
// to know the moment that stops being true: it flushes on the browser's
// 'online' event and on the app coming back to the foreground, and neither of
// those fires when the SERVER was the thing that went away. A meal logged
// during a thirty-second redeploy then sat on the device, unsent, while the app
// looked entirely normal — the offline banner had already cleared.
//
// An event rather than a direct call, so this module keeps knowing nothing
// about the queue (writeQueue imports api, not the other way round). It fires
// only on the transition back, so it is rare by construction.
let wasUnreachable = false;
function markReachable() {
  if (!wasUnreachable) return;
  wasUnreachable = false;
  try { window.dispatchEvent(new Event('plated:reachable')); } catch { /* no window in tests */ }
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;

  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (netErr) {
    // Network unreachable. When the browser already knows it's offline this is
    // the expected outcome, not a fault — say so plainly and don't page Orbit.
    // (With the service worker installed this branch rarely runs: it answers
    // failed /api/ fetches itself, handled below.)
    wasUnreachable = true;
    if (!navigator.onLine) throw await cachedOr(method, path, offlineError(method));
    if (method !== 'GET') reportApiError({ method, path, status: 0, message: netErr.message });
    throw netErr;
  }

  // 401 = session expired/invalid → bounce to lock screen
  if (resp.status === 401) {
    _token = null;
    _onUnauthorized?.();
    throw new Error('Session expired');
  }

  let data;
  const ct = resp.headers.get('content-type') || '';
  data = ct.includes('application/json') ? await resp.json() : await resp.text();

  if (!resp.ok) {
    // The service worker answers any /api/ request it couldn't put on the wire
    // with a synthetic 503 {offline:true}. That's this device having no signal,
    // not a server fault: it was filing itself as a 5xx bug in Orbit, and
    // surfacing to the user as a toast reading just "offline".
    if (data?.offline) { wasUnreachable = true; throw await cachedOr(method, path, offlineError(method)); }
    // A restarting or unreachable server is not a bug in the app — see above.
    // Thrown with .unreachable so the global rejection handler skips it too,
    // the same way .offline is skipped; otherwise the same blip reports twice,
    // once from here and once as a bare "HTTP 502" from the uncaught rejection.
    // Same fallback the offline branch above gets. A 502 during a deploy is the
    // moment Today is most worth showing from the cache — the device has a
    // perfectly good copy and nothing was wrong with it. Without this the read
    // cache sat populated and unused, and a 30-second redeploy blanked the
    // screen it was built to protect. cachedOr re-throws for writes and for
    // paths outside the allowlist, so only cacheable GETs change behaviour.
    if (UNREACHABLE.has(resp.status)) {
      wasUnreachable = true;
      throw await cachedOr(method, path, unreachableError(resp.status));
    }
    // Server faults the app itself raised are real bugs — capture those.
    if (resp.status >= 500) reportApiError({ method, path, status: resp.status, message: data?.error || '' });
    const err = new Error(data?.error || `HTTP ${resp.status}`);
    // Most callers only read err.message, but some errors carry structured
    // recovery data (e.g. "this already exists" responses that include the
    // existing record) — attach the status and full body so those callers
    // can react instead of just failing.
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  // The server answered. If the last attempt didn't, say so once — the write
  // queue is listening, and this is the only signal it gets when the outage was
  // the server's rather than the phone's.
  markReachable();

  // Keep a copy of anything worth reading offline. Fire-and-forget: a storage
  // failure must never turn a successful request into a failed one.
  if (method === 'GET' && isCacheable(path)) putRead(_profileId, path, data);

  return data;
}

export const api = {
  get:    (path)        => request('GET',    path),
  post:   (path, body)  => request('POST',   path, body),
  patch:  (path, body)  => request('PATCH',  path, body),
  delete: (path)        => request('DELETE', path),

  // A GET that degrades instead of failing: `{ data, stale, at }`, where stale
  // means this came off the device rather than the wire and `at` is when it was
  // last seen. `fallback` covers the calls a view treats as optional anyway.
  //
  // Separate from api.get on purpose. A view has to opt in, because rendering a
  // stale number without saying so is worse than an error message — and the
  // caller is the only one that knows whether it has anywhere to say it.
  async getCached(path, fallback) {
    try {
      return { data: await request('GET', path), stale: false, at: null };
    } catch (err) {
      if (err.cached !== undefined) return { data: err.cached, stale: true, at: err.cachedAt };
      if (fallback !== undefined && (err.offline || err.unreachable)) {
        return { data: fallback, stale: false, at: null };
      }
      throw err;
    }
  },
};
