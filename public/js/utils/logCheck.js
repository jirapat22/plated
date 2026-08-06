// Shared logic for "did you fully log this day?" detection.
// Used by both Today (banner) and Trends (chart marks, review list, averages).
//
// Rules (agreed with user):
//  - A day with no meals logged is 'empty' (neutral, not a problem).
//  - 3+ meals logged  -> 'complete' (assume a real day).
//  - calories >= 60% of goal -> 'complete'.
//  - calories < 60% of goal AND <= 2 meals -> flagged:
//        < 40% of goal -> 'strong' (stronger "did you forget?" nudge)
//        otherwise      -> 'incomplete'
//  - Today / future days are never flagged (still in progress).
//  - A day the user confirmed as "I ate light" (log_status === 'confirmed')
//    always counts as 'complete'.

export const LOG_EMPTY      = 'empty';
export const LOG_COMPLETE   = 'complete';
const LOG_INCOMPLETE = 'incomplete';
export const LOG_STRONG     = 'strong';

const COMPLETE_FRAC = 0.60;   // >= 60% of goal counts as a full day
const STRONG_FRAC   = 0.40;   // < 40% of goal = stronger nudge
const FULL_MEALS    = 3;      // 3+ meals = assume complete regardless of calories

// day: { date, calories, meal_count, log_status }
// goal: calorie goal (number). todayISO: current local date 'YYYY-MM-DD'.
export function classifyDay(day, goal, todayISO) {
  const cals  = day.calories  || 0;
  const meals = day.meal_count || 0;

  if (meals === 0) return LOG_EMPTY;
  if (day.log_status === 'confirmed') return LOG_COMPLETE;
  // Don't judge today or the future — still being logged.
  if (todayISO && day.date && day.date >= todayISO) return LOG_COMPLETE;

  // The calorie floor is checked BEFORE the meal-count shortcut. It used to run
  // after, so three 100-kcal snacks counted as a fully-logged day: it held a
  // streak together, and — the part that actually costs you — passed the
  // !isFlagged filter into the 28-day intake average behind Trends' real-
  // maintenance estimate, dragging that estimate down. Days above the floor are
  // unaffected, so this only catches the pathological case.
  if (goal > 0 && cals <  STRONG_FRAC   * goal) return LOG_STRONG;
  if (meals >= FULL_MEALS) return LOG_COMPLETE;
  if (goal > 0 && cals >= COMPLETE_FRAC * goal) return LOG_COMPLETE;
  return LOG_INCOMPLETE;
}

// True for days that look under-logged (excluded from averages, marked on charts).
export function isFlagged(status) {
  return status === LOG_INCOMPLETE || status === LOG_STRONG;
}
