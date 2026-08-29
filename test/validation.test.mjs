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
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { isRealDate } = require('../src/utils/tz.js');

// isSafeExternalUrl is module-private; lift it out rather than exporting a
// function nothing else needs, so the source stays the thing under test.
const settingsSrc = fs.readFileSync(new URL('../src/routes/settings.js', import.meta.url), 'utf8');
const isSafeExternalUrl = new Function(
  'return ' + settingsSrc.match(/function isSafeExternalUrl[\s\S]*?\n}/)[0])();

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
