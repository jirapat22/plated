// The half of the offline story the other file can't reach.
//
// offline-api.test.mjs runs with no IndexedDB, so getRead always resolves null
// and every assertion there is about degrading gracefully when the store is
// missing. Nothing covered what happens when the store HAS the data — which is
// the entire point of the feature. This file supplies a minimal in-memory
// IndexedDB so both failure kinds can be tested against a populated cache.
//
// The shim is deliberately tiny: open/transaction/objectStore/get/put over a
// Map, driven by the same onsuccess/oncomplete callbacks offlineStore.js uses.
// It is not an IndexedDB implementation and is not trying to be one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';

const store = new Map();
const fire = (obj, prop, value) => queueMicrotask(() => { obj.result = value; obj[prop]?.(); });

globalThis.indexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        transaction(_name, _mode) {
          const t = {};
          const os = {
            get(key) { const r = {}; fire(r, 'onsuccess', store.get(key)); return r; },
            put(row) { store.set(row.key, row); const r = {}; fire(r, 'onsuccess', row.key); return r; },
          };
          t.objectStore = () => os;
          queueMicrotask(() => queueMicrotask(() => t.oncomplete?.()));
          return t;
        },
      };
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

const { api, setToken, setProfileId } = await import('../public/js/api.js');

const ok = data => new Response(JSON.stringify(data),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
// What the service worker hands back when it couldn't put the request on the wire.
const swOffline = () => new Response(JSON.stringify({ error: 'offline', offline: true }),
  { status: 503, headers: { 'Content-Type': 'application/json' } });
// What Railway's proxy hands back while the container restarts.
const proxy502 = () => new Response('<html>Bad Gateway</html>',
  { status: 502, headers: { 'Content-Type': 'text/html' } });

const DAY = '/api/meals/day/2026-08-29';
let respond = ok;
beforeEach(() => { setToken('t'); setProfileId(1); respond = () => ok({ calories: 1450 }); });
globalThis.fetch = async () => respond();

async function warmTheCache() {
  await api.get(DAY);                       // a successful GET is what fills it
}

test('a successful GET is remembered for later', async () => {
  await warmTheCache();
  respond = swOffline;
  const r = await api.getCached(DAY);
  assert.deepStrictEqual(r.data, { calories: 1450 });
  assert.strictEqual(r.stale, true);
  assert.ok(typeof r.at === 'number', 'the copy must carry when it was taken');
});

// The regression this file exists for. A 502 from the proxy took a different
// branch from a lost signal and never consulted the cache, so a redeploy blanked
// Today on a device holding a perfectly good copy of it.
test('a 502 falls back to the cached copy, same as no signal does', async () => {
  await warmTheCache();
  respond = proxy502;
  const r = await api.getCached(DAY);
  assert.deepStrictEqual(r.data, { calories: 1450 });
  assert.strictEqual(r.stale, true, '502 must be served from cache, not thrown away');
});

test('with nothing cached, a 502 still surfaces as the restarting error', async () => {
  respond = proxy502;
  await assert.rejects(() => api.getCached('/api/meals/day/1999-01-01'),
    err => err.unreachable === true && /restarting/i.test(err.message));
});

// The cache must never answer for a write — replaying a stale POST response as
// though the write had happened is how you lose a meal and think you logged it.
test('a 502 on a write is never answered from the cache', async () => {
  await warmTheCache();
  respond = proxy502;
  await assert.rejects(() => api.post(DAY, { x: 1 }),
    err => err.unreachable === true && err.cached === undefined);
});
