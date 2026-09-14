// A minted leftover food is swept when nothing points at it — and NOTHING is
// the whole list of things that can point at it.
//
// A whole-meal split mints a food to back its leftover: hidden from search,
// belonging to that one leftover, carrying its per-100g. When the leftover goes
// the food should go too, and three places do that sweep — deleting a profile,
// restoring a backup, and binning a single leftover.
//
// All three wrote out the same NOT EXISTS clause naming meal_entries, batches
// and leftovers. Then preset_items became a fourth thing that references foods,
// and not one of the three learned about it. Because foreign_keys is ON, the
// DELETE does not quietly skip the row — it RAISES, and takes whatever it is
// inside down with it:
//
//   * "Delete this profile" answered 500 FOREIGN KEY constraint failed, every
//     time, for good. The only way out was to delete the preset first, which
//     nothing told you.
//   * Binning a leftover answered the same 500 AFTER deleting the leftover, so
//     the action succeeded, reported failure, and left the row on screen
//     (the list does not reload on error) until you navigated away.
//
// These tests are about the shape of the bug, not the one instance of it: the
// fourth table is in FOOD_REFERRERS now, and a fifth belongs there too.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-sweep-'));
let child, keeper, victim;

const call = (method, p, body, tok) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const as = p => (method, path, body) => call(method, path, body, p.token);
const json = r => r.json();

async function makeProfile(name, passcode) {
  const r = await call('POST', '/api/auth/profiles', { name, passcode }, null);
  const b = await r.json();
  assert.strictEqual(r.status, 201, JSON.stringify(b));
  return { id: b.profile.id, token: b.token };
}

// A food, a meal holding it, then a half-eaten split — which is what mints the
// backing food this whole file is about. Returns the leftover and its food id.
async function makeLeftover(p, name) {
  const api = as(p);
  const food = await json(await api('POST', '/api/foods', {
    name: `${name} ingredient`, calories_per_100g: 100, protein_per_100g: 10,
  }));
  const sess = await json(await api('POST', '/api/meals/sessions', { name }));
  await api('POST', `/api/meals/sessions/${sess.id}/entries`, { food_id: food.id, quantity_g: 200 });
  const split = await json(await api('POST', `/api/meals/sessions/${sess.id}/leftover`, { ate: 0.5 }));
  assert.ok(split.leftover_id, `split failed: ${JSON.stringify(split)}`);
  const list = await json(await api('GET', '/api/leftovers'));
  const row = list.find(l => l.id === split.leftover_id);
  assert.ok(row?.food_id, 'the split did not mint a backing food');
  return row;
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
  // Two profiles: deleting the only admin while others exist is refused for its
  // own good reasons, so the one being deleted must not be the last one.
  keeper = await makeProfile('SWEEPKEEP', '5521');
  victim = await makeProfile('SWEEPGONE', '5522');
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows holds the file */ }
});

test('a leftover whose food a PRESET still holds can be binned', async () => {
  const api = as(keeper);
  const l = await makeLeftover(keeper, 'Chilli');
  // The preset is the fourth referrer none of the sweeps knew about.
  const preset = await json(await api('POST', '/api/presets', {
    name: 'Chilli again', kind: 'meal', items: [{ food_id: l.food_id, quantity_g: 150 }],
  }));
  assert.ok(preset.id, JSON.stringify(preset));

  const res = await api('DELETE', `/api/leftovers/${l.id}`);
  assert.strictEqual(res.status, 200, `bin failed: ${JSON.stringify(await res.json())}`);

  // Gone from the fridge...
  const fridge = await json(await api('GET', '/api/leftovers'));
  assert.ok(!fridge.some(x => x.id === l.id), 'the leftover survived the bin');
  // ...and the preset it was holding still resolves, food and all. The sweep
  // has to SKIP a referenced food, not delete it and not blow up on it.
  const presets = await json(await api('GET', '/api/presets'));
  const still = presets.find(p => p.id === preset.id);
  assert.strictEqual(still.items.length, 1, 'the preset lost its food');
  assert.strictEqual(still.items[0].food_id, l.food_id);
});

test('binning still clears the minted food when nothing holds it', async () => {
  const api = as(keeper);
  const l = await makeLeftover(keeper, 'Soup');
  const res = await api('DELETE', `/api/leftovers/${l.id}`);
  assert.strictEqual(res.status, 200);
  // The whole point of the sweep: with no preset, no entry and no batch, the
  // invisible row goes rather than accumulating one per binned plate.
  const food = await api('GET', `/api/foods/${l.food_id}`);
  assert.strictEqual(food.status, 404, 'the orphaned backing food was left behind');
});

test('the bin is all-or-nothing', async () => {
  // The two writes used to be loose statements, so the failing one left the
  // first committed. Whatever happens now, the leftover and its food agree
  // about whether the bin ran.
  const api = as(keeper);
  const l = await makeLeftover(keeper, 'Curry');
  await api('DELETE', `/api/leftovers/${l.id}`);
  const fridge = await json(await api('GET', '/api/leftovers'));
  const foodRes = await api('GET', `/api/foods/${l.food_id}`);
  assert.ok(!fridge.some(x => x.id === l.id));
  assert.strictEqual(foodRes.status, 404);
});

test('a profile holding a preset over a leftover food can still be deleted', async () => {
  // The headline failure. Everything else in this file is a variation on it.
  const api = as(victim);
  const l = await makeLeftover(victim, 'Dinner');
  await api('POST', '/api/presets', {
    name: 'Dinner again', kind: 'meal', items: [{ food_id: l.food_id, quantity_g: 150 }],
  });

  const res = await api('DELETE', '/api/auth/me');
  const body = await res.json();
  assert.strictEqual(res.status, 200, `profile could not be deleted: ${JSON.stringify(body)}`);

  // And it is really gone — not half-deleted by a rolled-back transaction.
  const me = await api('GET', '/api/auth/me');
  assert.strictEqual(me.status, 401, 'the session outlived the profile');
});
