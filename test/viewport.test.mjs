// How the app asks iOS for the screen.
//
// The profile name pill has been hidden behind the status bar twice. The first
// time --safe-top was simply never defined; defining it looked like the fix.
// It was not, because it left the app asking for the harder arrangement:
// black-translucent runs the web view under the status bar and the Dynamic
// Island, and every pixel of clearance then depends on
// env(safe-area-inset-top) returning the island's height. In the installed app
// it returns 0, and there is nothing CSS can do about that — the pill lands
// under the island again.
//
// So the rule this pins down is not "pad the top" (style.css already does, and
// it is still right for Safari and for landscape). It is: don't ask for a top
// inset the app then has to measure. Let iOS place the view below the status
// bar, where the island is not the page's problem.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const meta = name =>
  new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`).exec(html)?.[1] ?? null;

test('iOS is not asked to run the app under the status bar', () => {
  const style = meta('apple-mobile-web-app-status-bar-style');
  assert.ok(style, 'the status bar style meta is gone — iOS then defaults to it anyway, but say so');
  assert.notStrictEqual(style, 'black-translucent',
    'black-translucent puts the name pill under the Dynamic Island whenever env(safe-area-inset-top) reports 0');
});

test('the viewport still covers the safe areas', () => {
  // The other half of the arrangement, and the one that must NOT be removed in
  // sympathy: without viewport-fit=cover there is no inset at the bottom
  // either, and the nav bar goes under the home indicator.
  assert.match(meta('viewport') ?? '', /viewport-fit=cover/);
});

test('the top padding still reads the inset', () => {
  // 0 in the installed app now, real in Safari and in landscape. Keeping it is
  // free; dropping it because "iOS handles it" would break the browser case.
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  const bar = css.slice(css.indexOf('.profile-bar {'));
  assert.match(bar.slice(0, bar.indexOf('}')), /padding:.*var\(--safe-top/);
  assert.match(css, /--safe-top:\s*env\(safe-area-inset-top/);
});

// ── the top inset is spent once, not twice ──────────────────────────────────
// Measured on the device rather than reasoned about, after three rounds of the
// latter missed. iPhone 15 Plus, home-screen app, v234:
//
//   screen 430x932, viewport 430x873, insets top 59 / bottom 34
//
// 932 - 873 = 59. iOS had ALREADY moved the web view below the status bar —
// and still reported the 59px inset. Spending it again put 59px of dead space
// above the name pill and took the same 59 off the scroll area. So in a
// standalone app --safe-top is zero; in a browser tab it is whatever iOS says,
// because there the page really does start at the top of the screen.
test('the installed app does not pay the top inset twice', () => {
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  const at = css.indexOf('@media (display-mode: standalone)');
  assert.ok(at > -1, 'no standalone block — the top inset will be applied on top of one iOS already applied');
  const block = css.slice(at, css.indexOf('}', css.indexOf('{', at) + 1));
  assert.match(block, /--safe-top:\s*0/, 'the standalone block must zero --safe-top');
});

test('nothing reaches past the token to the raw inset', () => {
  // A rule using env(safe-area-inset-top) directly would miss the override
  // above and double-count again — which is exactly how the toast container
  // was written. Only the token definition itself may name it.
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');   // prose about this rule is not a use of it
  const uses = [...css.matchAll(/([-\w]+)\s*:\s*[^;]*env\(safe-area-inset-top/g)].map(m => m[1]);
  assert.deepStrictEqual(uses, ['--safe-top'],
    'read the top inset through var(--safe-top), not env() directly');
});
