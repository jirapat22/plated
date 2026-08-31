import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { api, setToken, setProfileId } from '../public/js/api.js';

// The service worker answers an unsendable /api/ request with this exact shape.
const swOffline = () => new Response(JSON.stringify({ error: 'offline', offline: true }),
  { status: 503, headers: { 'Content-Type': 'application/json' } });
const ok = data => new Response(JSON.stringify(data),
  { status: 200, headers: { 'Content-Type': 'application/json' } });

let mode = 'online';
let served = null;
beforeEach(() => { setToken('t'); setProfileId(1); mode = 'online'; });
globalThis.fetch = async () => (mode === 'online' ? ok(served) : swOffline());

// IndexedDB does not exist here, so offlineStore's reads resolve to null. That
// is the "storage unavailable" path, and the point of these assertions is that
// it degrades to exactly the old behaviour rather than throwing something new.

test('online, a cacheable GET returns its data unwrapped', async () => {
  served = { calories: 1450 };
  assert.deepStrictEqual(await api.get('/api/meals/day/2026-08-29'), { calories: 1450 });
});

test('getCached reports stale:false when the request actually went through', async () => {
  served = { calories: 1450 };
  const r = await api.getCached('/api/meals/day/2026-08-29');
  assert.deepStrictEqual(r, { data: { calories: 1450 }, stale: false, at: null });
});

test('offline with no stored copy still throws the offline error', async () => {
  mode = 'offline';
  await assert.rejects(() => api.getCached('/api/meals/day/2026-08-29'),
    err => err.offline === true && /offline/i.test(err.message));
});

test('offline with a fallback returns the fallback, not an error', async () => {
  mode = 'offline';
  const r = await api.getCached('/api/weight?limit=10', []);
  assert.deepStrictEqual(r, { data: [], stale: false, at: null });
});

test('a fallback does NOT mask a real server error', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'boom' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(() => api.getCached('/api/weight?limit=10', []),
    err => err.status === 400 && err.message === 'boom');
  globalThis.fetch = async () => (mode === 'online' ? ok(served) : swOffline());
});

test('plain api.get is unchanged by any of this', async () => {
  mode = 'offline';
  await assert.rejects(() => api.get('/api/meals/day/2026-08-29'),
    err => err.offline === true);
});

// ── telling the write queue the server is back ──────────────────────────────
// The queue flushes on the browser's 'online' event and on the app returning to
// the foreground. Neither fires when the SERVER was what went away: the phone
// keeps its signal and the app stays open. Measured in a browser — a meal logged
// during a server outage stayed on the device, unsent, while the offline banner
// cleared and Today looked entirely normal.
test('a successful request after an unreachable one announces the recovery', async () => {
  // Earlier tests in this file leave the module believing the server is down,
  // so settle it with one good request BEFORE listening.
  served = { ok: 1 };
  await api.get('/api/settings');

  const seen = [];
  const listener = () => seen.push('reachable');
  globalThis.window = { dispatchEvent: e => { if (e.type === 'plated:reachable') listener(); } };

  // A healthy request while nothing is wrong must NOT announce anything —
  // otherwise this fires on every request in the app and the queue re-reads
  // IndexedDB constantly.
  served = { ok: 1 };
  await api.get('/api/settings');
  assert.deepStrictEqual(seen, [], 'announced a recovery that never happened');

  // The server goes away. 502 is what a proxy returns mid-deploy.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad gateway' }),
    { status: 502, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(() => api.get('/api/settings'), err => err.unreachable === true);
  assert.deepStrictEqual(seen, [], 'nothing to announce while it is still down');

  // And comes back.
  globalThis.fetch = async () => ok({ ok: 1 });
  await api.get('/api/settings');
  assert.deepStrictEqual(seen, ['reachable'], 'the recovery was not announced');

  // Once, not on every subsequent request.
  await api.get('/api/settings');
  await api.get('/api/settings');
  assert.deepStrictEqual(seen, ['reachable'], 'announced more than once per outage');

  delete globalThis.window;
  globalThis.fetch = async () => (mode === 'online' ? ok(served) : swOffline());
});

test('the synthetic offline 503 counts as unreachable for the same purpose', async () => {
  const seen = [];
  globalThis.window = { dispatchEvent: e => { if (e.type === 'plated:reachable') seen.push(1); } };
  mode = 'offline';
  await assert.rejects(() => api.get('/api/settings'));
  mode = 'online'; served = { ok: 1 };
  await api.get('/api/settings');
  assert.strictEqual(seen.length, 1, 'coming back from no-signal must announce too');
  delete globalThis.window;
});
