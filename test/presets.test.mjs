// Presets — a saved recipe ('batch') or a saved set of foods ('meal').
//
// The old meal_templates were removed in July as unused; these are not those,
// and the tables are deliberately named differently because migrateSchema
// DROPs meal_templates on every boot. That drop is the first thing checked
// here: a table that vanishes on the next deploy is the worst way to learn.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-preset-'));
const DAY = '2026-09-01';
let child, me, other;

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
const boot = async () => {
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
};

before(async () => {
  await boot();
  me = await makeProfile('PRESETA', '7391');
  other = await makeProfile('PRESETB', '8264');
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

const mk = (kind, name, items) => as(me)('POST', '/api/presets', { kind, name, items });

test('a preset saves what it was given, and comes back with it', async () => {
  const r = await mk('batch', 'Sunday chilli', [
    { food_id: 1, quantity_g: 800 }, { food_id: 2, quantity_g: 400 },
  ]);
  const p = await r.json();
  assert.strictEqual(r.status, 201, JSON.stringify(p));
  assert.strictEqual(p.kind, 'batch');
  assert.strictEqual(p.items.length, 2);
  assert.strictEqual(p.items[0].quantity_g, 800);
  assert.ok(p.items[0].food_name, 'items come back without the food name to show');
  // Order is the order it was given in — a recipe reads in the order you cook.
  assert.deepStrictEqual(p.items.map(i => i.food_id), [1, 2]);
});

test('a preset is refused without a name, a kind, or any food', async () => {
  for (const [body, why] of [
    [{ kind: 'batch', items: [{ food_id: 1, quantity_g: 100 }] }, 'no name'],
    [{ kind: 'soup', name: 'x', items: [{ food_id: 1, quantity_g: 100 }] }, 'bad kind'],
    [{ kind: 'meal', name: 'x', items: [] }, 'no items'],
    [{ kind: 'meal', name: 'x' }, 'items missing'],
    [{ kind: 'meal', name: 'x', items: [{ food_id: 1, quantity_g: 0 }] }, 'zero grams'],
    [{ kind: 'meal', name: 'x', items: [{ food_id: 1, quantity_g: 1e9 }] }, 'a slipped decimal'],
  ]) {
    const r = await as(me)('POST', '/api/presets', body);
    assert.strictEqual(r.status, 400, `${why} was accepted`);
  }
  const missing = await as(me)('POST', '/api/presets',
    { kind: 'meal', name: 'x', items: [{ food_id: 999999, quantity_g: 100 }] });
  assert.strictEqual(missing.status, 404, 'a food that does not exist was accepted');
});

test('editing replaces the contents rather than merging them', async () => {
  const p = await (await mk('meal', 'Breakfast', [{ food_id: 1, quantity_g: 100 }])).json();
  const r = await as(me)('PATCH', `/api/presets/${p.id}`, {
    name: 'Big breakfast', items: [{ food_id: 2, quantity_g: 250 }],
  });
  const after = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(after));
  assert.strictEqual(after.name, 'Big breakfast');
  assert.deepStrictEqual(after.items.map(i => i.food_id), [2], 'the old item survived the replace');
  // A rename alone must not empty it.
  const renamed = await (await as(me)('PATCH', `/api/presets/${p.id}`, { name: 'Brunch' })).json();
  assert.strictEqual(renamed.items.length, 1, 'renaming dropped the contents');
});

test('a preset belongs to one profile', async () => {
  const p = await (await mk('meal', 'Mine', [{ food_id: 1, quantity_g: 100 }])).json();
  assert.strictEqual((await as(other)('PATCH', `/api/presets/${p.id}`, { name: 'Theirs' })).status, 404);
  assert.strictEqual((await as(other)('DELETE', `/api/presets/${p.id}`)).status, 404);
  assert.strictEqual((await as(other)('POST', `/api/presets/${p.id}/log`, {})).status, 404);
  const theirs = await (await as(other)('GET', '/api/presets')).json();
  assert.deepStrictEqual(theirs, [], "another profile's presets are listed");
});

// ── using a meal preset ─────────────────────────────────────────────────────
test('logging a meal preset lands every food in one meal', async () => {
  const p = await (await mk('meal', 'Usual lunch', [
    { food_id: 1, quantity_g: 150 }, { food_id: 2, quantity_g: 60 },
  ])).json();

  const r = await as(me)('POST', `/api/presets/${p.id}/log`, { date: DAY });
  const out = await r.json();
  assert.strictEqual(r.status, 201, JSON.stringify(out));
  assert.strictEqual(out.entries, 2);

  const day = await (await as(me)('GET', `/api/meals/day/${DAY}`)).json();
  const session = day.sessions.find(s => s.name === 'Usual lunch');
  assert.ok(session, `the meal did not land: ${day.sessions.map(s => s.name)}`);
  assert.strictEqual(session.entries.length, 2);
  // Macros are computed from the food, not copied from the preset — so a food
  // whose data is corrected later logs the corrected numbers.
  assert.ok(session.entries[0].calories > 0, 'entries landed with no calories');
});

test('an adjusted quantity applies to the day, not to the preset', async () => {
  const p = await (await mk('meal', 'Adjustable', [{ food_id: 1, quantity_g: 200 }])).json();
  await as(me)('POST', `/api/presets/${p.id}/log`, { date: DAY, items: [{ food_id: 1, quantity_g: 75 }] });

  const day = await (await as(me)('GET', `/api/meals/day/${DAY}`)).json();
  const session = day.sessions.find(s => s.name === 'Adjustable');
  assert.strictEqual(session.entries[0].quantity_g, 75, 'the adjustment was ignored');

  const still = await (await as(me)('GET', '/api/presets')).json();
  assert.strictEqual(still.find(x => x.id === p.id).items[0].quantity_g, 200,
    'adjusting for one day rewrote the preset');
});

test('an adjustment cannot smuggle in a food the preset does not hold', async () => {
  const p = await (await mk('meal', 'Fixed', [{ food_id: 1, quantity_g: 100 }])).json();
  await as(me)('POST', `/api/presets/${p.id}/log`, {
    date: DAY, items: [{ food_id: 2, quantity_g: 500 }],   // food 2 is not in it
  });
  const day = await (await as(me)('GET', `/api/meals/day/${DAY}`)).json();
  const session = day.sessions.find(s => s.name === 'Fixed');
  assert.strictEqual(session.entries.length, 1, 'an extra food was written');
  assert.strictEqual(session.entries[0].food_id, 1);
});

test('a batch recipe refuses to be logged as a meal', async () => {
  const p = await (await mk('batch', 'Not a meal', [{ food_id: 1, quantity_g: 900 }])).json();
  const r = await as(me)('POST', `/api/presets/${p.id}/log`, { date: DAY });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /batch recipe/i);
});

test('a repeated log with the same client_id lands once', async () => {
  // The write queue replays on a flaky connection; a preset is several entries,
  // so a duplicate is a whole duplicated meal rather than one stray food.
  const p = await (await mk('meal', 'Idempotent', [{ food_id: 1, quantity_g: 100 }])).json();
  const client_id = 'presettest-0000-4000-8000-000000000001';
  const a = await (await as(me)('POST', `/api/presets/${p.id}/log`, { date: DAY, client_id })).json();
  const b = await (await as(me)('POST', `/api/presets/${p.id}/log`, { date: DAY, client_id })).json();
  assert.strictEqual(a.session_id, b.session_id, 'the retry wrote a second meal');
  const day = await (await as(me)('GET', `/api/meals/day/${DAY}`)).json();
  assert.strictEqual(day.sessions.filter(s => s.name === 'Idempotent').length, 1);
});

test('a bad date is refused rather than silently filed under today', async () => {
  const p = await (await mk('meal', 'Datecheck', [{ food_id: 1, quantity_g: 100 }])).json();
  const r = await as(me)('POST', `/api/presets/${p.id}/log`, { date: '2026-02-30' });
  assert.strictEqual(r.status, 400);
});

test('deleting a preset takes its items with it and leaves the meals alone', async () => {
  const p = await (await mk('meal', 'Doomed', [{ food_id: 1, quantity_g: 100 }])).json();
  await as(me)('POST', `/api/presets/${p.id}/log`, { date: DAY });
  assert.strictEqual((await as(me)('DELETE', `/api/presets/${p.id}`)).status, 200);
  assert.strictEqual((await as(me)('DELETE', `/api/presets/${p.id}`)).status, 404);

  // The meal it produced is history now and must survive its source.
  const day = await (await as(me)('GET', `/api/meals/day/${DAY}`)).json();
  assert.ok(day.sessions.some(s => s.name === 'Doomed'), 'deleting the preset deleted the meal it logged');
});

test('the table is not the one the migration drops on every boot', async () => {
  // meal_templates and meal_template_items are DROPped unconditionally in
  // migrateSchema. If presets had reused either name, everything above would
  // pass and the feature would disappear on the next deploy.
  const src = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  const dropped = [...src.matchAll(/DROP TABLE IF EXISTS (\w+)/g)].map(m => m[1]);
  for (const t of ['presets', 'preset_items']) {
    assert.ok(!dropped.includes(t), `${t} is dropped on boot — the feature would not survive a deploy`);
  }
});
