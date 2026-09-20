// Restoring a backup must not hand your meals to someone else's food.
//
// Import matches foods by name+brand and reuses the match instead of inserting
// a duplicate, which is right for a shared catalogue: two people who each typed
// "Chicken breast" should end up on one row. It is wrong for the three sources
// that are not catalogue entries at all. 'batch' and 'leftover' were already
// excluded — a batch's backing food belongs to that one batch — and 'quick' was
// not, even though a Quick Log is the most personal row in the table: the free
// text you typed for a meal you couldn't weigh, minted fresh every time and
// deliberately never deduped by the route that creates it.
//
// What that cost, measured on two profiles who had each quick-logged "Toast
// with jam" at different calories: restoring the second profile's OWN backup
// repointed its entry at the FIRST profile's food. The entry still read 410
// while the food behind it said 210 per 100 g, so
//
//   * pressing Update in the edit sheet WITHOUT CHANGING ANYTHING rewrote the
//     entry to 210 — half the meal gone, silently, from a no-op edit;
//   * deleting it and tapping Undo failed with 404 "Food not found", because
//     the food now belongs to someone else and the privacy gate correctly
//     refuses it. The meal was unrecoverable.
//
// Nothing on screen said any of this had happened.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-imp-'));
const SHARED_WORDS = 'Toast with jam';
let child, mum, pat;

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
  mum = await makeProfile('IMPMUM', '6601');
  pat = await makeProfile('IMPPAT', '6602');
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows holds the file */ }
});

test('restoring a backup keeps your Quick Logs pointing at YOUR food', async () => {
  // Two people describe the same breakfast the same way, at different sizes.
  // Ordinary: "toast with jam" is not a distinguishing name.
  const mumLog = await json(await as(mum)('POST', '/api/meals/log', {
    quick: { name: SHARED_WORDS, calories_per_100g: 210 }, quantity_g: 100, meal_name: 'Breakfast',
  }));
  const patLog = await json(await as(pat)('POST', '/api/meals/log', {
    quick: { name: SHARED_WORDS, calories_per_100g: 410 }, quantity_g: 100, meal_name: 'Breakfast',
  }));
  const mumFood = mumLog.entry.food_id;
  const patFood = patLog.entry.food_id;
  assert.notStrictEqual(mumFood, patFood, 'the two Quick Logs shared a row before any import ran');

  // PAT backs up and restores their own data. Nothing about this involves MUM.
  const backup = await json(await as(pat)('GET', '/api/settings/export'));
  const restored = await as(pat)('POST', '/api/settings/import', backup);
  assert.strictEqual(restored.status, 200, JSON.stringify(await restored.json()));

  const day = await json(await as(pat)('GET', `/api/meals/day/${patLog.date}`));
  const entry = day.sessions.flatMap(s => s.entries).find(e => e.food_name === SHARED_WORDS);
  assert.ok(entry, 'the restored breakfast is missing entirely');

  assert.notStrictEqual(entry.food_id, mumFood,
    "the restore pointed PAT's breakfast at MUM's private food");

  // The entry and the food behind it have to agree, or a no-op edit rewrites
  // the meal. This is the assertion that actually catches the damage: the
  // density is what any later recompute will use.
  assert.strictEqual(entry.calories_per_100g, 410,
    `entry says ${entry.calories} kcal but its food says ${entry.calories_per_100g}/100g`);
});

test('a restored Quick Log can still be edited and undeleted', async () => {
  // The two things that broke downstream, exercised end to end rather than
  // asserted about ids.
  const day = await json(await as(pat)('GET', `/api/meals/day/${new Date().toISOString().slice(0, 10)}`));
  const entry = day.sessions.flatMap(s => s.entries).find(e => e.food_name === SHARED_WORDS);
  assert.ok(entry, 'nothing to edit');

  // A no-op resize: same grams in, same calories out. It used to halve the meal.
  const edited = await json(await as(pat)('PATCH', `/api/meals/entries/${entry.id}`, {
    quantity_g: entry.quantity_g,
  }));
  assert.strictEqual(edited.calories, entry.calories,
    'pressing Update without changing anything changed the calories');

  // Delete, then the Undo path: re-add the same food to the same meal.
  await as(pat)('DELETE', `/api/meals/entries/${entry.id}`);
  const undo = await as(pat)('POST', `/api/meals/sessions/${entry.meal_session_id}/entries`, {
    food_id: entry.food_id, quantity_g: entry.quantity_g,
  });
  assert.strictEqual(undo.status, 201,
    `Undo could not put the meal back: ${JSON.stringify(await undo.json())}`);
});

test("the privacy gate is still the reason it matters", async () => {
  // Belt and braces on the rule the fix relies on: even now, PAT cannot reach
  // MUM's quick food directly. If this ever stops being true the test above
  // stops meaning anything.
  const mumLog = await json(await as(mum)('POST', '/api/meals/log', {
    quick: { name: 'Hospital canteen soup', calories_per_100g: 300 }, quantity_g: 100,
  }));
  const peek = await as(pat)('GET', `/api/foods/${mumLog.entry.food_id}`);
  assert.strictEqual(peek.status, 404);
});

// Restoring twice must not grow the foods table.
//
// A restore deliberately re-inserts the three private sources rather than
// matching them by name — two pots called "Chilli" must not merge — so each one
// leaves the PREVIOUS restore's row behind with nothing referencing it. The
// sweep that collects those named only 'leftover', so a quick food and a batch
// food leaked on every restore: measured at exactly 2 permanent orphans per
// import, unbounded, on a table every profile shares.
//
// Counted straight out of the database, because an orphan is invisible over
// HTTP by construction: the export carries only foods you logged, and the
// private sources are excluded from every list route. That invisibility is
// exactly why this went unnoticed.
test('restoring twice leaves no orphan foods behind', async () => {
  const mine = as(pat);
  await mine('POST', '/api/meals/log', {
    quick: { name: 'Orphan check takeaway', calories_per_100g: 700 }, quantity_g: 100,
  });
  const base = await json(await mine('POST', '/api/foods',
    { name: 'Orphan check rice', calories_per_100g: 100 }));
  await mine('POST', '/api/batches',
    { name: 'Orphan check pot', cooked_g: 500, items: [{ food_id: base.id, quantity_g: 500 }] });

  const db = new DatabaseSync(`file:${path.join(dataDir, 'plated.db')}?mode=ro`, { readOnly: true });
  const orphans = () => db.prepare(`
    SELECT COUNT(*) AS c FROM foods f
    WHERE f.created_by_profile = $p
      AND f.source IN ('quick', 'batch', 'leftover')
      AND NOT EXISTS (SELECT 1 FROM meal_entries WHERE food_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM leftovers    WHERE food_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM batches      WHERE food_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM preset_items WHERE food_id = f.id)
  `).get({ p: pat.id }).c;

  try {
    // Growth, not an absolute — the tests above this one already restore, so
    // under the old code the count starts non-zero. What must never happen is
    // that it climbs with each restore.
    const baseline = orphans();
    const backup = await json(await mine('GET', '/api/settings/export'));

    await mine('POST', '/api/settings/import', backup);
    const afterOne = orphans();
    assert.strictEqual(afterOne, baseline,
      `one restore orphaned ${afterOne - baseline} private food(s)`);

    await mine('POST', '/api/settings/import', backup);
    const afterTwo = orphans();
    assert.strictEqual(afterTwo, baseline,
      `restores accumulate orphans: ${baseline} -> ${afterOne} -> ${afterTwo}`);
  } finally {
    db.close();
  }
});
