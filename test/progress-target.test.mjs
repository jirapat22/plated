// Progress-to-target card on Trends (18/11/2026): kg to go and the two finish dates.
import { test } from 'node:test';
import assert from 'node:assert';
import { progressToTarget } from '../public/js/utils/stats.js';

const TODAY = '2026-11-19';

test('a real downward trend gives a pace date, and 0.5 kg/week gives its own date', () => {
  // 72 kg now, target 68: 4 kg to go. At 0.5 kg/week = 8 weeks = 56 days. At 0.4 kg/week = 10 weeks.
  const p = progressToTarget({ curWeight: 72, targetWeight: 68, weeklyRate: -0.4, today: TODAY });
  assert.strictEqual(p.toGo, 4);
  assert.strictEqual(p.half, '2027-01-14');
  assert.strictEqual(p.pace, '2027-01-28');
  assert.strictEqual(p.paceWhy, null);
});

test('a flat trend says so instead of a made-up date (the 0.5 kg/week date still shows)', () => {
  const p = progressToTarget({ curWeight: 72, targetWeight: 68, weeklyRate: -0.05, today: TODAY });
  assert.strictEqual(p.pace, null);
  assert.strictEqual(p.paceWhy, 'flat');
  assert.strictEqual(p.half, '2027-01-14');
});

test('going the wrong way, too slow, or no trend yet: no pace date and the reason', () => {
  assert.strictEqual(progressToTarget({ curWeight: 72, targetWeight: 68, weeklyRate: 0.3, today: TODAY }).paceWhy, 'wrong-way');
  assert.strictEqual(progressToTarget({ curWeight: 90, targetWeight: 68, weeklyRate: -0.15, today: TODAY }).paceWhy, 'far');
  assert.strictEqual(progressToTarget({ curWeight: 72, targetWeight: 68, weeklyRate: null, today: TODAY }).paceWhy, 'unknown');
});

test('at the target, or no target set', () => {
  assert.strictEqual(progressToTarget({ curWeight: 68.1, targetWeight: 68, weeklyRate: -0.4, today: TODAY }).reached, true);
  assert.strictEqual(progressToTarget({ curWeight: 72, targetWeight: null, weeklyRate: -0.4, today: TODAY }), null);
});

test('works for gaining towards a target too', () => {
  const p = progressToTarget({ curWeight: 66, targetWeight: 68, weeklyRate: 0.25, today: TODAY });
  assert.strictEqual(p.toGo, -2);
  assert.strictEqual(p.pace, '2027-01-14');   // 2 kg at 0.25 kg/week = 8 weeks
});
