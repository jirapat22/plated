// The first tests that go through the actual server.
//
// Everything else here unit-tests an exported function, which is the right shape
// for pure logic but cannot see a bug that lives in the ORDER of two statements
// inside a route handler. The batch case below is exactly that: `grams > 0` was
// checked before `grams = Math.min(grams, remaining_g)`, so an empty batch
// clamped to zero and wrote a 0 g, 0 kcal entry while answering 201. No unit
// test could have caught it, and a real request catches it in one line.
//
// The server runs as a child process on its own port with a throwaway DATA_DIR,
// so this touches nothing real and leaves nothing behind.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-http-'));
let child, token;

const api = (method, p, body, tok = token) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  child = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: 'test' },
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..'),
    stdio: 'ignore',
  });
  // Poll rather than sleep — a fixed wait is either flaky or slow, and the
  // first boot has to seed ~4,800 foods.
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await fetch(BASE + '/'); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  const r = await api('POST', '/api/auth/profiles', { name: 'HTTPTEST', passcode: '4417' }, null);
  token = (await r.json()).token;
  assert.ok(token, 'could not create a test profile');
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

// ── the batch bug ───────────────────────────────────────────────────────────
test('an exhausted batch refuses a portion instead of logging a phantom one', async () => {
  // Nutrition comes from the foods table, not the request — ingredients are
  // (food_id, quantity_g) pairs. food_id 1 is the first seeded food.
  const made = await (await api('POST', '/api/batches', {
    name: 'Test chilli', cooked_g: 500,
    items: [{ food_id: 1, quantity_g: 500 }],
  })).json();
  assert.ok(made.id, `batch not created: ${JSON.stringify(made)}`);

  // Drain it. Asking for more than is left is legitimate and clamps.
  const drain = await api('POST', `/api/batches/${made.id}/portion`, { grams: 9999 });
  assert.strictEqual(drain.status, 201);
  assert.strictEqual((await drain.json()).remaining_g, 0);

  // Now there is none left. This used to answer 201 with logged_g: 0.
  const again = await api('POST', `/api/batches/${made.id}/portion`, { grams: 50 });
  assert.strictEqual(again.status, 409, 'a finished batch must refuse, not log nothing');

  // And no zero-gram entry may exist anywhere in the day.
  const day = await (await api('GET', `/api/meals/day/${new Date().toISOString().slice(0, 10)}`)).json();
  const zeros = (day.sessions || []).flatMap(s => s.entries).filter(e => !(e.quantity_g > 0));
  assert.deepStrictEqual(zeros, [], 'a 0 g entry was written');
});

// ── the validation fixes, through the real route ────────────────────────────
test('a date that is not a real day is refused', async () => {
  const r = await api('POST', '/api/meals/log', { food_id: 1, quantity_g: 100, date: '2026-02-30' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /real date/i);
});

test('a slipped decimal point in the quantity is refused', async () => {
  const r = await api('POST', '/api/meals/log', { food_id: 1, quantity_g: 1e9 });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /decimal point/i);
});

test('a negative calorie goal never reaches goal history', async () => {
  assert.strictEqual((await api('PATCH', '/api/settings', { calorie_goal: -500 })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { calorie_goal: 1e9 })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/settings', { calorie_goal: 1900 })).status, 200);
  const s = await (await api('GET', '/api/settings')).json();
  assert.strictEqual(s.calorie_goal, '1900');
});

test('an IPv6 loopback IronLog URL is refused', async () => {
  const r = await api('PATCH', '/api/settings', { ironlog_api_url: 'http://[::1]:3520/x' });
  assert.strictEqual(r.status, 400);
});

// ── the ordinary path still works ───────────────────────────────────────────
test('a normal meal logs and shows up in the day', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await api('POST', '/api/meals/log', { food_id: 1, quantity_g: 150, date: today });
  assert.strictEqual(r.status, 201);
  const day = await (await api('GET', `/api/meals/day/${today}`)).json();
  assert.ok(day.totals.calories > 0, 'the day total did not move');
});

// ── the day says which of its totals are floors ─────────────────────────────
test('a calories-only meal marks the macros as incomplete, not as zero', async () => {
  const today = new Date().toISOString().slice(0, 10);
  // A known food first, so the macros have a real floor to be a floor OF.
  await api('POST', '/api/meals/log', { food_id: 1, quantity_g: 100, date: today });
  const known = await (await api('GET', `/api/meals/day/${today}`)).json();
  assert.deepStrictEqual(known.totals_partial, {
    calories: false, protein: false, carbs: false, fat: false, fiber: false,
  }, 'nothing is partial yet');

  // Now a Quick Log: calories typed, macros unknown.
  // The quick shape the sheet sends: a description plus a per-100g figure,
  // logged as 100 g, which is how "900 kcal, no idea of the macros" is stored.
  const r = await api('POST', '/api/meals/log', {
    quick: { name: 'Pub dinner', calories_per_100g: 900 }, quantity_g: 100, date: today,
  });
  assert.strictEqual(r.status, 201, await r.text());

  const day = await (await api('GET', `/api/meals/day/${today}`)).json();
  assert.strictEqual(day.totals_partial.protein, true, 'protein is now a floor');
  assert.strictEqual(day.totals_partial.calories, false, 'calories were typed in, so they are known');
  // The number itself must not move — it is still the sum of what is known.
  assert.strictEqual(day.totals.protein, known.totals.protein);
});
