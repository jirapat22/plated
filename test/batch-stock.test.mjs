// The pot is a running total that several doors write to. They have to agree.
//
// `remaining_g` is decremented when a portion is logged and incremented when
// that entry goes away, so every path that creates or removes a batch-backed
// meal_entry is part of one invariant: take grams out, put them back, and you
// must be exactly where you started. Three ways that failed, all reproduced
// against a live server before these tests existed:
//
//  1. adjustBatchStock clamped at 0 on the way DOWN while every give-back
//     handed the full quantity back. A pot with 100 g left, one 900 g entry
//     logged against it, then that entry deleted, and the pot claimed 900 g.
//     800 g of food invented, and every later portion priced off the fiction.
//  2. POST /api/presets/:id/log inserted entries without drawing the pot down
//     at all, while DELETE /entries/:id refunded them regardless — so the pot
//     came back FULLER than before the meal was eaten.
//  3. A 🥡 split of a batch portion left the leftover pointing at the batch's
//     backing food, so eating that leftover and then deleting the entry
//     refunded grams that had already left the pot when it was served.
//
// The shape of all three is the same: one direction of the arithmetic knew
// something the other didn't. These tests only ever assert conservation.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-stock-'));
let child, me, today;

const call = (method, p, body, tok) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
let api;
const json = r => r.json();

// What the pot says it holds, straight off the list route.
async function stock(name) {
  const all = await json(await api('GET', '/api/batches'));
  const b = all.find(x => x.name === name);
  return b ? b.remaining_g : null;
}
async function potRow(name) {
  const all = await json(await api('GET', '/api/batches'));
  return all.find(x => x.name === name) || null;
}
// A pot of `cooked` grams made from one food, plus that food's id.
async function makePot(name, cooked, per100 = { calories_per_100g: 100, protein_per_100g: 20 }) {
  const food = await json(await api('POST', '/api/foods', { name: `${name} ingredient`, ...per100 }));
  const b = await json(await api('POST', '/api/batches',
    { name, cooked_g: cooked, items: [{ food_id: food.id, quantity_g: cooked }] }));
  assert.ok(b.id, `pot not created: ${JSON.stringify(b)}`);
  // The batch's backing food isn't in the shaped response, so find it by
  // logging a token portion and reading the entry back.
  const p = await json(await api('POST', `/api/batches/${b.id}/portion`, { grams: 1, date: today }));
  const day = await json(await api('GET', `/api/meals/day/${today}`));
  const entry = day.sessions.flatMap(s => s.entries.map(e => ({ ...e, sid: s.id })))
    .find(e => e.quantity_g === 1);
  await api('DELETE', `/api/meals/entries/${entry.id}`);       // and put that gram back
  return { id: b.id, foodId: entry.food_id };
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
  const r = await json(await call('POST', '/api/auth/profiles', { name: 'STOCK', passcode: '8801' }, null));
  me = r.token;
  api = (m, p, b) => call(m, p, b, me);
  today = new Date().toISOString().slice(0, 10);
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows holds the file */ }
});

test('logging more than the pot holds, then deleting it, returns the pot to where it was', async () => {
  const pot = await makePot('ClampPot', 1000);
  await api('POST', `/api/batches/${pot.id}/portion`, { grams: 900, date: today });
  assert.strictEqual(await stock('ClampPot'), 100, 'setup: 100 g should be left');

  // 900 g against a pot holding 100. The entry is honest about what was eaten;
  // the pot cannot go below empty on screen.
  const sess = await json(await api('POST', '/api/meals/sessions', { name: 'Overdraw' }));
  const e = await json(await api('POST', `/api/meals/sessions/${sess.id}/entries`,
    { food_id: pot.foodId, quantity_g: 900 }));
  assert.strictEqual(await stock('ClampPot'), 0, 'a pot never shows less than empty');
  const row = await potRow('ClampPot');
  assert.strictEqual(row.overdrawn_g, 800, 'and it says how far past empty the log went');

  // The whole point: undo it and we are back at 100, not at 900.
  await api('DELETE', `/api/meals/entries/${e.id}`);
  assert.strictEqual(await stock('ClampPot'), 100,
    'deleting the over-drawn entry refunded grams that were never taken');
  assert.strictEqual((await potRow('ClampPot')).overdrawn_g, 0);
});

test('an emptied pot stays reachable, so it can still be corrected', async () => {
  const pot = await makePot('EmptyPot', 200);
  await api('POST', `/api/batches/${pot.id}/portion`, { grams: 200, date: today });
  assert.strictEqual(await stock('EmptyPot'), 0);
  // It used to vanish from this list at <= 1 g — and this list is the only one
  // the client has, so ⚖️ Fix, edit and delete all went with it.
  assert.ok(await potRow('EmptyPot'), 'an emptied pot disappeared from the batch list');
  const fixed = await json(await api('PATCH', `/api/batches/${pot.id}`, { remaining_g: 50 }));
  assert.strictEqual(fixed.remaining_g, 50, 'and ⚖️ Fix can still put it right');
});

test('logging a preset that holds a batch portion draws the pot down', async () => {
  const pot = await makePot('PresetPot', 900);
  const before = await stock('PresetPot');
  const pr = await json(await api('POST', '/api/presets',
    { name: 'PresetPotMeal', kind: 'meal', items: [{ food_id: pot.foodId, quantity_g: 250 }] }));
  const lg = await json(await api('POST', `/api/presets/${pr.id}/log`, { date: today }));
  assert.strictEqual(await stock('PresetPot'), before - 250,
    'logging the preset ate 250 g and the pot did not notice');

  const day = await json(await api('GET', `/api/meals/day/${today}`));
  const entry = day.sessions.find(s => s.id === lg.session_id).entries[0];
  await api('DELETE', `/api/meals/entries/${entry.id}`);
  assert.strictEqual(await stock('PresetPot'), before,
    'and deleting it put back exactly what came out');
});

test('a leftover split off a batch portion is no longer part of the pot', async () => {
  const pot = await makePot('SplitPot', 1000);
  await api('POST', `/api/batches/${pot.id}/portion`, { grams: 500, date: today });
  const after = await stock('SplitPot');
  assert.strictEqual(after, 500);

  const day = await json(await api('GET', `/api/meals/day/${today}`));
  const served = day.sessions.flatMap(s => s.entries).find(e => e.quantity_g === 500);
  // Serve 500 g, put 200 g back in the fridge. Those 200 g left the pot when
  // the portion was served — the pot must not change here.
  const split = await json(await api('POST', `/api/meals/entries/${served.id}/leftover`, { left_g: 200 }));
  assert.strictEqual(await stock('SplitPot'), after, 'the split moved pot stock');

  const fridge = await json(await api('GET', '/api/leftovers'));
  const lo = fridge.find(l => l.id === split.leftover_id);
  assert.notStrictEqual(lo.food_id, pot.foodId,
    'the leftover still points at the batch food, so eating it will double-count');

  // Eat it, then delete that entry. Neither may touch the pot.
  const eaten = await json(await api('POST', `/api/leftovers/${lo.id}/log`, { date: today }));
  assert.strictEqual(await stock('SplitPot'), after, 'eating the leftover drew the pot down again');
  const d2 = await json(await api('GET', `/api/meals/day/${today}`));
  const le = d2.sessions.find(s => s.id === eaten.session_id).entries[0];
  await api('DELETE', `/api/meals/entries/${le.id}`);
  assert.strictEqual(await stock('SplitPot'), after,
    'deleting the leftover entry refunded the pot for food it had already given up');
});

test('copying a meal twice with one client_id copies it once', async () => {
  const pot = await makePot('CopyPot', 600);
  await api('POST', `/api/batches/${pot.id}/portion`, { grams: 300, date: today });
  const before = await stock('CopyPot');

  const day = await json(await api('GET', `/api/meals/day/${today}`));
  // By THIS pot's food, not by a gram count — earlier tests in this file leave
  // 300 g entries on the same day and the first version of this test picked one
  // of theirs, whose food is a leftover and charges no pot.
  const src = day.sessions.find(s => s.entries.some(e => e.food_id === pot.foodId));
  assert.ok(src, 'could not find the meal holding this portion');
  const body = { date: today, client_id: 'stockcopyidem01' };
  const a = await json(await api('POST', `/api/meals/sessions/${src.id}/copy`, body));
  const b = await json(await api('POST', `/api/meals/sessions/${src.id}/copy`, body));

  assert.strictEqual(b.session_id, a.session_id, 'the second copy made a second meal');
  assert.strictEqual(await stock('CopyPot'), before - 300,
    'the pot was charged twice for one copy');
});

test('a batch edit keeps unknown macros unknown', async () => {
  // round1(null) is 0, so the PATCH path used to re-derive honest nulls into
  // confident zeros — and write them into the backing food, where every later
  // portion carried them and the day reported "0 g protein" as a measurement.
  const f = await json(await api('POST', '/api/foods',
    { name: 'StockKcalOnly', calories_per_100g: 200 }));
  const b = await json(await api('POST', '/api/batches',
    { name: 'NullMacroPot', cooked_g: 500, items: [{ food_id: f.id, quantity_g: 500 }] }));
  const at = await potRow('NullMacroPot');
  assert.strictEqual(at.protein, null, 'setup: protein starts unknown');

  await api('PATCH', `/api/batches/${b.id}`, { cooked_g: 450, items: [{ food_id: f.id, quantity_g: 500 }] });
  const edited = await potRow('NullMacroPot');
  assert.strictEqual(edited.protein, null, 'editing the batch invented a protein figure');
  assert.strictEqual(edited.per_100g.protein, null);

  // And the day it lands on must still admit the gap. Its own date, so the
  // other tests' entries can't supply a protein figure that masks this.
  const own = '2026-03-04';
  await api('POST', `/api/batches/${b.id}/portion`, { grams: 100, date: own });
  const day = await json(await api('GET', `/api/meals/day/${own}`));
  assert.strictEqual(day.totals_partial.protein, true,
    'the day claims to have measured a protein total it never had');
});
