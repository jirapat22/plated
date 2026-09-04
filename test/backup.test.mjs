// The backup round trip, which nothing has ever checked end to end.
//
// A backup is only worth what it restores. The export route has grown a long
// list of things that were once missing from it — batches, goal history, waist
// readings, "I ate light" confirmations, leftovers, the food stats behind
// recent-foods — each found the same way: something was deleted, restored, and
// quietly did not come back. Every one of those was a comment added after the
// fact. This is the check that would have caught them as a class.
//
// Method: build a profile with one of everything, export, restore over the top,
// export again, and compare what the two files SAY rather than their row ids —
// import remaps every id, so identity is the wrong thing to compare.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-backup-'));
const DAY1 = '2026-08-30', DAY2 = '2026-08-31';
let child, alice, bob, firstExport;

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
  return { id: b.profile.id, token: b.token, name };
}

// What a backup MEANS, with every id stripped out. Two exports that agree on
// this restored the same day, whatever row numbers they landed on.
function meaning(x) {
  const foodName = new Map(x.foods.map(f => [f.id, `${f.name}|${f.brand ?? ''}`]));
  const sessionDate = new Map(x.meal_sessions.map(s => [s.id, `${s.date}|${s.meal_type ?? s.name ?? ''}`]));
  return {
    entries: x.meal_entries
      .map(e => `${sessionDate.get(e.meal_session_id)}|${foodName.get(e.food_id)}|${e.quantity_g}|${e.calories ?? 'null'}`)
      .sort(),
    sessions: x.meal_sessions.map(s => `${s.date}|${s.meal_type ?? s.name ?? ''}`).sort(),
    weight: x.weight_log.map(w => `${w.date}|${w.weight_kg}`).sort(),
    measurements: (x.measurements || []).map(m => `${m.date}|${m.waist_cm}`).sort(),
    overrides: (x.daily_overrides || []).map(o => `${o.date}|${o.key}|${o.value}`).sort(),
    goals: (x.goal_history || []).map(g => `${g.effective_from}|${g.calorie_goal}`).sort(),
    batches: (x.batches || []).map(b => `${b.name}|${b.cooked_g}|${b.remaining_g}`).sort(),
    leftovers: (x.leftovers || []).map(l => `${l.name}|${l.grams ?? l.quantity_g ?? ''}`).sort(),
    foods: x.foods.map(f => `${f.name}|${f.brand ?? ''}|${f.calories_per_100g}`).sort(),
    stats: (x.food_stats || []).map(s => `${foodName.get(s.food_id) ?? s.food_id}|${s.use_count}|${s.last_qty_g}`).sort(),
    settings: x.settings,
  };
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
  alice = await makeProfile('BACKUPA', '1470');
  bob   = await makeProfile('BACKUPB', '2581');
  const A = as(alice);

  // One of everything the export claims to carry.
  await A('PATCH', '/api/settings', { calorie_goal: 2100, protein_goal: 150, phase: 'cut', cut_deficit: 400 });
  await A('POST', '/api/meals/log', { date: DAY1, meal_type: 'lunch',  food_id: 1, quantity_g: 200 });
  await A('POST', '/api/meals/log', { date: DAY1, meal_type: 'dinner', food_id: 2, quantity_g: 150 });
  await A('POST', '/api/meals/log', { date: DAY2, meal_type: 'lunch',  food_id: 1, quantity_g: 120 });
  await A('POST', '/api/weight', { date: DAY1, weight_kg: 71.2 });
  await A('POST', '/api/weight', { date: DAY2, weight_kg: 70.9 });
  await A('POST', '/api/measurements', { date: DAY1, waist_cm: 82.5 });
  await A('POST', '/api/meals/log-status', { date: DAY2, status: 'light' });   // "I ate light"
  const batch = await (await A('POST', '/api/batches', {
    name: 'Backup chilli', cooked_g: 900, items: [{ food_id: 1, quantity_g: 900 }],
  })).json();
  assert.ok(batch.id, `batch not created: ${JSON.stringify(batch)}`);
  await A('POST', `/api/batches/${batch.id}/portion`, { grams: 300 });

  firstExport = await (await A('GET', '/api/settings/export')).json();
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

test('the export carries every table it claims to', async () => {
  // A missing KEY is the failure mode this whole file exists for: each of these
  // was absent once, and each absence was only found after someone lost data.
  for (const key of ['foods', 'batches', 'leftovers', 'meal_sessions', 'meal_entries',
                     'weight_log', 'goal_history', 'measurements', 'daily_overrides',
                     'food_stats', 'settings', 'exported_at']) {
    assert.ok(key in firstExport, `export is missing ${key}`);
  }
  const m = meaning(firstExport);
  assert.strictEqual(m.entries.length, 4, `expected 3 meals + 1 batch portion, got ${m.entries}`);
  assert.deepStrictEqual(m.weight, ['2026-08-30|71.2', '2026-08-31|70.9'].sort());
  assert.deepStrictEqual(m.measurements, ['2026-08-30|82.5']);
  assert.deepStrictEqual(m.overrides, ['2026-08-31|log_status|light']);
  assert.strictEqual(m.batches.length, 1, 'the batch did not make it into the file');
  assert.ok(m.goals.length > 0, 'goal history is empty — past days lose what they were judged against');
});

test('restoring over yourself reproduces the day exactly, and only once', async () => {
  // The duplication trap: import must REPLACE this profile's history. If it
  // appended, every restore would double the day and the totals with it.
  const r = await as(alice)('POST', '/api/settings/import', firstExport);
  const result = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(result));

  const second = await (await as(alice)('GET', '/api/settings/export')).json();
  assert.deepStrictEqual(meaning(second), meaning(firstExport));
});

test('a second restore of the same file changes nothing again', async () => {
  // Idempotence: people re-run a restore when they are not sure the first
  // worked. That must be safe.
  await as(alice)('POST', '/api/settings/import', firstExport);
  const third = await (await as(alice)('GET', '/api/settings/export')).json();
  assert.deepStrictEqual(meaning(third), meaning(firstExport));
});

test('restoring onto a different profile moves the whole day across', async () => {
  // The reason the feature exists: a new phone, or a profile rebuilt after a
  // reset. Bob starts empty and must end up holding Alice's day.
  const before = meaning(await (await as(bob)('GET', '/api/settings/export')).json());
  assert.deepStrictEqual(before.entries, [], 'the fresh profile was not empty');

  const r = await as(bob)('POST', '/api/settings/import', firstExport);
  assert.strictEqual(r.status, 200, await r.text());

  const after = meaning(await (await as(bob)('GET', '/api/settings/export')).json());
  const want = meaning(firstExport);
  for (const key of ['entries', 'sessions', 'weight', 'measurements', 'overrides', 'batches']) {
    assert.deepStrictEqual(after[key], want[key], `${key} did not cross to the other profile`);
  }
  // And Alice still has her own copy — a restore is not a move.
  const alicesStill = meaning(await (await as(alice)('GET', '/api/settings/export')).json());
  assert.deepStrictEqual(alicesStill.entries, want.entries, "the source profile's data was disturbed");
});

test('a restore does not reach into another profile', async () => {
  // Bob importing must never touch Alice, and the foods table is shared — the
  // one place a careless import could write across the boundary.
  const day = await (await as(alice)('GET', `/api/meals/day/${DAY1}`)).json();
  assert.ok(day.sessions.length >= 2, 'Alice lost meals when Bob restored');
});

test('a file that is not an export is refused', async () => {
  for (const junk of [{}, { exported_at: 'now' }, { meal_sessions: [] }, { exported_at: 'x', meal_sessions: 'no' }]) {
    const r = await as(bob)('POST', '/api/settings/import', junk);
    assert.strictEqual(r.status, 400, `accepted ${JSON.stringify(junk)}`);
  }
});
