// Weekly calorie budget (18/11/2026). 2026-11-18 is a Wednesday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekBudget } from '../public/js/utils/weekBudget.js';

const rows = [
  { date: '2026-11-15', calories: 2875 },   // last Sunday: not this week
  { date: '2026-11-16', calories: 1600 },   // Mon
  { date: '2026-11-17', calories: 1500 },   // Tue
  { date: '2026-11-18', calories: 300 },    // today's (stale) row: ignored
];

test('Wednesday: budget, used, left, fair share and banked', () => {
  const w = weekBudget('2026-11-18', 1743, rows, 800);
  assert.equal(w.monday, '2026-11-16');
  assert.equal(w.budget, 12201);
  assert.equal(w.used, 1600 + 1500 + 800);
  assert.equal(w.left, 12201 - 3900);
  assert.equal(w.daysLeft, 5);
  assert.equal(w.todayShare, Math.round((12201 - 3100) / 5));   // 1820: above goal after light days
  assert.equal(w.banked, 1743 * 2 - 3100);                       // 386 ahead
});

test('Monday: whole week ahead, fair share = goal', () => {
  const w = weekBudget('2026-11-16', 1743, rows, 0);
  assert.equal(w.daysLeft, 7);
  assert.equal(w.todayShare, 1743);
  assert.equal(w.banked, 0);
});

test('Sunday after a big week: over budget, last day', () => {
  const big = [{ date: '2026-11-20', calories: 6000 }, { date: '2026-11-21', calories: 5000 }];
  const w = weekBudget('2026-11-22', 1743, big, 2000);
  assert.equal(w.daysLeft, 1);
  assert.ok(w.left < 0);
});
