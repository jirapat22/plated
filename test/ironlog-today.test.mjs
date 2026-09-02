// "Eat target keep missing and coming back."
//
// The Eat Target ring is drawn only when there is a burn to eat back. The route
// that supplies it answers `connected: false` for two different situations —
// this profile has no IronLog, and IronLog could not be reached — and it used
// to pair both with `calories_burned: 0`. So any blip between Railway and
// IronLog produced a confident zero: the ring vanished, the Workout ring said
// "rest day", the card dropped from three columns to two and everything below
// it jumped. The next successful poll put it all back.
//
// Two halves, pinned separately: the server must not invent the zero, and the
// client must not read "could not ask" as "nothing to eat back".
import { test } from 'node:test';
import assert from 'node:assert';
import { classifyIronlog } from '../public/js/utils/ironlogState.js';

const SYNCED = '2026-09-02T07:40:00.000Z';

test('an IronLog that answers is used as-is', () => {
  const live = { connected: true, calories_burned: 276, last_synced: SYNCED };
  assert.strictEqual(classifyIronlog(live), live);
});

test('an IronLog that cannot be reached is unknown, not a rest day', () => {
  // The bug, in one line. last_synced proves there IS an IronLog behind this
  // profile, so a burn already on screen is old — never wrong.
  const blip = { connected: false, error: 'fetch failed', calories_burned: null, last_synced: SYNCED };
  assert.strictEqual(classifyIronlog(blip), undefined);
});

test('a profile with no IronLog clears anything showing', () => {
  // Nothing has ever synced, so there is no burn to be old. Disconnecting
  // IronLog in Settings has to take the ring away, and this is the answer that
  // does it — which is why "could not ask" needed a different one.
  assert.strictEqual(classifyIronlog({ connected: false, last_synced: null }), null);
  assert.strictEqual(classifyIronlog({ connected: false }), null);
});

test('a missing or malformed body is treated as no IronLog', () => {
  for (const junk of [null, undefined, {}, 'nope', 0]) {
    assert.strictEqual(classifyIronlog(junk), null, `${JSON.stringify(junk)} was not read as "no IronLog"`);
  }
});

test('a zero burn from a LIVE answer is still a real rest day', () => {
  // The distinction only applies to failures. A day off is a genuine zero and
  // must keep behaving like one, or the ring would never clear after a workout.
  const restDay = { connected: true, calories_burned: 0, last_synced: SYNCED };
  assert.strictEqual(classifyIronlog(restDay), restDay);
});
