// Searching a brand name must find the branded food.
//
// Every one of the 4,804 seeded foods has brand NULL, and the ranking sorted
// an unbranded row above a branded one. That is right for a generic query
// ("milk" should find milk, not a milk drink) and wrong when the word typed IS
// a brand: "anchor" returned an AUSNUT row called "Liquid breakfast ...
// Anchor(tm)" ahead of the Anchor milk in the fridge, and "weet-bix" did the
// same. Those are the two searches most likely to be a brand and nothing else,
// and the conclusion they invite is "my food is not in here".
//
// The generic half is asserted too, because the ranking in this route was
// tuned by measurement and a brand tier is exactly the kind of change that
// quietly undoes it.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-rank-'));
let child, tok;

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json().catch(() => null);
};
const topFor = async q => (await call('GET', `/api/foods/search?q=${encodeURIComponent(q)}&limit=3`))[0];

before(async () => {
  child = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: 'test' },
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..'),
    stdio: 'ignore',
  });
  const deadline = Date.now() + 40000;
  for (;;) {
    try { await fetch(BASE + '/'); break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  const reg = await call('POST', '/api/auth/profiles', { name: 'RANKER', passcode: '1234' });
  tok = reg.token;
  // The shape a barcode scan or a hand-typed label actually creates: a brand
  // column, and a name that does NOT repeat the brand.
  for (const f of [
    { name: 'Protein+ Milk', brand: 'Anchor', calories_per_100g: 64, protein_per_100g: 7.2 },
    { name: 'Wheat Biscuits', brand: 'Weet-Bix', calories_per_100g: 350, protein_per_100g: 12 },
    { name: 'Peanut Slab', brand: 'Whittakers', calories_per_100g: 560, protein_per_100g: 9 },
  ]) await call('POST', '/api/foods', f);
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows holds it */ }
});

test('typing a brand finds that brand', async () => {
  for (const [q, brand] of [['anchor', 'Anchor'], ['weet-bix', 'Weet-Bix'], ['whittakers', 'Whittakers']]) {
    const top = await topFor(q);
    assert.strictEqual(top?.brand, brand,
      `"${q}" returned "${top?.name}" (brand ${top?.brand ?? 'none'}) instead of the ${brand} product`);
  }
});

test('a generic search still returns the plain ingredient', async () => {
  // The rows the ranking was tuned to produce. A brand tier must not disturb
  // them: none of these words is any brand in the table.
  for (const [q, want] of [
    ['rice',   /^Rice,/],
    ['egg',    /^Egg,/],
    ['butter', /^Butter,/],
    ['banana', /^Banana,/],
    ['milk',   /^Milk,/],
    ['bread',  /^Bread,/],
  ]) {
    const top = await topFor(q);
    assert.match(top?.name ?? '', want, `"${q}" now returns "${top?.name}"`);
    assert.ok(!top?.brand, `"${q}" surfaced a branded row: ${top?.brand}`);
  }
});
