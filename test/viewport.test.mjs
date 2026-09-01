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
