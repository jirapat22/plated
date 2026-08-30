// Trust-boundary checks that were missing.
//
// Weight and waist have had ranges since someone could type 700 kg. The
// equivalents for meal quantities, goal numbers, calendar dates and the IronLog
// URL did not exist, and each one was reachable with a single request. These
// assertions are the discriminating cases only — the shapes that used to be
// accepted and now must not be, plus the ordinary values that must keep working.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isRealDate } = require('../src/utils/tz.js');
// Was scraped out of settings.js with a regex, because it was module-private
// there and "nothing else needs it". Three things needed it: the settings form,
// a restored backup, and the IronLog client deciding where to send a request.
// It lives in utils/validate.js now and is simply imported.
const { isSafeExternalUrl } = require('../src/utils/validate.js');

// ── dates ───────────────────────────────────────────────────────────────────
test('a day that does not exist is not a date', () => {
  // Passed the shape regex every route used, and was stored: a meal session on
  // 30 February that History can never show but every average still counts.
  assert.strictEqual(isRealDate('2026-02-30'), false);
  assert.strictEqual(isRealDate('2026-04-31'), false);
  assert.strictEqual(isRealDate('2026-13-01'), false);
  assert.strictEqual(isRealDate('2026-00-10'), false);
});

test('leap years are judged correctly, not by a rule of thumb', () => {
  assert.strictEqual(isRealDate('2024-02-29'), true);   // divisible by 4
  assert.strictEqual(isRealDate('2026-02-29'), false);  // not
  assert.strictEqual(isRealDate('2100-02-29'), false);  // century, not a leap year
});

test('years outside a food diary are rejected', () => {
  assert.strictEqual(isRealDate('0001-01-01'), false);
  assert.strictEqual(isRealDate('9999-12-31'), false);
  assert.strictEqual(isRealDate('2026-08-29'), true);
});

test('the shape rules the old regex enforced still hold', () => {
  for (const bad of ['2026-8-9', '', null, undefined, '2026/08/09', 'today', '2026-08-29T00:00:00Z']) {
    assert.strictEqual(isRealDate(bad), false, `${bad} must not pass`);
  }
});

// ── SSRF ────────────────────────────────────────────────────────────────────
// The regression: URL.hostname keeps the brackets on an IPv6 literal, so
// `host === '::1'` could never be true and http://[::1]:PORT reached the app's
// own port through a route that echoes the response back.
test('every IPv6 loopback spelling is blocked', () => {
  for (const u of ['http://[::1]:3000/x', 'http://[0:0:0:0:0:0:0:1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://[::]/x']) {
    assert.strictEqual(isSafeExternalUrl(u), false, `${u} must be blocked`);
  }
});

test('IPv6 private ranges are blocked too', () => {
  assert.strictEqual(isSafeExternalUrl('http://[fe80::1]/x'), false, 'link-local');
  assert.strictEqual(isSafeExternalUrl('http://[fc00::1]/x'), false, 'unique-local');
});

test('a real public IPv6 host still works', () => {
  assert.strictEqual(isSafeExternalUrl('https://[2606:4700:4700::1111]/api'), true);
});

test('the IPv4 and scheme cases that already worked are unchanged', () => {
  for (const u of ['http://127.0.0.1/x', 'http://localhost/x', 'http://169.254.169.254/',
                   'http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.16.0.1/',
                   'file:///etc/passwd', 'not a url']) {
    assert.strictEqual(isSafeExternalUrl(u), false, `${u} must be blocked`);
  }
  assert.strictEqual(isSafeExternalUrl('https://ironlog.example.com/api'), true);
});

// ── the short-form IPv4 bypass, which does not exist here ───────────────────
// The dotted-quad regex looks like it could be walked around with http://127.1
// or http://2130706433 — the classic way past a check of this shape. It can't
// be, because the WHATWG URL parser canonicalises those to 127.0.0.1 before the
// regex ever sees them. That is load-bearing and invisible, so it gets a test:
// anyone who later swaps `new URL()` for a hand-rolled parse needs this to fail.
test('short-form and encoded loopback addresses are still loopback', () => {
  for (const url of ['http://127.1', 'http://127.0.1', 'http://2130706433',
                     'http://0x7f000001', 'http://0177.0.0.1', 'http://0']) {
    assert.strictEqual(isSafeExternalUrl(url), false, `${url} was allowed`);
  }
});

// ── one rule, every door ────────────────────────────────────────────────────
// These exact values were written by POST /api/ironlog/sync, straight past the
// ranges the settings form enforces, because the range table lived in the
// settings route and the sync had its own setter.
test('the values an IronLog sync sent are refused by the shared rule', () => {
  const { badSetting } = require('../src/utils/validate.js');
  const sent = {
    tdee: 999999,           // band 500-20000
    protein_goal: 99999,    // band 0-2000
    carb_goal: 5000,
    fat_goal: 5000,
    bodyweight_kg: 700,     // band 20-400 — trendWeight's fallback
    calorie_goal: 999999,
  };
  for (const [k, v] of Object.entries(sent)) {
    assert.ok(badSetting(k, v), `${k}=${v} was accepted`);
  }
  // And the ordinary values a real IronLog sends still go through.
  for (const [k, v] of Object.entries({ tdee: 2676, protein_goal: 166, carb_goal: 180,
                                        fat_goal: 62, bodyweight_kg: 75.6, calorie_goal: 1760 })) {
    assert.strictEqual(badSetting(k, v), null, `${k}=${v} was wrongly refused`);
  }
  // Blank means "not set", which is not the same as zero and must stay allowed.
  assert.strictEqual(badSetting('tdee', ''), null);
});
