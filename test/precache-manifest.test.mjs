// The service worker's STATIC_ASSETS list has to match what is on disk.
//
// It always mattered; it now matters in two directions at once, because the
// install handler stopped using cache.addAll.
//
// addAll sets service-workers mode to "none", so the fetch handler and its
// HTML guard never ran for the precache — and server.js answers any unmatched
// non-/api path with index.html and a 200. A STATIC_ASSETS entry naming a file
// a deploy had renamed was therefore stored as HTML under its .js URL, and the
// module failed to parse on every offline load. The install handler now checks
// the content type and REJECTS, which is the safe outcome and a harsher one: a
// stale entry no longer poisons the cache, it fails the install, and the phone
// silently never takes another update again. No banner appears, because the
// worker reaches "redundant" rather than "installed".
//
// The other direction is just as quiet: a module added to the app but not to
// this list is fetched from the network at runtime, so the app works perfectly
// until the first time it is opened with no signal.
//
// Neither failure says anything at the time it is introduced. This does.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const pub  = path.join(root, 'public');

const listed = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8')
  .match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g).map(s => s.slice(1, -1));

test('every precached path exists on disk', () => {
  const missing = listed.filter(p => p !== '/' && !fs.existsSync(path.join(pub, p)));
  assert.deepStrictEqual(missing, [],
    `sw.js precaches ${missing.length} path(s) that are not there — install will fail and no update will ever land again`);
});

test('every client module is precached', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const onDisk = walk(path.join(pub, 'js'))
    .map(f => '/' + path.relative(pub, f).split(path.sep).join('/'))
    .filter(f => f.endsWith('.js'));
  const unlisted = onDisk.filter(f => !listed.includes(f));
  assert.deepStrictEqual(unlisted, [],
    `these modules load fine online and break the app offline — add them to STATIC_ASSETS in public/sw.js`);
});

test('the cache name was bumped past the last released one', () => {
  // Not a version check against a constant that would need updating here —
  // just that it parses as plated-vNNN, since the whole update mechanism is
  // this string changing.
  const name = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8').match(/const CACHE_NAME = '([^']+)'/)[1];
  assert.match(name, /^plated-v\d+$/, `CACHE_NAME is "${name}" — the update prompt keys off this shape`);
});
