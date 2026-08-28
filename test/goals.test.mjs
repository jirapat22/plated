import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { stampGoals } = createRequire(import.meta.url)('../src/utils/goals.js');

// The real seeded history for this profile: 2100 from 10 May, 1760 from 4 Aug.
const HIST = [
  { effective_from: '2026-05-10', calorie_goal: 2100 },
  { effective_from: '2026-08-04', calorie_goal: 1760 },
];
const stamp = dates => stampGoals(dates.map(d => ({ date: d })), HIST).map(r => r.goal);

test('a June day is judged against 2100, not against today\'s 1760', () => {
  assert.deepStrictEqual(stamp(['2026-06-20']), [2100]);
});

test('the changeover day itself takes the NEW goal', () => {
  assert.deepStrictEqual(stamp(['2026-08-03', '2026-08-04', '2026-08-05']),
    [2100, 1760, 1760]);
});

test('days before any recorded goal get null, not the earliest goal', () => {
  assert.deepStrictEqual(stamp(['2026-01-01', '2026-05-09', '2026-05-10']),
    [null, null, 2100]);
});

test('the pointer does not run away across a long gap', () => {
  // A year of silence between two logged days must not skip the 4 Aug change.
  assert.deepStrictEqual(stamp(['2026-05-11', '2026-12-31']), [2100, 1760]);
});

test('no history leaves rows untouched rather than stamping null', () => {
  const rows = [{ date: '2026-06-01' }];
  assert.deepStrictEqual(stampGoals(rows, []), [{ date: '2026-06-01' }]);
});

test('many rows between two changes all resolve correctly', () => {
  const days = ['2026-05-10','2026-06-01','2026-07-15','2026-08-03','2026-08-04','2026-09-01'];
  assert.deepStrictEqual(stamp(days), [2100, 2100, 2100, 2100, 1760, 1760]);
});
