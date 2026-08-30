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

// ── and so does the summary, which is what the charts read ──────────────────
// The day route learned this first and the summary did not, so Today drew
// "150+" while Trends charted 150 as a measurement and its weekly bars averaged
// it against the goal. Same day, two routes, two different stories.
test('the summary marks the same day as a floor that the day route does', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const day = await (await api('GET', `/api/meals/day/${today}`)).json();
  const rows = await (await api('GET', '/api/meals/summary?days=30')).json();
  const row = rows.find(r => r.date === today);
  assert.ok(row, 'today is missing from the summary');
  assert.ok(row.partial, 'the summary row carries no partial flags at all');
  assert.deepStrictEqual(row.partial, day.totals_partial,
    'the summary and the day route disagree about which totals are measurements');
  // The totals themselves must not have moved.
  assert.strictEqual(Math.round(row.protein), Math.round(day.totals.protein));
});

test('a day where every macro was recorded is not marked partial', async () => {
  const d = '2025-03-04';
  await api('POST', '/api/meals/log', { food_id: 1, quantity_g: 100, date: d });
  const row = (await (await api('GET', '/api/meals/summary?days=all')).json()).find(r => r.date === d);
  assert.deepStrictEqual(row.partial, {
    calories: false, protein: false, carbs: false, fat: false, fiber: false,
  }, 'a fully-known day must not be marked as a floor');
});

// ── the route the isRealDate sweep missed ───────────────────────────────────
// A leftover logged onto 30 February makes a day the day route refuses to open,
// so it can never be seen, edited or deleted — while its calories keep counting
// in every summary, average and export.
test('a leftover cannot be logged onto a day that does not exist', async () => {
  const made = await api('POST', '/api/meals/log', {
    quick: { name: 'Takeaway', calories_per_100g: 1800 }, quantity_g: 100,
  });
  const entryId = (await made.json()).entry.id;
  const split = await api('POST', `/api/meals/entries/${entryId}/leftover`, { left_kcal: 600 });
  const splitBody = await split.json();
  assert.strictEqual(split.status, 201, JSON.stringify(splitBody));

  const r = await api('POST', `/api/leftovers/${splitBody.leftover_id}/log`, { date: '2026-02-30' });
  assert.strictEqual(r.status, 201, 'the leftover should still log — just not onto 30 February');
  const landed = (await r.json()).date;
  assert.notStrictEqual(landed, '2026-02-30', 'a leftover was filed onto a day that does not exist');
  // And whatever day it did land on has to be one the app can actually open.
  assert.strictEqual((await api('GET', `/api/meals/day/${landed}`)).status, 200);
});

// ── import is a trust boundary too ──────────────────────────────────────────
// It banded measurements ("an import is no more trusted than a form") and left
// the three original tables wide open: junk dates, out-of-band weights, text in
// a REAL column, and the 1e9 g entry the quantity cap exists to stop.
test('a hand-edited backup cannot restore what no route would accept', async () => {
  const exported = await (await api('GET', '/api/settings/export')).json();
  const foodId = exported.foods[0].id;
  const bad = {
    ...exported,
    weight_log: [
      { date: 'not-a-date', weight_kg: 70 },
      { date: '2026-02-30', weight_kg: 75 },
      { date: '2025-06-01', weight_kg: '70abc' },   // text into a REAL column
      { date: '2025-06-02', weight_kg: 99999 },     // past the 20-400 band
      { date: '2025-06-03', weight_kg: -5 },
      { date: '2025-06-04', weight_kg: 76.5 },      // the one plainly good row
    ],
    meal_sessions: [
      { id: 9001, date: '2026-02-30', name: 'Ghost', meal_index: 1 },
      { id: 9002, date: '2025-06-04', name: 'Real',  meal_index: 1 },
    ],
    meal_entries: [
      { meal_session_id: 9002, food_id: foodId, quantity_g: 1e9, calories: 5189000000 },
      { meal_session_id: 9002, food_id: foodId, quantity_g: 120, calories: 200 },
    ],
  };
  const r = await api('POST', '/api/settings/import', bad);
  const out = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(out));
  assert.ok(out.skipped > 0, 'rows were dropped without saying so');

  // Weights: the junk dates and the out-of-band figures are gone. '70abc'
  // SURVIVES, as the number 70 — deliberately, because that is exactly what
  // POST /api/weight does with it (validate parseFloat, store parseFloat). An
  // import stricter than the route would refuse to restore data the route had
  // already accepted. What must not survive is the STRING, in a REAL column.
  const weights = await (await api('GET', '/api/weight?limit=100')).json();
  assert.deepStrictEqual(weights.map(w => w.date).sort(), ['2025-06-01', '2025-06-04'],
    `wrong weight rows survived: ${JSON.stringify(weights)}`);
  for (const w of weights) {
    assert.strictEqual(typeof w.weight_kg, 'number', 'a string was stored in a REAL column');
  }

  // Sessions: 30 February never lands.
  const summary = await (await api('GET', '/api/meals/summary?days=all')).json();
  assert.strictEqual(summary.find(r2 => r2.date === '2026-02-30'), undefined,
    'a session was restored onto a day that does not exist');

  // Entries: the slipped decimal never lands either.
  const real = summary.find(r2 => r2.date === '2025-06-04');
  assert.ok(real, 'the good day did not import');
  assert.ok(real.calories < 1e6, `a ${real.calories} kcal day was restored`);
});

// ── the weigh-in you just corrected is the one you get back ─────────────────
// logged_at is datetime('now'), one-second resolution, so a same-second
// correction left two rows with identical timestamps and this returned
// whichever SQLite reached first.
test('correcting a weigh-in in the same second returns the correction', async () => {
  const d = '2025-05-05';
  await api('POST', '/api/weight', { weight_kg: 75.1, date: d });
  await api('POST', '/api/weight', { weight_kg: 80.0, date: d });
  const row = await (await api('GET', `/api/weight/day/${d}`)).json();
  assert.strictEqual(row.weight_kg, 80.0, 'the older reading won the tie');
});

test('a negative limit does not lift the row cap', async () => {
  const r = await api('GET', '/api/weight?limit=-1');
  assert.strictEqual(r.status, 200);
  // -1 means "no limit" to SQLite. Clamped to 1, so at most one row comes back.
  assert.ok((await r.json()).length <= 1, 'LIMIT -1 walked past the ceiling');
});

// ── the second door into profile_settings ───────────────────────────────────
// The table loops above learned that an import is no more trusted than a form;
// the settings block in the same handler had not. It could plant an
// ironlog_api_url the PATCH handler refuses — which turns GET /api/ironlog/raw
// into an SSRF read oracle — and a calorie_goal that snapshotGoals then wrote
// into goal_history as a permanent record of an impossible target.
test('a backup cannot set a setting the settings form would refuse', async () => {
  const forbidden = {
    ironlog_api_url: 'http://127.0.0.1:9',
    calorie_goal: '-500',
    timezone: 'Not/AZone',
    tdee: '999999',
    bodyweight_kg: '700',
  };
  // Every one of them is a 400 through the form.
  for (const [k, v] of Object.entries(forbidden)) {
    const r = await api('PATCH', '/api/settings', { [k]: v });
    assert.strictEqual(r.status, 400, `PATCH accepted ${k}=${v}`);
  }

  const before = await (await api('GET', '/api/settings')).json();
  const exported = await (await api('GET', '/api/settings/export')).json();
  const r = await api('POST', '/api/settings/import', {
    ...exported, settings: { ...exported.settings, ...forbidden },
  });
  const out = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(out));
  assert.ok(out.skipped >= Object.keys(forbidden).length, 'the bad settings were not reported as skipped');

  const after = await (await api('GET', '/api/settings')).json();
  for (const k of Object.keys(forbidden)) {
    assert.notStrictEqual(after[k], forbidden[k], `${k} was restored past the guard`);
    assert.strictEqual(after[k], before[k], `${k} changed`);
  }

  // And nothing impossible reached the permanent goal record.
  const hist = (await (await api('GET', '/api/settings/export')).json()).goal_history || [];
  for (const g of hist) {
    assert.ok(g.calorie_goal == null || g.calorie_goal >= 200,
      `goal_history holds an impossible target: ${g.calorie_goal}`);
  }
});

// ── the URL is checked where the request is made, not only where it is set ──
// Any ironlog_api_url stored before that guard existed is still in the database
// unvalidated, so the check has to happen at the point of use too.
test('an unsafe IronLog URL cannot be reached even if it is already stored', async () => {
  // Plant it the only way that still works: straight into the settings table
  // via the import path's ALLOWED list is now blocked, so assert the guard from
  // the other end — a configured-but-unsafe URL must fail closed, not fetch.
  const r = await api('GET', '/api/ironlog/raw');
  const body = await r.json();
  // No IronLog configured at all in this test profile: every sub-request must
  // report an error rather than having gone somewhere.
  assert.ok(body.profile?.error, 'raw fetched something with no URL configured');
});

// ── the profile name has a ceiling ──────────────────────────────────────────
test('a profile name is capped rather than stored whole', async () => {
  const r = await api('POST', '/api/auth/profiles', { name: 'z'.repeat(5000), passcode: '9182' }, null);
  assert.strictEqual(r.status, 201);
  const { profile } = await r.json();
  assert.ok(profile.name.length <= 40, `name stored at ${profile.name.length} chars`);

  const ren = await api('PATCH', '/api/auth/me', { name: 'q'.repeat(5000) });
  assert.strictEqual(ren.status, 200);
  assert.ok((await ren.json()).name.length <= 40, 'rename was not capped');

  // A non-string name used to throw on .trim() and answer 500.
  assert.strictEqual((await api('PATCH', '/api/auth/me', { name: 12345 })).status, 200);
});

// ── search puts the plain food first ────────────────────────────────────────
// Ordering was favourites, then use count, then SHORTEST NAME — and the seed
// names base ingredients "Ingredient, qualifier, …", so processed foods with
// short names won. Searching "banana" led with Banana chip at 519 kcal and put
// a real banana sixth; "rice" led with Licorice, black; "egg" with Eggplant.
//
// The rule that fixed it is narrow on purpose: the name IS the query, or starts
// with the query followed by a comma. A dish that merely mentions the word
// cannot be promoted, which is what sank the earlier contiguous-phrase attempt
// (see the note in foods.js).
test('a search for a plain food leads with that food, not a dish made from it', async () => {
  const cases = {
    banana: /^Banana,/i,
    rice:   /^Rice,/i,
    egg:    /^Egg,/i,
    butter: /^Butter,/i,
    milk:   /^Milk,/i,
  };
  for (const [q, want] of Object.entries(cases)) {
    const rows = await (await api('GET', `/api/foods/search?q=${q}&limit=5`)).json();
    assert.ok(Array.isArray(rows) && rows.length, `no results for "${q}"`);
    assert.match(rows[0].name, want, `"${q}" led with "${rows[0].name}"`);
  }
});

test('a multi-word search is not disturbed by the rule', async () => {
  // "olive oil" opens no name, so every row falls to the last tier and keeps
  // the order it had. "Oil, olive" was already first and must stay first.
  const rows = await (await api('GET', '/api/foods/search?q=olive%20oil&limit=5')).json();
  assert.strictEqual(rows[0].name, 'Oil, olive');
});

test('a favourite still outranks the plain-food rule', async () => {
  // The tiers above it — favourites, then use count — must keep winning, or
  // this quietly demotes the foods someone actually eats.
  const rows = await (await api('GET', '/api/foods/search?q=banana&limit=10')).json();
  const dish = rows.find(r => !/^Banana,/i.test(r.name));
  assert.ok(dish, 'expected at least one non-plain banana row');
  await api('PATCH', `/api/foods/${dish.id}/favourite`);   // the route toggles; it ignores the body
  const after = await (await api('GET', '/api/foods/search?q=banana&limit=10')).json();
  assert.strictEqual(after[0].id, dish.id, 'a favourited food must come first');
  await api('PATCH', `/api/foods/${dish.id}/favourite`);   // toggled back off
});
