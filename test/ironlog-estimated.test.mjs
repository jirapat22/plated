// IronLog guesses a workout's calories at 4 kcal/min when none was recorded.
//
// That is harmless at moderate+ activity, where its TDEE already prices in a
// training week and Plated adds nothing on top. At sedentary/light the burn IS
// eaten back, so the guess lands on the plate: IronLog's own example is a
// 35-minute session reported as 140 kcal where a real run is nearer 440. Eat
// back 140 that should have been 440 and the day is 300 kcal short, every time,
// invisibly.
//
// As of IronLog 5432f8d each session says which it is. Plated surfaces that
// rather than discounting it — how far to trust a duration estimate is the
// user's call, not this route's — so the only job here is to split the total
// honestly and never report a guess as a measurement.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { splitEstimated } = require_('../src/routes/ironlog.js');

test('a measured session contributes nothing to the estimated figure', () => {
  assert.deepStrictEqual(
    splitEstimated({ sessions: [{ calories_burned: 412, calories_estimated: false, calories_source: 'measured' }] }),
    { estimated_kcal: 0, estimated_count: 0 });
});

test('an estimated session is reported, with its kcal', () => {
  assert.deepStrictEqual(
    splitEstimated({ sessions: [{ calories_burned: 140, calories_estimated: true, calories_source: 'estimated_duration' }] }),
    { estimated_kcal: 140, estimated_count: 1 });
});

test('a mixed day splits, and only the guessed part is counted', () => {
  assert.deepStrictEqual(splitEstimated({ sessions: [
    { calories_burned: 412, calories_estimated: false },
    { calories_burned: 140, calories_estimated: true },
    { calories_burned: 88,  calories_estimated: true },
  ] }), { estimated_kcal: 228, estimated_count: 2 });
});

test('anything short of an explicit true counts as measured', () => {
  // Fails safe on the side of NOT crying wolf: an older IronLog omits the
  // field, and warning about every session on every day would train the user
  // to ignore the warning that matters.
  for (const sessions of [
    [{ calories_burned: 300 }],
    [{ calories_burned: 300, calories_estimated: null }],
    [{ calories_burned: 300, calories_estimated: 'true' }],
    [{ calories_burned: 300, calories_estimated: 1 }],
  ]) {
    assert.strictEqual(splitEstimated({ sessions }).estimated_count, 0,
      `${JSON.stringify(sessions[0])} was treated as an estimate`);
  }
});

test('an IronLog with no sessions array reports null, not zero', () => {
  // null is "we were not told"; zero is "nothing was guessed". Reporting zero
  // for an older IronLog states something we cannot know.
  for (const input of [null, undefined, {}, { sessions: null }, { sessions: 'lots' }]) {
    assert.deepStrictEqual(splitEstimated(input), { estimated_kcal: null, estimated_count: null },
      `${JSON.stringify(input)} should be unknown`);
  }
});
