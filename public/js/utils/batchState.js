// When is a pot finished?
//
// Finished pots fold away into a "Finished · N" section; live ones keep a full
// card with ingredients, macros, per-100 g and a Log a portion button. Getting
// the line wrong is visible either way: too tight and the tab becomes a
// graveyard you scroll past to reach the one you are eating from (reported from
// the phone as "why is there a batch of 0", against seven finished pots in a
// row); too loose and a pot you still intend to finish disappears.
//
// The line used to be `remaining_g <= 1`, which is tighter than any real scale
// reading — so pots sitting at 2-10 g, which is scrapings, kept a full card.
// 10 g was the number asked for.
//
// But 10 g ALONE is wrong at the other end of the range. It is scrapings out of
// a 900 g pot of chilli and a fifth of a 50 g portion of sauce, and folding the
// second away would hide food someone still means to eat. So it has to be small
// both ways: no more than 10 g, AND under a twentieth of what was cooked.
//
//   900 g cooked,  8 g left   8 <= 10, 8 < 45    finished
//   900 g cooked, 12 g left   12 > 10            still listed
//    50 g cooked,  8 g left   8 <= 10, 8 > 2.5   still listed  (a sixth of it)
//
// The `<= 1` case survives on its own so a tiny pot with a crumb in it still
// folds, which the proportional rule alone would refuse (1 g of a 20 g pot is
// 5%, exactly on the line).
export const FINISHED_MAX_G = 10;
export const FINISHED_MAX_FRACTION = 0.05;

// An over-drawn pot is never finished, whatever is left. It is mis-recorded, it
// is asking to be corrected, and it belongs where its warning can be read.
export function isFinishedBatch(b) {
  if (!b || b.overdrawn_g) return false;
  const left = Number(b.remaining_g);
  if (!Number.isFinite(left)) return false;
  if (left <= 1) return true;
  const cooked = Number(b.cooked_g);
  if (!Number.isFinite(cooked) || cooked <= 0) return left <= FINISHED_MAX_G;
  return left <= FINISHED_MAX_G && left < cooked * FINISHED_MAX_FRACTION;
}
