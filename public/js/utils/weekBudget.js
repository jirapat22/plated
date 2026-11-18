// Weekly calorie budget (18/11/2026, Pat): the week Mon-Sun gets goal x 7 to
// spend, so a big Saturday is planned for instead of quietly erasing the
// deficit. Pat's stall came from 2-3 big days a week while his normal days sat
// right on goal, which a single daily number can't show you.
//
// Like a weekly allowance: Monday you get the lot, and every day after that
// you can see what's left and what a fair share of it is.
//
// Pure (no DOM) so it can be tested and reused by Trends.
import { addDaysIso } from './date.js';

/**
 * @param {string} today      YYYY-MM-DD, local
 * @param {number} dailyGoal  kcal per day
 * @param {Array}  rows       /api/meals/summary rows ({date, calories})
 * @param {number} todayKcal  eaten today so far (the live number, not the row)
 */
export function weekBudget(today, dailyGoal, rows, todayKcal = 0) {
  const dow = (new Date(today + 'T00:00:00').getDay() + 6) % 7;   // Mon=0 .. Sun=6
  const monday = addDaysIso(today, -dow);
  const budget = Math.round(dailyGoal * 7);
  // Days before today this week. Today's row is skipped because todayKcal is
  // fresher (the summary can be a cached copy from before the last meal).
  const before = (rows || [])
    .filter(r => r.date >= monday && r.date < today)
    .reduce((s, r) => s + (Number(r.calories) || 0), 0);
  const used = Math.round(before + (Number(todayKcal) || 0));
  const daysLeft = 7 - dow;                       // including today
  return {
    monday, budget, used,
    left: budget - used,
    daysLeft,
    // What today can be if the rest of the week shares what's left evenly:
    // under the goal after a big day, above it after some light ones.
    todayShare: Math.round((budget - before) / daysLeft),
    // How far the days already finished are ahead (+) or behind (-) of pace.
    banked: Math.round(dailyGoal * dow - before),
  };
}
