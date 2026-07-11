// Fetch wrapper — injects the profile session token and handles auth errors
import { reportApiError } from './utils/bugReport.js';

let _token = null;
let _onUnauthorized = null;

export function setToken(t) { _token = t; }
export function getToken() { return _token; }
export function onUnauthorized(fn) { _onUnauthorized = fn; }

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;

  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (netErr) {
    // Network unreachable (offline, DNS, etc.) — report unless it's GET (noisy
    // and usually just offline). Report writes so lost submissions are visible.
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
