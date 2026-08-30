// The limiter's map has to be bounded by MAX_KEYS whatever is in it.
//
// It wasn't. The sweep only drops entries whose window has elapsed, and inside a
// 15-minute window none have — so MAX_KEYS was a number that never bound. The
// first fix evicted oldest-first but refused to touch an IP currently serving a
// block, which reads as prudent and isn't: in a spray EVERY entry is blocked, so
// nothing was ever evictable and the map grew exactly as before. Measured at the
// time: 20,000 addresses held against a cap of 5,000.
//
// There is no accessor for the map, so this measures the only observable it has
// — whether an old entry is still remembered — which is the same thing.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rateLimit } = require('../src/middleware/rateLimit.js');

// Runs one request through the middleware and reports the status it produced.
function hit(mw, ip) {
  return new Promise(resolve => {
    const req = { ip, socket: {}, headers: {} };
    const res = {
      locals: {}, setHeader() {},
      status(s) { this._s = s; return this; },
      json() { resolve(this._s || 200); },
    };
    mw(req, res, () => resolve(200));
  });
}

// Spray `n` addresses, each far enough to trip the block, so every entry left in
// the map is a blocked one — the state that defeated the first fix.
async function spray(mw, n, perIp) {
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < perIp; k++) await hit(mw, `2001:db8::${i.toString(16)}`);
  }
}

test('a spray of blocked addresses cannot grow the map past its cap', async () => {
  const mw = rateLimit({ windowMs: 900_000, max: 3, blockMs: 900_000, count: 'requests' });
  await spray(mw, 400, 4);      // 400 addresses, each blocked; cap is 5,000

  // Under the cap, nothing is evicted: the first address is still blocked.
  assert.strictEqual(await hit(mw, '2001:db8::0'), 429, 'an entry was dropped while under the cap');

  await spray(mw, 6000, 4);     // now well past it

  // Over the cap, the oldest entries must have gone — including blocked ones.
  assert.strictEqual(await hit(mw, '2001:db8::0'), 200,
    'the oldest entry survived past the cap, so MAX_KEYS still does not bind');
});

test('an unblocked entry is evicted before a blocked one', async () => {
  const mw = rateLimit({ windowMs: 900_000, max: 3, blockMs: 900_000, count: 'requests' });
  await hit(mw, 'victim');                       // oldest entry, NOT blocked
  for (let k = 0; k < 4; k++) await hit(mw, 'attacker');   // second oldest, blocked
  await spray(mw, 5200, 1);                      // push past the cap with unblocked keys

  // The attacker is older than everything in the spray, but the spray's entries
  // are unblocked and it is not, so it should outlive them.
  assert.strictEqual(await hit(mw, 'attacker'), 429, 'a blocked IP was evicted before unblocked ones');
});

test('the current request is never the one evicted', async () => {
  const mw = rateLimit({ windowMs: 900_000, max: 3, blockMs: 900_000, count: 'requests' });
  await spray(mw, 5200, 1);
  // Two requests from a brand-new address: if the first one evicted itself, the
  // second would start from a fresh count and this would still pass — so check
  // the count actually carried by exhausting it.
  for (let k = 0; k < 3; k++) assert.strictEqual(await hit(mw, 'newcomer'), 200);
  assert.strictEqual(await hit(mw, 'newcomer'), 429, 'the count did not survive the sweep');
});
