// The one bit of the drag gesture that is logic rather than DOM.
//
// Dragging a food between meals and scrolling the day are the same gesture for
// the first fraction of a second, and this function is the whole of the
// decision. Both failure directions are bad in a way that is hard to notice in
// a quick manual test on a desktop with a mouse: a scroll read as a drag makes
// the day un-scrollable wherever the food is, and a drag read as a scroll means
// the feature simply does not work on a phone, which is ~90% of this app.
import { test } from 'node:test';
import assert from 'node:assert';
import { gestureIntent, unzoom, HOLD_MS, SLOP_PX } from '../public/js/utils/dragIntent.js';

test('a finger that moves before the hold completes is scrolling', () => {
  assert.strictEqual(
    gestureIntent({ dx: 0, dy: 40, elapsedMs: 50 }), 'scroll',
    'a flick down the day armed a drag');
});

test('a finger held still becomes a drag', () => {
  assert.strictEqual(gestureIntent({ dx: 0, dy: 0, elapsedMs: HOLD_MS }), 'drag');
  // A couple of px of thumb wander must not cost the gesture — the primary
  // user runs this at 150% with big targets and does not hold perfectly still.
  assert.strictEqual(gestureIntent({ dx: 2, dy: 3, elapsedMs: HOLD_MS + 20 }), 'drag');
});

test('nothing is decided until something happens', () => {
  assert.strictEqual(gestureIntent({ dx: 1, dy: 1, elapsedMs: 10 }), 'pending');
});

test('a slow deliberate scroll is still a scroll, not a drag', () => {
  // The case that falls out of checking the clock before the distance: a finger
  // 40px down the screen after 300ms is scrolling slowly, and ordering the two
  // checks the other way would hand it a drag.
  assert.strictEqual(
    gestureIntent({ dx: 0, dy: 40, elapsedMs: HOLD_MS + 100 }), 'scroll',
    'a slow scroll was read as a pick-up');
});

test('a mouse drags on distance alone, with no hold', () => {
  // Press-and-wait on a desktop reads as the app having hung, and a mouse has
  // no scroll-by-drag for a drag to be confused with.
  assert.strictEqual(
    gestureIntent({ dx: SLOP_PX, dy: 0, elapsedMs: 0, pointerType: 'mouse' }), 'drag');
  assert.strictEqual(
    gestureIntent({ dx: 2, dy: 0, elapsedMs: 999, pointerType: 'mouse' }), 'pending',
    'a stationary mouse press started a drag');
});

test('the slop is a distance, not an axis', () => {
  // Sideways counts too. Hypot, not |dy| — a horizontal swipe is not a hold.
  assert.strictEqual(gestureIntent({ dx: 40, dy: 0, elapsedMs: 50 }), 'scroll');
});

test('unzoom converts a visual size back to its own CSS box', () => {
  // A row measuring 300 visual px at 150% has a 200px CSS box, which is what
  // the body-level ghost has to be laid out at before being scaled back up.
  assert.strictEqual(unzoom(300, 1.5), 200);
  assert.strictEqual(unzoom(300, 1), 300);
  // A missing or nonsense scale must not produce Infinity or NaN and collapse
  // the ghost to a sliver — getComputedStyle can hand back '' mid-transition.
  assert.strictEqual(unzoom(300, 0), 300);
});
