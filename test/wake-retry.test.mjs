// Waking a sleeping Railway service must not look like being offline.
//
// App Sleeping stops the container after 5 minutes with no outbound packets and
// wakes it on the next inbound request. Per Railway's docs, "the first request
// to a sleeping service may return a 502" — that request IS the wake, so the
// 502 is the cost of waking, not a fault.
//
// Plated already treats 502/503/504 as `unreachable` and falls back to the read
// cache, which is right for a 30-second redeploy. It is the wrong story for a
// wake: the app would open on "showing what was saved" while the server is by
// then perfectly awake, and nothing re-fetches, because plated:reachable fires
// only on the next SUCCESSFUL request and only the write queue listens for it.
//
// With two people on this app, every launch is more than five minutes after the
// last one. So this would not be an edge case — it would be what opening Plated
// looks like, every time, on the phone of the person who can least afford to
// wonder whether the numbers on screen are current.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { api, setToken, setProfileId } from '../public/js/api.js';

const ok = data => new Response(JSON.stringify(data),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
const proxy502 = () => new Response('<html>Bad Gateway</html>',
  { status: 502, headers: { 'Content-Type': 'text/html' } });

let calls = [];
beforeEach(() => { setToken('t'); setProfileId(1); calls = []; });

test('a single 502 is retried and the wake is invisible', async () => {
  // Exactly the sleeping-service sequence: the waking request 502s, the next
  // one finds the container up.
  globalThis.fetch = async (p, o) => {
    calls.push(o.method);
    return calls.length === 1 ? proxy502() : ok({ calories: 1450 });
  };
  const r = await api.get('/api/meals/day/2026-09-30');
  assert.deepStrictEqual(r, { calories: 1450 }, 'the retry did not deliver live data');
  assert.strictEqual(calls.length, 2, `expected one retry, made ${calls.length} request(s)`);
});

test('getCached reports stale:false after a wake, not a saved copy', async () => {
  // The assertion that matters for the banner: "showing what was saved" must
  // not appear for data that is, in fact, live.
  globalThis.fetch = async (p, o) => {
    calls.push(o.method);
    return calls.length === 1 ? proxy502() : ok({ calories: 1450 });
  };
  const r = await api.getCached('/api/meals/day/2026-09-30');
  assert.strictEqual(r.stale, false, 'a woken server was reported as stale cache');
  assert.deepStrictEqual(r.data, { calories: 1450 });
});

test('a server that is really down still degrades, it does not loop', async () => {
  // One retry, not a retry storm. Two attempts and then the old path.
  globalThis.fetch = async (p, o) => { calls.push(o.method); return proxy502(); };
  await assert.rejects(() => api.get('/api/meals/day/2026-09-30'),
    err => err.unreachable === true && err.status === 502);
  assert.strictEqual(calls.length, 2, `retried ${calls.length - 1} time(s), expected exactly 1`);
});

test('writes are never retried', async () => {
  // A write may or may not carry a client_id, and the server only replays the
  // ones that do. Sending an unkeyed write twice is how one meal becomes two,
  // so the retry is reads-only; a launch is reads anyway.
  globalThis.fetch = async (p, o) => { calls.push(o.method); return proxy502(); };
  await assert.rejects(() => api.post('/api/meals/log', { food_id: 1, quantity_g: 100 }),
    err => err.unreachable === true);
  assert.strictEqual(calls.length, 1, `a POST was sent ${calls.length} times`);
});

test("the app's own 503 message is shown as written, not as 'server restarting'", async () => {
  // Bug from Discord 29/10: searching "Frozen" while building a batch said "The
  // server is restarting" because Open Food Facts was busy and the app said so
  // with a JSON 503. No retry either: the app answered, it isn't waking.
  globalThis.fetch = async (p, o) => {
    calls.push(o.method);
    return new Response(JSON.stringify({ error: 'Open Food Facts is busy right now — try that again in a moment' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(() => api.get('/api/foods/search/remote?q=Frozen'),
    err => /Open Food Facts is busy/.test(err.message) && !err.unreachable && err.status === 503);
  assert.strictEqual(calls.length, 1, 'an answer from the app should not be retried as a wake');
});
