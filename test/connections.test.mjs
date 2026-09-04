// Connect codes: what one household member can see of another, and what they
// cannot. Never audited before this file.
//
// The shape being checked: a connection is READ-ONLY and covers Today and
// History only. Weight, waist and Trends are private no matter who is
// connected, and no write route accepts a ?profile= at all — meal ids are
// global, so a write route that trusted an id instead of scoping to the caller
// would let anyone edit anyone's day.
//
// Three profiles, because two cannot tell "connected people can read" apart
// from "everyone can read".
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-conn-'));
const DAY = '2026-09-03';
let child;

const call = (method, p, body, tok) => fetch(BASE + p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// One object per person, so the assertions read as "B asks for A's day".
const who = {};
async function makeProfile(name, passcode) {
  const r = await call('POST', '/api/auth/profiles', { name, passcode }, null);
  const body = await r.json();
  assert.strictEqual(r.status, 201, `could not create ${name}: ${JSON.stringify(body)}`);
  return { id: body.profile.id, token: body.token, name };
}
const as = p => (method, path, body) => call(method, path, body, p.token);

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
  who.a = await makeProfile('ALICE', '1379');
  who.b = await makeProfile('BOBBY', '2468');
  who.c = await makeProfile('CHRIS', '3571');

  // Alice logs something worth seeing, and weighs herself.
  const logged = await as(who.a)('POST', '/api/meals/log', {
    date: DAY, meal_type: 'lunch', food_id: 1, quantity_g: 200,
  });
  // Read the body ONCE. `assert(x, await r.text())` evaluates the message
  // whether or not the assertion fails, which consumes it before .json() runs.
  const loggedBody = await logged.json();
  assert.strictEqual(logged.status, 201, JSON.stringify(loggedBody));
  const day = await (await as(who.a)('GET', `/api/meals/day/${DAY}`)).json();
  who.a.entryId = loggedBody.entry_id ?? day.sessions[0].entries[0].id;
  await as(who.a)('POST', '/api/weight', { date: DAY, weight_kg: 68.4 });
});

after(() => {
  child?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

// ── before anyone connects ──────────────────────────────────────────────────
test('a stranger cannot read your day just by naming your profile', async () => {
  const r = await as(who.b)('GET', `/api/meals/day/${DAY}?profile=${who.a.id}`);
  assert.strictEqual(r.status, 403, 'an unconnected profile read another profile\'s day');
});

test('nor the summary that History draws from', async () => {
  const r = await as(who.b)('GET', `/api/meals/summary?days=all&profile=${who.a.id}`);
  assert.strictEqual(r.status, 403);
});

test('a profile id that is not a number is refused, not crashed on', async () => {
  // parseInt('nope') is NaN, which has to reach the connection check and fail
  // it rather than reaching a query binding.
  const r = await as(who.b)('GET', `/api/meals/day/${DAY}?profile=nope`);
  assert.strictEqual(r.status, 403, `answered ${r.status}: ${await r.text()}`);
});

// ── connecting ──────────────────────────────────────────────────────────────
test('a code connects exactly the two people it passes between', async () => {
  const code = (await (await as(who.a)('GET', '/api/connections/code')).json()).connect_code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/, `code was ${code}`);
  who.a.code = code;

  const joined = await as(who.b)('POST', '/api/connections', { code });
  const joinedBody = await joined.json();          // once — see the note in before()
  assert.strictEqual(joined.status, 201, JSON.stringify(joinedBody));
  assert.strictEqual(joinedBody.name, 'ALICE');

  // Bobby can now read Alice's day…
  const day = await as(who.b)('GET', `/api/meals/day/${DAY}?profile=${who.a.id}`);
  assert.strictEqual(day.status, 200);
  assert.ok((await day.json()).sessions.length > 0, 'connected read came back empty');

  // …and Chris, who was never given the code, still cannot.
  const outsider = await as(who.c)('GET', `/api/meals/day/${DAY}?profile=${who.a.id}`);
  assert.strictEqual(outsider.status, 403, 'connecting to Bobby exposed Alice to Chris');
});

test('the connection reads both ways from one person entering the code', async () => {
  // Documenting the model rather than judging it: Bobby entered Alice's code,
  // and that makes Alice able to read Bobby too, without Alice doing anything
  // or being told. For a household that is the intent — but it is one-sided
  // consent, so it should be a decision someone made, not a surprise.
  await as(who.b)('POST', '/api/meals/log', { date: DAY, meal_type: 'dinner', food_id: 1, quantity_g: 100 });
  const r = await as(who.a)('GET', `/api/meals/day/${DAY}?profile=${who.b.id}`);
  assert.strictEqual(r.status, 200, 'the connection did not read in the other direction');
});

// ── what a connection does NOT grant ────────────────────────────────────────
test('a connected profile cannot edit or delete what it can see', async () => {
  const id = who.a.entryId;
  assert.ok(id, 'no entry id to try');
  // Meal ids are global. These routes take no ?profile= at all, so the only
  // thing standing between Bobby and Alice's lunch is each route scoping its
  // lookup to the caller.
  for (const [method, p, body] of [
    ['PATCH',  `/api/meals/entries/${id}`, { quantity_g: 5 }],
    ['DELETE', `/api/meals/entries/${id}`, undefined],
  ]) {
    const r = await as(who.b)(method, p, body);
    assert.strictEqual(r.status, 404, `${method} ${p} answered ${r.status} — a reader wrote to someone else's day`);
  }
  // And it is still there, unchanged.
  const day = await (await as(who.a)('GET', `/api/meals/day/${DAY}`)).json();
  const entry = day.sessions.flatMap(s => s.entries).find(e => e.id === id);
  assert.ok(entry, "Alice's entry is gone");
  assert.strictEqual(entry.quantity_g, 200, 'the quantity was changed by someone else');
});

test('weight stays private even between connected profiles', async () => {
  // The weight routes take no ?profile= — the param must be ignored rather
  // than honoured, so Bobby gets his own (empty) history, never Alice's 68.4.
  const rows = await (await as(who.b)('GET', `/api/weight?limit=10&profile=${who.a.id}`)).json();
  assert.ok(Array.isArray(rows), `weight came back as ${JSON.stringify(rows)}`);
  assert.deepStrictEqual(rows.filter(r => r.weight_kg === 68.4), [],
    "a connected profile read the other's weigh-in");
});

// ── the code itself ─────────────────────────────────────────────────────────
test('your own code is refused, and a wrong one says so', async () => {
  const mine = await as(who.a)('POST', '/api/connections', { code: who.a.code });
  assert.strictEqual(mine.status, 400);
  const nobody = await as(who.c)('POST', '/api/connections', { code: 'ZZZZZZZZ' });
  assert.strictEqual(nobody.status, 404);
  const blank = await as(who.c)('POST', '/api/connections', { code: '   ' });
  assert.strictEqual(blank.status, 400);
});

test('connecting twice is refused rather than duplicated', async () => {
  const again = await as(who.b)('POST', '/api/connections', { code: who.a.code });
  assert.strictEqual(again.status, 409);
  const list = await (await as(who.b)('GET', '/api/connections')).json();
  assert.strictEqual(list.filter(p => p.id === who.a.id).length, 1, 'the connection was listed twice');
});

test('regenerating a code retires it without cutting anyone off', async () => {
  const fresh = (await (await as(who.a)('POST', '/api/connections/code/regenerate')).json()).connect_code;
  assert.notStrictEqual(fresh, who.a.code);

  // Bobby, who connected with the old code, is unaffected.
  const still = await as(who.b)('GET', `/api/meals/day/${DAY}?profile=${who.a.id}`);
  assert.strictEqual(still.status, 200, 'regenerating cut off an existing connection');

  // The retired code no longer works for anyone new.
  const stale = await as(who.c)('POST', '/api/connections', { code: who.a.code });
  assert.strictEqual(stale.status, 404, 'the old code still connected someone');
  who.a.code = fresh;
});

test('disconnecting closes the door from both sides', async () => {
  const gone = await as(who.b)('DELETE', `/api/connections/${who.a.id}`);
  assert.strictEqual(gone.status, 200);
  for (const [viewer, target, label] of [[who.b, who.a, 'Bobby→Alice'], [who.a, who.b, 'Alice→Bobby']]) {
    const r = await as(viewer)('GET', `/api/meals/day/${DAY}?profile=${target.id}`);
    assert.strictEqual(r.status, 403, `${label} still readable after disconnect`);
  }
  const twice = await as(who.b)('DELETE', `/api/connections/${who.a.id}`);
  assert.strictEqual(twice.status, 404, 'disconnecting twice should say there is nothing to undo');
});
