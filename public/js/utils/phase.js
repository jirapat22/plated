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
