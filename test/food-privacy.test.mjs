// A quick/batch/leftover food belongs to the profile that made it.
//
// Those three sources are not library entries — they are the free text you
// typed for a meal you couldn't weigh, the name of something you cooked, what
// you saved for later. GET /api/foods/:id has gated them since someone noticed
// that walking /api/foods/1..N read every household member's meal descriptions
// out of a shared table.
//
// The gate went on that one route. Every other route taking a food id from the
// request kept resolving anything: creating a preset handed back the name and
// all five macros, and so did logging the food to your own day. This file is
// the invariant rather than the patch — one test per doorway, because the hole
// was only ever closed on the door somebody happened to be looking at.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-priv-'));
const SECRET = 'hospital canteen dinner';
let child, mum, snoop, secretId;

const call = (method, p, body, tok) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const as = p => (method, path, body) => call(method, path, body, p.token);
async function makeProfile(name, passcode) {
  const r = await call('POST', '/api/auth/profiles', { name, passcode }, null);
  const b = await r.json();
  assert.strictEqual(r.status, 201, JSON.stringify(b));
  return { id: b.profile.id, token: b.token };
}

before(async () => {
  child = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: 'test' },
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..'),
    stdio: 'ignore',
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await fetch(BASE + '/'); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  mum = await makeProfile('PRIVA', '7712');
  snoop = await makeProfile('PRIVB', '3398');

  // MUM types a meal she couldn't weigh. That text is the thing being protected.
  const logged = await (await as(mum)('POST', '/api/meals/log', {
    quick: { name: SECRET, calories_per_100g: 640 }, quantity_g: 100,
  })).json();
  secretId = logged.entry.food_id;
  assert.ok(secretId, `no food id came back: ${JSON.stringify(logged)}`);
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

// The gate that already existed — here so that removing it fails a test in the
// file that explains why it is there, not just the one that named the route.
test('the read route still refuses it', async () => {
  assert.strictEqual((await as(snoop)('GET', `/api/foods/${secretId}`)).status, 404);
  assert.strictEqual((await as(mum)('GET', `/api/foods/${secretId}`)).status, 200,
    'the owner must still be able to read their own');
});

test('a preset cannot be built on it', async () => {
  const r = await as(snoop)('POST', '/api/presets', {
    kind: 'meal', name: 'probe', items: [{ food_id: secretId, quantity_g: 100 }],
  });
  const body = await r.text();
  assert.strictEqual(r.status, 404, `it was accepted: ${body}`);
  assert.ok(!body.includes(SECRET), 'the refusal echoed the name back');
});

test('it cannot be logged to another profile\u2019s day', async () => {
  const r = await as(snoop)('POST', '/api/meals/log', { food_id: secretId, quantity_g: 100 });
  const body = await r.text();
  assert.strictEqual(r.status, 404, `it was logged: ${body}`);
  assert.ok(!body.includes(SECRET), 'the response carried the name');
});

test('it cannot be added to another profile\u2019s meal', async () => {
  const s = await (await as(snoop)('POST', '/api/meals/sessions', { name: 'Lunch' })).json();
  const r = await as(snoop)('POST', `/api/meals/sessions/${s.id}/entries`,
    { food_id: secretId, quantity_g: 100 });
  const body = await r.text();
  assert.strictEqual(r.status, 404, `it was added: ${body}`);
  assert.ok(!body.includes(SECRET), 'the response carried the name');
});

test('it cannot be an ingredient in another profile\u2019s batch', async () => {
  // computeTotals skips an unusable ingredient the way it skips a deleted one,
  // so the batch is refused for having nothing in it rather than 404ing.
  const r = await as(snoop)('POST', '/api/batches', {
    name: 'probe', cooked_g: 500, items: [{ food_id: secretId, quantity_g: 100 }],
  });
  const body = await r.text();
  assert.ok(r.status >= 400, `the batch was created from someone else's food: ${body}`);
  assert.ok(!body.includes(SECRET), 'the response carried the name');
});

// The other half: none of this may cost the owner the use of their own food.
test('the owner can still use their own food everywhere', async () => {
  const p = await as(mum)('POST', '/api/presets', {
    kind: 'meal', name: 'mine', items: [{ food_id: secretId, quantity_g: 100 }],
  });
  assert.strictEqual(p.status, 201, await p.text());
  const l = await as(mum)('POST', '/api/meals/log', { food_id: secretId, quantity_g: 50 });
  assert.strictEqual(l.status, 201, await l.text());
  const b = await as(mum)('POST', '/api/batches', {
    name: 'mine', cooked_g: 500, items: [{ food_id: secretId, quantity_g: 300 }],
  });
  assert.strictEqual(b.status, 201, await b.text());
});

// Shared library food is shared. The gate keys on `source`, and getting that
// backwards would quietly make 4,800 seeded foods private to nobody.
test('ordinary library food is unaffected', async () => {
  const r = await as(snoop)('POST', '/api/meals/log', { food_id: 1, quantity_g: 100 });
  assert.strictEqual(r.status, 201, await r.text());
});

// GET /api/batches/:id/portions reads meal_entries, which is somebody's diary.
//
// Added for the Fix sheet's "which portion was wrong?" button, and it is the
// kind of route this file exists for: it takes an id from the request and
// hands back rows joined to meal_sessions. Two scopes, and a test for each,
// because the second one is the easy one to leave out — the batch check alone
// looks sufficient right up until you notice foods is a SHARED table.
test('one profile cannot read another profile’s batch portions', async () => {
  const made = await (await as(mum)('POST', '/api/batches', {
    name: 'Mum chilli', cooked_g: 800, items: [{ food_id: 1, quantity_g: 800 }],
  })).json();
  assert.ok(made.id, `batch not created: ${JSON.stringify(made)}`);
  assert.strictEqual((await as(mum)('POST', `/api/batches/${made.id}/portion`, { grams: 250 })).status, 201);

  // The owner sees her own portion.
  const mine = await (await as(mum)('GET', `/api/batches/${made.id}/portions`)).json();
  assert.strictEqual(mine.length, 1, `expected one portion, got ${JSON.stringify(mine)}`);
  assert.strictEqual(Math.round(mine[0].quantity_g), 250);

  // Nobody else does, and the refusal says nothing about the pot.
  const r = await as(snoop)('GET', `/api/batches/${made.id}/portions`);
  const body = await r.text();
  assert.strictEqual(r.status, 404, `snoop read it: ${body}`);
  assert.ok(!body.includes('Mum chilli'), 'the refusal echoed the batch name back');
});
