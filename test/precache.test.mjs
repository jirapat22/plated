// The service worker names every file it precaches, by hand.
//
// That list is the app offline, and it fails in both directions with no warning
// on screen:
//
//   A module missing from the list — which is what happens every time someone
//   adds one — loads fine online and 404s in a tunnel. The import fails, the
//   view that imported it never renders, and the screen is blank rather than
//   showing the saved copy that IndexedDB is still holding.
//
//   A path IN the list that does not exist on disk is worse. install uses
//   cache.addAll, which is atomic: one 404 rejects the whole thing, so NOTHING
//   is precached and the entire app is offline-dead. A typo does that.
//
// Written straight after adding ironlogState.js and forgetting to list it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../public/', import.meta.url);
const dir = p => path.join(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), p);

const sw = fs.readFileSync(dir('sw.js'), 'utf8');
const listed = new Set(
  [...sw.slice(sw.indexOf('STATIC_ASSETS'), sw.indexOf('];', sw.indexOf('STATIC_ASSETS')))
    .matchAll(/'([^']+)'/g)].map(m => m[1]));

const walk = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('every client module is precached', () => {
  const modules = walk(dir('js'))
    .map(f => '/' + path.relative(dir(''), f).split(path.sep).join('/'));
  const missing = modules.filter(m => !listed.has(m));
  assert.deepStrictEqual(missing, [],
    `these load online and 404 offline — add them to STATIC_ASSETS in public/sw.js`);
});

test('nothing in the list is missing from disk', () => {
  // cache.addAll is all-or-nothing: one bad path and the app has no offline
  // copy at all, including the shell it was working from a minute ago.
  const gone = [...listed]
    .filter(p => p !== '/' && !p.startsWith('http'))
    .filter(p => !fs.existsSync(dir(p.slice(1))));
  assert.deepStrictEqual(gone, [], 'a path in STATIC_ASSETS does not exist — addAll will reject and precache nothing');
});

test('the cache name changed with the assets', () => {
  // Not a freshness check — just that the version is the shape the activate
  // handler deletes old caches by. A missing bump ships new files into an old
  // cache name and nobody gets them.
  assert.match(sw, /const CACHE_NAME = 'plated-v\d+';/);
});
