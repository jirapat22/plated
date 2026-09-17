// How much is left in the pot, and the one rule for moving that number.
//
// A batch portion is stored as an ordinary meal_entry pointing at the batch's
// backing food, so anything that creates, resizes or removes such an entry has
// to move the batch's stock with it. Without that, correcting a mis-logged
// portion left "how much is left" permanently wrong — the entry was fixed and
// the stock never was, and nothing in the UI could reconcile them.
//
// This lived inside routes/meals.js, which meant routes/presets.js could not
// reach it without one router requiring another. So logging a preset — which
// can hold a batch's backing food, because saving a meal containing a batch
// portion puts one there — skipped the draw-down entirely, while
// DELETE /entries/:id refunded regardless. The pair minted grams. A rule that
// every door has to follow belongs somewhere every door can see it.
//
// deltaG is grams to give BACK; negative takes more out.

const round1 = n => Math.round(n * 10) / 10;

// The floor is deliberately absent.
//
// It used to clamp at 0 on the way down while every give-back path handed the
// full quantity back, so the two directions disagreed and a round trip minted
// food: a pot with 100 g left, one 900 g entry logged against it (clamped to
// 0), then that entry deleted, and the pot claimed 900 g — 800 g that never
// existed, with every later portion priced off the fiction.
//
// A negative stored value is the honest reading: your log says more has come
// out of this pot than ever went in. That is worth knowing — it means a
// portion went in at the wrong weight — and ⚖️ Fix is the button for it. Only
// the ceiling still clamps, because putting more back than the pot was cooked
// with can only be a bug.
//
// Nothing shows a negative to anyone: shapeBatch floors every displayed figure
// at 0 and reports `overdrawn_g` separately. The honest value lives in the
// database so that subtract-then-add returns to where it started.
function adjustBatchStock(db, pid, foodId, deltaG) {
  if (!foodId || !deltaG) return;
  const b = db.prepare('SELECT id, cooked_g, remaining_g FROM batches WHERE food_id = $f AND profile_id = $p')
    .get({ f: foodId, p: pid });
  if (!b) return;                                   // not a batch food (or batch since deleted)
  const next = Math.min(b.cooked_g, b.remaining_g + deltaG);
  db.prepare('UPDATE batches SET remaining_g = $r WHERE id = $id').run({ r: round1(next), id: b.id });
}

module.exports = { adjustBatchStock };
