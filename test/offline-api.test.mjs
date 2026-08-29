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
