import { test } from 'node:test';
import assert from 'node:assert';

import { classifyFailure } from '../public/js/utils/writeQueue.js';

const decide = (err, tries, max) => classifyFailure(err, tries, max);
const e = (props, msg = '') => Object.assign(new Error(msg), props);

test('losing signal mid-flush stops, keeping everything left', () => {
  assert.strictEqual(decide(e({ offline: true }), 0), 'stop');
  assert.strictEqual(decide(e({ unreachable: true, status: 503 }), 0), 'stop');
});

test('an expired session HOLDS the write — this is the one that must not drop', () => {
  // api.js throws a bare Error('Session expired') on a 401 and bounces to lock.
  // Dropping here is how a meal logged in a tunnel disappears after re-login.
  assert.strictEqual(decide(e({}, 'Session expired'), 0), 'stop');
  assert.strictEqual(decide(e({ status: 401 }, 'Session expired'), 4), 'stop',
    'even at the retry ceiling, auth is not a reason to discard');
});

test('a 4xx that is not auth drops — it can never succeed', () => {
  assert.strictEqual(decide(e({ status: 404 }, 'Food not found'), 0), 'drop');
  assert.strictEqual(decide(e({ status: 400 }, 'Invalid date'), 0), 'drop');
});

test('a 5xx retries, then gives up rather than queueing forever', () => {
  assert.strictEqual(decide(e({ status: 500 }, 'boom'), 0), 'hold');
  assert.strictEqual(decide(e({ status: 500 }, 'boom'), 3), 'hold');
  assert.strictEqual(decide(e({ status: 500 }, 'boom'), 4), 'drop');
});

test('offline is checked before status, so a synthetic 503 is not read as 5xx', () => {
  // The service worker's offline response IS a 503. Were it classified by
  // status it would burn a retry every time the phone had no signal, and hit
  // the ceiling after five pocket-launches — silently discarding the meal.
  assert.strictEqual(decide(e({ offline: true, status: 503 }), 4), 'stop');
});
