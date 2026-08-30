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
//  - Today / future days are never flagged (still in progress) -> 'today'.
//  - A day the user confirmed as "I ate light" (log_status === 'confirmed')
//    always counts as 'complete', including today — that is the user declaring
//    the day finished, which is exactly what 'today' means they haven't done.

export const LOG_EMPTY      = 'empty';
export const LOG_COMPLETE   = 'complete';
// Still being logged. Distinct from 'complete' because callers need both facts
// and they are not the same one: don't nag about it, AND don't count it as
// evidence of anything. It used to return 'complete', so a day holding a single
// pre-logged meal counted as a fully-logged day — the consistency card read
// "100% fully logged" off 603 kcal, and the 7-day trend line was dragged down
// by a day that had barely started.
export const LOG_TODAY      = 'today';
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
  if (todayISO && day.date && day.date >= todayISO) return LOG_TODAY;

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

// The current run of days you showed up, walked backwards from today.
// Lives here rather than in the Trends view because it is the same question
// classifyDay answers, one day at a time — and because a view module cannot be
// tested without a DOM.
export function calcStreak(summary, goal, todayISO) {
  const byDate = Object.fromEntries(summary.map(r => [r.date, r]));
  // The day this account first logged anything. The walk below forgives one
  // missed day a week, and without this it spent that forgiveness on days
  // BEFORE you started — a day you were not here answers "nothing logged"
  // exactly like a day you skipped. Every streak came out one longer than the
  // history behind it: 37 against 36 consecutive logged days, and on a brand
  // new account 'a 2 day streak' next to 'days logged: 0'.
  const firstLogged = summary.find(r => (r.meal_count || 0) > 0)?.date || null;
  // Nothing logged, ever: no run to be on. Without this the walk below reached
  // yesterday, found it empty, forgave it, and reported a streak of 1 to an
  // account that had never logged a thing.
  if (!firstLogged) return 0;
  const todayD = new Date();
  let streak       = 0;
  let graceUsed    = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(todayD);
    d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    // Before the account existed there is nothing to forgive, and nothing to
    // count. Stop rather than break, so a streak can reach back to day one.
    if (firstLogged && iso < firstLogged) break;
    const row = byDate[iso] || { date: iso, calories: 0, meal_count: 0 };
    const status = classifyDay(row, row.goal ?? goal, todayISO);
    // Today counts toward the streak the moment anything is logged — it is a
    // "did you show up" number, not a "was the day complete" one. LOG_TODAY has
    // to be included explicitly now that today no longer arrives as 'complete',
    // or the streak would drop by one every morning until dinner.
    const logged = status === LOG_COMPLETE || status === LOG_TODAY;
    const empty  = status === LOG_EMPTY;      // nothing logged that day

    if (i > 0 && i % 7 === 0) graceUsed = 0;   // reset grace counter every 7 days back

    if (i === 0) {
      // Today is still in progress: it extends the streak as soon as it's
      // logged, but a not-yet-logged today never breaks it.
      if (logged) streak++;
      continue;
    }

    if (logged) {
      streak++;
    } else if (empty && graceUsed < 1) {
      graceUsed++;
      streak++;                                  // one skipped day per week is OK
    } else {
      break;                                     // under-logged, or a 2nd skip in the week
    }
  }
  return streak;
}
