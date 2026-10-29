// /api/io — the gate I.O. (Pat's Discord assistant) logs meals through.
// Real server as a child process on a throwaway DATA_DIR (same harness as
// http.test.mjs), so the key check, the allowlist and the profile pinning are
// exercised exactly as production wires them.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-io-key-0123456789';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-io-'));
let child, patToken, otherToken;

const call = (method, p, body, headers = {}) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const io = (method, p, body) => call(method, p, body, { 'x-io-key': KEY });

before(async () => {
  child = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    // Profile 1 is the first one created below, the same way PAT is profile 1 in production.
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: 'test', IO_API_KEY: KEY, IO_PROFILE_ID: '1' },
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..'),
    stdio: 'ignore',
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await fetch(BASE + '/'); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  patToken = (await (await call('POST', '/api/auth/profiles', { name: 'IOPAT', passcode: '4419' })).json()).token;
  otherToken = (await (await call('POST', '/api/auth/profiles', { name: 'IOOTHER', passcode: '4420' })).json()).token;
  assert.ok(patToken && otherToken, 'could not create test profiles');
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const meal = { quick: { name: 'Pork & kimchi bowl (photo)', calories_per_100g: 750, protein_per_100g: 35 }, quantity_g: 100 };

test('no key, or a wrong key, gets nothing', async () => {
  assert.strictEqual((await call('POST', '/api/io/meals/log', meal)).status, 401);
  assert.strictEqual((await call('POST', '/api/io/meals/log', meal, { 'x-io-key': 'nope' })).status, 401);
  // A person's session token is not an I.O. key either.
  assert.strictEqual((await call('POST', '/api/io/meals/log', meal, { Authorization: `Bearer ${patToken}` })).status, 401);
});

test('a quick log lands on the pinned profile only', async () => {
  const r = await io('POST', '/api/io/meals/log', { ...meal, meal_name: 'Lunch' });
  assert.strictEqual(r.status, 201);
  const body = await r.json();
  assert.strictEqual(body.entry.calories, 750);

  const mine = await (await call('GET', `/api/meals/day/${today()}`, undefined, { Authorization: `Bearer ${patToken}` })).json();
  assert.strictEqual(mine.sessions.length, 1);
  assert.strictEqual(mine.sessions[0].name, 'Lunch');
  const theirs = await (await call('GET', `/api/meals/day/${today()}`, undefined, { Authorization: `Bearer ${otherToken}` })).json();
  assert.strictEqual(theirs.sessions.length, 0, 'I.O. wrote into someone else\'s day');
});

test('I.O. can read its own day back, but not someone else\'s', async () => {
  const r = await io('GET', `/api/io/meals/day/${today()}`);
  assert.strictEqual(r.status, 200);
  assert.ok((await r.json()).totals.calories >= 750);
  assert.strictEqual((await io('GET', `/api/io/meals/day/${today()}?profile=2`)).status, 400);
});

test('a label becomes a library food that can then be logged by weight', async () => {
  const f = await io('POST', '/api/io/foods', { name: 'Test granola', brand: 'Label', calories_per_100g: 418, protein_per_100g: 5.5, serving_size_g: 55 });
  assert.strictEqual(f.status, 201);
  const food = await f.json();
  const r = await io('POST', '/api/io/meals/log', { food_id: food.id, quantity_g: 55 });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await r.json()).entry.calories, 229.9);
});

test('everything outside the allowlist is closed', async () => {
  for (const [m, p] of [
    ['GET', '/api/io/meals/summary'],
    ['DELETE', '/api/io/meals/sessions/1'],
    ['GET', '/api/io/foods/search?q=egg'],
    ['GET', '/api/io/settings'],
    ['POST', '/api/io/meals/sessions'],
  ]) {
    assert.strictEqual((await io(m, p)).status, 404, `${m} ${p} should be closed to I.O.`);
  }
});
