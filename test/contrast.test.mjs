// The colour tokens have to clear the WCAG AA floor for body text (4.5:1).
//
// --text-faint did not: 2.06:1 on dark, 2.84:1 on light. It was not decoration
// either — it drew the goal figure beside every macro ("/ 166g"), the DAILY
// GOAL heading and the trend notes. The nav bar was moved off it when someone
// measured it; the other ~100 uses were left behind, and a "Stronger contrast"
// toggle that fixes it sits off by default, two taps deep under Appearance.
//
// Parsed out of the stylesheet rather than hard-coded here, so this fails if
// someone dims a token back down.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');

// The value of `name` inside the block that starts at `blockStart`.
function token(blockStart, name) {
  const from = css.indexOf(blockStart);
  assert.ok(from > -1, `no block ${blockStart}`);
  const block = css.slice(from, css.indexOf('}', from));
  const m = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  assert.ok(m, `${name} not found in ${blockStart}`);
  return m[1];
}

const lum = hex => {
  const c = [0, 2, 4].map(i => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
};

const AA = 4.5;   // WCAG 2.1 AA, normal-size text

test('the contrast maths agrees with the reference values', () => {
  // Black on white is the known 21:1; a mid grey on white is the documented 4.5-ish.
  assert.strictEqual(ratio('#000000', '#ffffff'), 21);
  assert.strictEqual(ratio('#ffffff', '#ffffff'), 1);
});

test('dark theme: every text token clears AA on the surfaces it is drawn on', () => {
  const bg      = token(':root {', '--bg');
  const surface = token(':root {', '--surface');
  for (const name of ['--text', '--text-muted', '--text-faint']) {
    const c = token(':root {', name);
    for (const [label, on] of [['page', bg], ['card', surface]]) {
      const r = ratio(c, on);
      assert.ok(r >= AA, `${name} ${c} is ${r}:1 on the ${label} — under the ${AA}:1 floor`);
    }
  }
});

test('light theme: the same', () => {
  const start   = ':root[data-theme="light"]';
  const bg      = token(start, '--bg');
  const surface = token(start, '--surface');
  for (const name of ['--text', '--text-muted', '--text-faint']) {
    const c = token(start, name);
    for (const [label, on] of [['page', bg], ['card', surface]]) {
      const r = ratio(c, on);
      assert.ok(r >= AA, `${name} ${c} is ${r}:1 on the light ${label} — under the ${AA}:1 floor`);
    }
  }
});

test('the hierarchy survives — faint is still dimmer than muted', () => {
  // The point of raising faint was readability, not flattening the design. If
  // these ever cross, the token has stopped meaning anything.
  for (const start of [':root {', ':root[data-theme="light"]']) {
    const faint = lum(token(start, '--text-faint'));
    const muted = lum(token(start, '--text-muted'));
    const text  = lum(token(start, '--text'));
    const dimmer = start === ':root {' ? (a, b) => a < b : (a, b) => a > b;   // dark: lower L is dimmer
    assert.ok(dimmer(faint, muted), `${start}: faint is not dimmer than muted`);
    assert.ok(dimmer(muted, text), `${start}: muted is not dimmer than text`);
  }
});

test('stronger contrast only ever raises it', () => {
  const on  = token(':root[data-contrast="1"]', '--text-faint');
  const off = token(':root {', '--text-faint');
  const surface = token(':root {', '--surface');
  assert.ok(ratio(on, surface) > ratio(off, surface),
    'the accessibility toggle must not lower contrast');
});
