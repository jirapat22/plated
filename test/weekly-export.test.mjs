// GET /api/orbit/weekly-export — the weekly vault backup the GitHub Action in
// jirapat22/orbit-vault pulls every Sunday night. Real server as a child
// process on a throwaway DATA_DIR (same harness as http.test.mjs), with a real
// ORBIT_API_KEY, so the key gate and the route wiring are both exercised.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-orbit-key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-weekly-'));
let child;
const users = {};

const call = (method, p, body, tok) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const weekly = (q, key = KEY) => fetch(`${BASE}/api/orbit/weekly-export?${q}`, { headers: key ? { 'X-API-Key': key } : {} });

async function makeUser(name, passcode) {
  const r = await (await call('POST', '/api/auth/profiles', { name, passcode })).json();
  assert.ok(r.token, `could not create ${name}`);
  return { token: r.token, id: r.profile?.id ?? r.id };
}

before(async () => {
  child = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: 'test', ORBIT_API_KEY: KEY },
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..'),
    stdio: 'ignore',
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await fetch(BASE + '/'); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  users.pat = await makeUser('WEEKPAT', '4418');
  users.other = await makeUser('WEEKOTHER', '4419');
  const T = users.pat.token;
  await call('PATCH', '/api/settings', { calorie_goal: 2000, protein_goal: 150 }, T);
  // Week of Mon 12 Oct – Sun 18 Oct 2026: three days logged.
  for (const date of ['2026-10-12', '2026-10-13', '2026-10-15']) {
    const r = await call('POST', '/api/meals/log', { food_id: 1, quantity_g: 300, date, meal_name: 'Lunch' }, T);
    assert.strictEqual(r.status, 201, `log ${date}`);
  }
  // Outside the week (both sides) and another profile in the week — must not count.
  await call('POST', '/api/meals/log', { food_id: 1, quantity_g: 900, date: '2026-10-11', meal_name: 'Lunch' }, T);
  await call('POST', '/api/meals/log', { food_id: 1, quantity_g: 900, date: '2026-10-19', meal_name: 'Lunch' }, T);
  await call('POST', '/api/meals/log', { food_id: 1, quantity_g: 900, date: '2026-10-13', meal_name: 'Lunch' }, users.other.token);
  await call('POST', '/api/weight', { weight_kg: 80.2, date: '2026-10-14' }, T);
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

const Q = () => `profile_id=${users.pat.id}&from=2026-10-12&to=2026-10-18&week=2026-W42`;

test('rejects a request without the Orbit API key', async () => {
  assert.strictEqual((await weekly(Q(), null)).status, 401);
  assert.strictEqual((await weekly(Q(), 'wrong-key')).status, 401);
});

test('validates profile and dates', async () => {
  assert.strictEqual((await weekly('from=2026-10-12&to=2026-10-18')).status, 400);
  assert.strictEqual((await weekly(`profile_id=${users.pat.id}&from=2026-10-18&to=2026-10-12`)).status, 400);
  assert.strictEqual((await weekly(`profile_id=${users.pat.id}&from=2026-02-30&to=2026-10-18`)).status, 400);
  assert.strictEqual((await weekly('profile_id=99999&from=2026-10-12&to=2026-10-18')).status, 404);
});

test('summarises only this profile and this week', async () => {
  const r = await weekly(Q());
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.summary.daysInRange, 7);
  assert.strictEqual(body.summary.daysLogged, 3);
  // Same 300 g of the same food each day → the average equals one day's total,
  // which would be inflated by the 900 g days outside the window or the other
  // profile's entry if either leaked in.
  assert.ok(body.summary.avg.calories > 0);
  const oneDay = await (await weekly(`profile_id=${users.pat.id}&from=2026-10-12&to=2026-10-12`)).json();
  assert.strictEqual(body.summary.avg.calories, oneDay.summary.avg.calories);
  assert.strictEqual(body.summary.goals.calories, 2000);
});

test('returns a readable note, a CSV and the full backup payload', async () => {
  const body = await (await weekly(Q())).json();
  assert.match(body.markdown, /^# 🥗 Plated: week 2026-W42/);
  assert.match(body.markdown, /Days logged \| 3 of 7/);
  assert.ok(typeof body.csv === 'string' && body.csv.includes('2026-10-15'));
  assert.ok(!body.csv.includes('2026-10-19'), 'a day after the week leaked into the CSV');
  assert.ok(body.full && typeof body.full === 'object' && body.full.exported_at);
});
