// Where the line between "finished" and "still listed" sits.
//
// This is a threshold, and every threshold in this codebase that went wrong
// went wrong quietly: the maintenance band said "steady" at a width wider than
// the action it invited, and this one sat at 1 g so scrapings kept a full card.
// A fixed 10 g fixes the big-pot case and breaks the small-pot one, which is
// the whole reason there are two terms.
import { test } from 'node:test';
import assert from 'node:assert';
import { isFinishedBatch, FINISHED_MAX_G } from '../public/js/utils/batchState.js';

const pot = (remaining_g, cooked_g, overdrawn_g = 0) => ({ remaining_g, cooked_g, overdrawn_g });

test('scrapings out of a big pot are finished', () => {
  assert.strictEqual(isFinishedBatch(pot(0, 900)), true);
  assert.strictEqual(isFinishedBatch(pot(2, 900)), true, '2 g of a 900 g pot kept a full card before');
  assert.strictEqual(isFinishedBatch(pot(8, 900)), true);
  assert.strictEqual(isFinishedBatch(pot(10, 900)), true, 'the stated ceiling is inclusive');
});

test('past the ceiling it stays listed, however big the pot', () => {
  assert.strictEqual(isFinishedBatch(pot(11, 900)), false);
  assert.strictEqual(isFinishedBatch(pot(12, 5000)), false,
    '10 g is a ceiling, not a proportion — a 5 kg pot does not get a bigger one');
});

test('a tenth of a small pot is not scrapings', () => {
  // The case a flat 10 g gets wrong: 8 g of a 50 g pot is a sixth of it, and
  // folding that away hides food someone still means to eat.
  assert.strictEqual(isFinishedBatch(pot(8, 50)), false);
  assert.strictEqual(isFinishedBatch(pot(6, 100)), false, '6% of the pot is still a portion');
  assert.strictEqual(isFinishedBatch(pot(4, 100)), true, '4% of it is not');
});

test('a crumb is finished even in a tiny pot', () => {
  // The proportional rule alone would refuse this: 1 g of 20 g is exactly 5%.
  assert.strictEqual(isFinishedBatch(pot(1, 20)), true);
  assert.strictEqual(isFinishedBatch(pot(0.4, 10)), true);
});

test('an over-drawn pot is never finished', () => {
  // It is mis-recorded rather than empty, and it has to stay where its warning
  // can be read — this is the behaviour the amber card exists for.
  assert.strictEqual(isFinishedBatch(pot(0, 900, 500)), false);
  assert.strictEqual(isFinishedBatch(pot(0, 900, 0.5)), false);
});

test('nonsense in gives "not finished", never a pot that vanishes', () => {
  // Failing closed matters in this direction: a bad row that reads as finished
  // disappears into a collapsed section the user has no reason to open.
  assert.strictEqual(isFinishedBatch(null), false);
  assert.strictEqual(isFinishedBatch({}), false);
  assert.strictEqual(isFinishedBatch(pot(NaN, 900)), false);
  assert.strictEqual(isFinishedBatch(pot(undefined, 900)), false);
  // A missing cooked weight cannot give a proportion, so the gram ceiling alone
  // decides rather than the whole thing throwing or folding everything away.
  assert.strictEqual(isFinishedBatch({ remaining_g: 5 }), true);
  assert.strictEqual(isFinishedBatch({ remaining_g: 50 }), false);
  assert.strictEqual(FINISHED_MAX_G, 10);
});
