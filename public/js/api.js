// Fetch wrapper — handles common errors
async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const resp = await fetch(path, opts);

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
