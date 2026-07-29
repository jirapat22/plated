// Fetch wrapper — injects the profile session token and handles auth errors
import { reportApiError } from './utils/bugReport.js';

let _token = null;
let _onUnauthorized = null;

export function setToken(t) { _token = t; }
export function getToken() { return _token; }
export function onUnauthorized(fn) { _onUnauthorized = fn; }

// One shape for "this device has no connection", however we found out. Carries
// .offline so callers can tell it apart from a real failure without string
// matching, and a message that's safe to put straight into a toast.
function offlineError(method) {
  const msg = method === 'GET'
    ? "You're offline — can't load this right now."
    : "You're offline — that didn't save. Try again once you're back on.";
  return Object.assign(new Error(msg), { status: 503, offline: true });
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
    if (!navigator.onLine) throw offlineError(method);
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
    if (data?.offline) throw offlineError(method);
    // Server faults (5xx) are real bugs — capture them; 4xx are expected.
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

  return data;
}

export const api = {
  get:    (path)        => request('GET',    path),
  post:   (path, body)  => request('POST',   path, body),
  patch:  (path, body)  => request('PATCH',  path, body),
  delete: (path)        => request('DELETE', path),
};
