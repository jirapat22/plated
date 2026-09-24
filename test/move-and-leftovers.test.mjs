// Moving a single food, undoing a merge, and eating half a leftover.
//
// The three gaps a real kitchen walks into. A meal could be moved off a wrong
// day but a single food could only be copied and then deleted. Merge destroyed
// the meal it emptied and left nothing to undo with. And a leftover was
// all-or-nothing, which a container in a fridge is not.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-move-'));
let child, me, other, today;

const call = (method, p, body, tok) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const as = p => (method, path, body) => call(method, path, body, p.token);
const json = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function makeProfile(name, passcode) {
  const r = await call('POST', '/api/auth/profiles', { name, passcode }, null);
  const b = await r.json();
  assert.strictEqual(r.status, 201, JSON.stringify(b));
  return { id: b.profile.id, token: b.token };
}
const session = async (p, name, date) =>
  (await json(await as(p)('POST', '/api/meals/sessions', { name, date }))).id;
const logInto = async (p, sid, food_id, quantity_g) =>
  json(await as(p)('POST', '/api/meals/log', { food_id, quantity_g, session_id: sid }));
const day = async (p, d) => json(await as(p)('GET', `/api/meals/day/${d}`));

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
  me = await makeProfile('MOVEA', '3141');
  other = await makeProfile('MOVEB', '2718');
  today = new Date().toLocaleDateString('en-CA');
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

// ── moving one food ─────────────────────────────────────────────────────────
test('a food moves to another meal on the same day', async () => {
  const a = await session(me, 'Breakfast', today);
  const b = await session(me, 'Lunch', today);
  const { entry } = await logInto(me, a, 1, 100);

  const r = await as(me)('PATCH', `/api/meals/entries/${entry.id}`, { meal_session_id: b });
  assert.strictEqual(r.status, 200, await r.text());

  const d = await day(me, today);
  const from = d.sessions.find(s => s.id === a), to = d.sessions.find(s => s.id === b);
  assert.strictEqual(from.entries.length, 0, 'it is still in the meal it left');
  assert.strictEqual(to.entries.length, 1, 'it did not arrive');
  // The meal it left is still standing. Deleting the last entry leaves the meal
  // too; a move that binned it would be the odd one out.
  assert.ok(from, 'the emptied meal was removed');
});

test('a food moves to another day, and the day totals follow it', async () => {
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  const src = await session(me, 'Dinner', today);
  const dst = await session(me, 'Dinner', yesterday);
  const { entry } = await logInto(me, src, 1, 200);
  const before = (await day(me, yesterday)).totals.calories;

  assert.strictEqual((await as(me)('PATCH', `/api/meals/entries/${entry.id}`, { meal_session_id: dst })).status, 200);

  const afterY = await day(me, yesterday);
  assert.strictEqual(afterY.sessions.find(s => s.id === dst).entries.length, 1);
  assert.ok(afterY.totals.calories > before, "yesterday's calories did not move with it");
});

test("a food cannot be moved into another profile's meal", async () => {
  const mine = await session(me, 'Snack', today);
  const theirs = await session(other, 'Theirs', today);
  const { entry } = await logInto(me, mine, 1, 50);
  const r = await as(me)('PATCH', `/api/meals/entries/${entry.id}`, { meal_session_id: theirs });
  assert.strictEqual(r.status, 404, 'it was filed into someone else’s day');
});

test('a patch that changes nothing is refused rather than silently accepted', async () => {
  const sid = await session(me, 'Empty patch', today);
  const { entry } = await logInto(me, sid, 1, 50);
  assert.strictEqual((await as(me)('PATCH', `/api/meals/entries/${entry.id}`, {})).status, 400);
});

test('moving a batch portion does not move batch stock', async () => {
  // Nothing new was eaten — the same grams are filed somewhere else. Resizing
  // is the operation that genuinely changes what came out of the pot.
  const batch = await json(await as(me)('POST', '/api/batches',
    { name: 'Chilli', cooked_g: 1000, items: [{ food_id: 1, quantity_g: 1000 }] }));
  const sid = await session(me, 'Batch meal', today);
  await as(me)('POST', `/api/batches/${batch.id}/portion`, { grams: 250, meal_session_id: sid, date: today });
  const left = (await json(await as(me)('GET', '/api/batches'))).find(b => b.id === batch.id).remaining_g;

  const d = await day(me, today);
  const portion = d.sessions.find(s => s.id === sid).entries[0];
  const dst = await session(me, 'Somewhere else', today);
  assert.strictEqual((await as(me)('PATCH', `/api/meals/entries/${portion.id}`, { meal_session_id: dst })).status, 200);

  const after = (await json(await as(me)('GET', '/api/batches'))).find(b => b.id === batch.id).remaining_g;
  assert.strictEqual(after, left, 'moving a portion changed how much is left in the pot');
});

test('resizing still works, and still moves batch stock', async () => {
  const batch = await json(await as(me)('POST', '/api/batches',
    { name: 'Stew', cooked_g: 1000, items: [{ food_id: 1, quantity_g: 1000 }] }));
  const sid = await session(me, 'Stew meal', today);
  await as(me)('POST', `/api/batches/${batch.id}/portion`, { grams: 300, meal_session_id: sid, date: today });
  const before = (await json(await as(me)('GET', '/api/batches'))).find(b => b.id === batch.id).remaining_g;
  const e = (await day(me, today)).sessions.find(s => s.id === sid).entries[0];

  assert.strictEqual((await as(me)('PATCH', `/api/meals/entries/${e.id}`, { quantity_g: 100 })).status, 200);
  const after = (await json(await as(me)('GET', '/api/batches'))).find(b => b.id === batch.id).remaining_g;
  assert.strictEqual(Math.round(after - before), 200, 'shrinking a portion did not hand the grams back');
});

// ── undoing a merge ─────────────────────────────────────────────────────────
test('merge hands back what it would take to put the meal back', async () => {
  const src = await session(me, 'Second breakfast', today);
  const dst = await session(me, 'First breakfast', today);
  await logInto(me, src, 1, 100);
  await logInto(me, src, 2, 60);
  const srcEntries = (await day(me, today)).sessions.find(s => s.id === src).entries.map(e => e.id).sort();

  const r = await json(await as(me)('POST', `/api/meals/sessions/${src}/merge`, { target_session_id: dst }));
  assert.strictEqual(r.merged, 2);
  assert.ok(r.undo, 'merge returned nothing to undo with');
  assert.deepStrictEqual(r.undo.entry_ids.slice().sort(), srcEntries, 'the moved entries were not reported');
  assert.strictEqual(r.undo.name, 'Second breakfast', 'the meal that stopped existing lost its name');
  assert.strictEqual(r.undo.date, today);

  // And that really is enough to reverse it, using only routes a client has.
  const back = await session(me, r.undo.name, r.undo.date);
  for (const id of r.undo.entry_ids) {
    assert.strictEqual((await as(me)('PATCH', `/api/meals/entries/${id}`, { meal_session_id: back })).status, 200);
  }
  const after = (await day(me, today)).sessions.find(s => s.id === back);
  assert.strictEqual(after.entries.length, 2, 'undo did not bring both foods back');
  assert.strictEqual(after.name, 'Second breakfast');
});

// ── eating half a leftover ──────────────────────────────────────────────────
async function makeLeftover(grams, left) {
  const sid = await session(me, 'Leftover source', today);
  const { entry } = await logInto(me, sid, 1, grams);
  await as(me)('POST', `/api/meals/entries/${entry.id}/leftover`, { left_g: left, to_batch: false });
  return newestLeftover();
}

// Highest id, not last in the list: the ordering of GET /api/leftovers is not
// part of its contract, and by the later tests there are several.
async function newestLeftover() {
  const list = await json(await as(me)('GET', '/api/leftovers'));
  return list.reduce((a, b) => (a && a.id > b.id ? a : b), null);
}

test('eating part of a leftover logs that part and puts the rest back', async () => {
  const l = await makeLeftover(400, 300);
  assert.strictEqual(Math.round(l.quantity_g), 300);

  const r = await json(await as(me)('POST', `/api/leftovers/${l.id}/log`, { date: today, eat_g: 100 }));
  assert.strictEqual(r.partial, true);
  assert.strictEqual(Math.round(r.remaining_g), 200);

  const still = (await json(await as(me)('GET', '/api/leftovers'))).find(x => x.id === l.id);
  assert.ok(still, 'the leftover was deleted even though some was left');
  assert.strictEqual(Math.round(still.quantity_g), 200);
  // Macros go with the share, not with the row.
  assert.ok(Math.abs(still.calories - l.calories * 2 / 3) < 2, 'the rest kept the whole calorie count');
});

test('eating the rest of it clears it away', async () => {
  const l = await makeLeftover(300, 200);
  await as(me)('POST', `/api/leftovers/${l.id}/log`, { date: today, eat_g: 50 });
  const r = await json(await as(me)('POST', `/api/leftovers/${l.id}/log`, { date: today, eat_g: 150 }));
  assert.strictEqual(r.partial, false);
  assert.ok(!(await json(await as(me)('GET', '/api/leftovers'))).some(x => x.id === l.id),
    'an emptied leftover is still in the fridge');
});

test('asking for more than is there eats the lot rather than erroring', async () => {
  const l = await makeLeftover(300, 200);
  const r = await json(await as(me)('POST', `/api/leftovers/${l.id}/log`, { date: today, eat_g: 5000 }));
  assert.strictEqual(r.partial, false);
  assert.ok(!(await json(await as(me)('GET', '/api/leftovers'))).some(x => x.id === l.id));
});

test('no amount still means all of it', async () => {
  const l = await makeLeftover(300, 200);
  const r = await json(await as(me)('POST', `/api/leftovers/${l.id}/log`, { date: today }));
  assert.strictEqual(r.partial, false);
  assert.strictEqual(Math.round(r.calories), Math.round(l.calories));
});

test('a nonsense amount is refused', async () => {
  const l = await makeLeftover(300, 200);
  for (const eat_g of [0, -50, 'half']) {
    assert.strictEqual((await as(me)('POST', `/api/leftovers/${l.id}/log`, { date: today, eat_g })).status, 400,
      `${eat_g} was accepted`);
  }
});

test('a leftover with no weight splits by energy instead', async () => {
  // A Quick Log has calories and no grams — the number you'd halve is the only
  // one it has.
  const sid = await session(me, 'Eaten out', today);
  const q = await json(await as(me)('POST', '/api/meals/log',
    { quick: { name: 'restaurant plate', calories_per_100g: 800 }, quantity_g: 100, session_id: sid }));
  await as(me)('POST', `/api/meals/entries/${q.entry.id}/leftover`, { left_kcal: 400 });
  const l = await newestLeftover();
  assert.strictEqual(l.quantity_g, null, 'a quick leftover should carry no weight');

  const r = await json(await as(me)('POST', `/api/leftovers/${l.id}/log`, { date: today, eat_kcal: 100 }));
  assert.strictEqual(r.partial, true);
  const still = (await json(await as(me)('GET', '/api/leftovers'))).find(x => x.id === l.id);
  assert.strictEqual(Math.round(still.calories), 300, 'the rest did not keep the right energy');
});

// "Eat all of it" must actually eat all of it.
//
// Reported from the phone: "Batch when use all of them. Still havw 0g left
// leftover". A leftover's weight is stored to one decimal (a 🥡 split writes
// round1), so it is routinely 333.3 g — while the log sheet prefills
// Math.round(quantity_g) for legibility. Accepting that prefilled default
// therefore asked for 333 of 333.3: a partial, leaving 0.3 g that the card
// renders through Math.round as "0 g". One tap of the button meaning "all of
// it" left a row claiming to hold nothing, clearable only by binning it.
//
// Fixed at both ends — the sheet now omits the amount when you accept the
// default, and the route treats any remainder too small to display as the
// whole thing. The route half is what protects a phone that has not taken the
// update yet, which is the case that produced the report.
test('accepting the prefilled amount clears the leftover completely', async () => {
  const api = as(me);
  for (const savedBack of [333.3, 128.4, 501.2]) {
    const food = await json(await api('POST', '/api/foods',
      { name: `Sliver ${savedBack}`, calories_per_100g: 100 }));
    const sess = await json(await api('POST', '/api/meals/sessions', { name: `Sliver ${savedBack}` }));
    const entry = await json(await api('POST', `/api/meals/sessions/${sess.id}/entries`,
      { food_id: food.id, quantity_g: 1000 }));
    const split = await json(await api('POST', `/api/meals/entries/${entry.id}/leftover`,
      { left_g: savedBack }));

    const before = (await json(await api('GET', '/api/leftovers')))
      .find(l => l.id === split.leftover_id);
    assert.strictEqual(before.quantity_g, savedBack, 'setup: the leftover kept its decimal');

    // Exactly what an un-updated client sends: the rounded display value.
    const r = await json(await api('POST', `/api/leftovers/${split.leftover_id}/log`,
      { eat_g: Math.round(before.quantity_g) }));
    assert.strictEqual(r.partial, false,
      `${Math.round(before.quantity_g)} of ${savedBack} was treated as a partial`);

    const after = (await json(await api('GET', '/api/leftovers')))
      .find(l => l.id === split.leftover_id);
    assert.ok(!after, `a ${savedBack - Math.round(savedBack)} g sliver survived and shows as "0 g"`);
  }
});

test('a remainder you can actually see is still a partial', async () => {
  // The boundary matters: this must not turn every near-complete portion into
  // "you ate the lot". 1 g is visible, so 1 g stays.
  const api = as(me);
  const food = await json(await api('POST', '/api/foods',
    { name: 'Visible sliver', calories_per_100g: 100 }));
  const sess = await json(await api('POST', '/api/meals/sessions', { name: 'Visible sliver' }));
  const entry = await json(await api('POST', `/api/meals/sessions/${sess.id}/entries`,
    { food_id: food.id, quantity_g: 1000 }));
  const split = await json(await api('POST', `/api/meals/entries/${entry.id}/leftover`, { left_g: 400 }));

  const r = await json(await api('POST', `/api/leftovers/${split.leftover_id}/log`, { eat_g: 399 }));
  assert.strictEqual(r.partial, true, 'eating 399 of 400 should leave 1 g');
  assert.strictEqual(r.remaining_g, 1);
});

// A replay has to be the SAME intent, and for a copy the destination is part
// of it.
//
// The copy sheet mints one client_id when it opens, and re-enables its
// destination buttons when a send fails so you can try again. Those two
// together make "pick Meal A, lose the response, pick Meal B instead" an
// ordinary sequence — and the guard was keyed on the route alone, so the
// second request replayed the first one's receipt. Reproduced before this
// test: Meal A held the food, Meal B held nothing, and the client showed
// "Merged into meal" about Meal B. A silent mis-file reported as a success,
// on a route that also draws batch stock for every food it copies.
test('copying to a different meal is not a replay of the first one', async () => {
  const api = as(me);
  const today = new Date().toISOString().slice(0, 10);
  const food = await json(await api('POST', '/api/foods',
    { name: 'Retarget rice', calories_per_100g: 100 }));
  const src = await json(await api('POST', '/api/meals/sessions', { name: 'Retarget source', date: today }));
  await api('POST', `/api/meals/sessions/${src.id}/entries`, { food_id: food.id, quantity_g: 200 });
  const A = await json(await api('POST', '/api/meals/sessions', { name: 'Retarget A', date: today }));
  const B = await json(await api('POST', '/api/meals/sessions', { name: 'Retarget B', date: today }));

  const cid = 'retarget00000000000000001';
  const first = await json(await api('POST', `/api/meals/sessions/${src.id}/copy`,
    { target_session_id: A.id, client_id: cid }));
  assert.strictEqual(first.session_id, A.id, 'setup: the first copy did not land on A');

  // Same id, different destination: a new intent, not a retry.
  const second = await json(await api('POST', `/api/meals/sessions/${src.id}/copy`,
    { target_session_id: B.id, client_id: cid }));
  assert.strictEqual(second.session_id, B.id,
    'the copy to B was answered with the receipt from A');

  const day = await json(await api('GET', `/api/meals/day/${today}`));
  const count = name => day.sessions.find(x => x.name === name)?.entries.length ?? -1;
  assert.strictEqual(count('Retarget A'), 1, 'A lost its copy');
  assert.strictEqual(count('Retarget B'), 1, 'B never got the copy it was told it got');
});

test('retrying the SAME copy still replays, which is the point', async () => {
  const api = as(me);
  const today = new Date().toISOString().slice(0, 10);
  const food = await json(await api('POST', '/api/foods',
    { name: 'Replay rice', calories_per_100g: 100 }));
  const src = await json(await api('POST', '/api/meals/sessions', { name: 'Replay source', date: today }));
  await api('POST', `/api/meals/sessions/${src.id}/entries`, { food_id: food.id, quantity_g: 200 });
  const T = await json(await api('POST', '/api/meals/sessions', { name: 'Replay target', date: today }));

  const cid = 'sameretry000000000000001';
  const body = { target_session_id: T.id, client_id: cid };
  await api('POST', `/api/meals/sessions/${src.id}/copy`, body);
  await api('POST', `/api/meals/sessions/${src.id}/copy`, body);

  const day = await json(await api('GET', `/api/meals/day/${today}`));
  assert.strictEqual(day.sessions.find(x => x.name === 'Replay target').entries.length, 1,
    'the retry logged the meal twice');
});

// Same rule, same reason, one route over: the single-food copy addresses its
// destination by URL.
test('copying one food to a different meal is not a replay either', async () => {
  const api = as(me);
  const today = new Date().toISOString().slice(0, 10);
  const food = await json(await api('POST', '/api/foods',
    { name: 'Entry retarget rice', calories_per_100g: 100 }));
  const A = await json(await api('POST', '/api/meals/sessions', { name: 'Entry A', date: today }));
  const B = await json(await api('POST', '/api/meals/sessions', { name: 'Entry B', date: today }));

  const cid = 'entryretarget00000000001';
  await api('POST', `/api/meals/sessions/${A.id}/entries`,
    { food_id: food.id, quantity_g: 150, client_id: cid });
  await api('POST', `/api/meals/sessions/${B.id}/entries`,
    { food_id: food.id, quantity_g: 150, client_id: cid });

  const day = await json(await api('GET', `/api/meals/day/${today}`));
  const count = name => day.sessions.find(x => x.name === name)?.entries.length ?? -1;
  assert.strictEqual(count('Entry A'), 1);
  assert.strictEqual(count('Entry B'), 1, 'the second meal was told it got a food it never got');
});
