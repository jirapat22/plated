// The logging streak forgives one missed day a week, so a single busy Tuesday
// doesn't wipe out a month. The walk backwards had no floor, so it spent that
// forgiveness on days BEFORE the account existed — a day you were not here
// answers "nothing logged" exactly like a day you skipped.
//
// Measured in the app: 37 against 36 consecutive logged days, and on a brand
// new account with one meal, "2 day logging streak" sitting beside "0 days
// logged" in the same card.
import { test } from 'node:test';
import assert from 'node:assert';
import { calcStreak } from '../public/js/utils/logCheck.js';

const GOAL = 1760;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayBack = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

// A run of consecutive logged days ending today, well over the "complete" bar
// so classifyDay counts each one.
const run = n => Array.from({ length: n }, (_, i) => ({
  date: dayBack(n - 1 - i), calories: GOAL, meal_count: 3, log_status: null,
})); // ascending, like the summary route returns

test('day one is a streak of one, not two', () => {
  assert.strictEqual(calcStreak(run(1), GOAL, iso(new Date())), 1);
});

test('a streak never exceeds the days the account has existed', () => {
  for (const n of [1, 2, 5, 14, 36]) {
    const s = calcStreak(run(n), GOAL, iso(new Date()));
    assert.strictEqual(s, n, `${n} logged days gave a streak of ${s}`);
  }
});

test('a skipped day inside the run is still forgiven', () => {
  // The feature this floor must not break: log 10 days, miss one in the middle,
  // and the run survives across the gap.
  const rows = run(10).filter(r => r.date !== dayBack(4));
  assert.strictEqual(calcStreak(rows, GOAL, iso(new Date())), 10);
});

test('two skipped days in the same week still end the run', () => {
  const rows = run(10).filter(r => r.date !== dayBack(3) && r.date !== dayBack(4));
  const s = calcStreak(rows, GOAL, iso(new Date()));
  assert.ok(s < 10, `expected the run to break, got ${s}`);
  // Three logged days, then the first gap is forgiven and the second ends it.
  assert.strictEqual(s, 4, 'three logged days plus the one forgiven gap');
});

test('an empty history is a streak of nothing', () => {
  assert.strictEqual(calcStreak([], GOAL, iso(new Date())), 0);
});

test('today counts as soon as anything is logged', () => {
  // Deliberate: the streak is a "did you show up" number, so it must not drop
  // every morning and come back at dinner.
  const rows = [{ date: dayBack(1), calories: GOAL, meal_count: 3 },
                { date: dayBack(0), calories: 200, meal_count: 1 }];
  assert.strictEqual(calcStreak(rows, GOAL, iso(new Date())), 2);
});

test('a gap before the first logged day is not counted', () => {
  // The account logged 3 days, then nothing for a fortnight, then today. Only
  // the current run counts, and the days before it started never do.
  const rows = [
    { date: dayBack(20), calories: GOAL, meal_count: 3 },
    { date: dayBack(19), calories: GOAL, meal_count: 3 },
    { date: dayBack(18), calories: GOAL, meal_count: 3 },
    { date: dayBack(0),  calories: GOAL, meal_count: 3 },
  ];
  assert.strictEqual(calcStreak(rows, GOAL, iso(new Date())), 2,
    'today plus one forgiven day, then the fortnight ends it');
});
