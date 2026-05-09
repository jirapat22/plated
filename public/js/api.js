// Fetch wrapper — injects Authorization header and handles common errors
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

  const resp = await fetch(path, opts);

  if (resp.status === 401 || resp.status === 403) {
    _token = null;
    _onUnauthorized?.();
    throw new Error('Session expired');
  }

  let data;
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await resp.json();
  } else {
    data = await resp.text();
  }

  if (!resp.ok) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }

  return data;
}

export const api = {
  get:    (path)        => request('GET',    path),
  post:   (path, body)  => request('POST',   path, body),
  patch:  (path, body)  => request('PATCH',  path, body),
  delete: (path)        => request('DELETE', path),
};
