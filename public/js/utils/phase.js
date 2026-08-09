// Single source of truth for turning TDEE + phase + adjustment into a daily
// calorie goal. Used by Settings (Goal Phase card) and Today (ring target,
// the collapsed IronLog/phase row) so the formula can't drift between call
// sites — it used to be reimplemented independently in five places.
//
// The backend has its own copy (src/routes/ironlog.js phaseCalories) for the
// one server-side use (POST /api/ironlog/phase) — it can't share this module
// across the fetch boundary without a build step, so keep the two in sync by
// hand if the formula ever changes.

export function parsePhaseSettings(settings) {
  return {
    tdee:    parseFloat(settings.tdee) || null,
    phase:   settings.phase || 'maintain',
    deficit: parseInt(settings.cut_deficit)  || 500,
    surplus: parseInt(settings.bulk_surplus) || 300,
  };
}

// Daily calorie goal implied by TDEE + phase + adjustment, or null if no TDEE
// is set. Not rounded — callers round as needed (whole kcal, nearest 10, …).
export function phaseCalorieGoal(tdee, phase, deficit, surplus) {
  if (!tdee) return null;
  if (phase === 'cut')  return tdee - deficit;
  if (phase === 'bulk') return tdee + surplus;
  return tdee;
}

// Below this, a goal is worth remarking on: hitting a protein target gets hard,
// holding muscle through a cut gets harder, and it's the range people rebound
// out of. Always kcal — the goal is stored in kcal and only displayed in kJ.
export const LOW_GOAL_KCAL = 1200;

// A note to show beside a low goal, or null when there's nothing to say.
// Warns, never clamps: the arithmetic is the user's, and silently moving
// someone's number is its own kind of dishonest. Deliberately not shown on
// Today — a daily scolding about a goal you already chose is a nag, and this
// belongs where the number is set.
//
// The advice splits on whether a smaller deficit could even fix it. A 59kg,
// 57-year-old sedentary woman has a TDEE near 1340, and at that point NO
// meaningful deficit clears 1200 — telling her to trim the deficit would be
// arithmetic she can check and find wrong. The lever there is the burn side.
export function lowGoalNote(goalKcal, tdee, phase) {
  if (!(goalKcal > 0) || goalKcal >= LOW_GOAL_KCAL) return null;
  const headroom = tdee > 0 ? Math.round(tdee - LOW_GOAL_KCAL) : null;
  const fixable  = headroom != null && headroom >= 100 && phase === 'cut';
  return {
    goalKcal: Math.round(goalKcal),
    // The largest deficit that still lands on LOW_GOAL_KCAL, when one exists.
    suggestDeficit: fixable ? headroom : null,
    reachable: fixable,
  };
}
