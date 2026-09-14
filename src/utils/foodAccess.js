// Which foods a profile is allowed to reference, in one place.
//
// Three of the `source` values in the shared foods table are not library
// entries at all. 'quick' holds the free text you typed for a meal you could
// not weigh, 'batch' the name of something you cooked, 'leftover' what you
// saved for later. They live there for bookkeeping and they are private notes:
// search excludes them, the by-source list excludes them, and GET /api/foods/:id
// gates them because walking /api/foods/1..N otherwise read every household
// member's meal descriptions straight out.
//
// That gate was put on the read route alone, which left the same disclosure
// reachable through any route that takes a food id FROM THE REQUEST and hands
// the row back: creating a preset returned the name and every macro, and so did
// logging the food to your own day. A door is not locked because one of its
// four frames is.
//
// The rule applies to ids the CALLER supplied. Ids read back out of the
// profile's own stored rows — the entries a meal-copy is duplicating, the food
// a leftover already points at — are theirs by construction, and gating those
// would turn a legitimate edit into a 404.
const PRIVATE_SOURCES = ['quick', 'batch', 'leftover'];

// Drop-in for a `WHERE id = $id` that also binds $pid. Exported as SQL rather
// than only as a function because the batch totals helper prepares its query
// once and runs it per ingredient, and that is worth keeping.
const VISIBLE_SQL =
  "(source NOT IN ('quick', 'batch', 'leftover') OR created_by_profile = $pid)";

// The food, or undefined when it does not exist OR is someone else's private
// note. Callers treat both the same way on purpose: "no such food" is the
// honest answer to give, and distinguishing them would re-open the enumeration
// this closes.
function usableFood(db, id, pid) {
  const n = parseInt(id);
  if (!Number.isFinite(n)) return undefined;
  return db.prepare(`SELECT * FROM foods WHERE id = $id AND ${VISIBLE_SQL}`)
    .get({ id: n, pid });
}

// Every table that can point at a food.
//
// A whole-meal split mints a food to back its leftover, hidden from search and
// belonging to that one leftover. When the leftover goes, so should the food —
// but ONLY if nothing else grew a reference to it in the meantime. Three places
// sweep those up: deleting a profile, restoring a backup, and binning a single
// leftover.
//
// All three wrote the same NOT EXISTS clause out by hand, naming meal_entries,
// batches and leftovers. Then preset_items arrived as a fourth referrer and not
// one of the three learned about it — and because foreign_keys is ON, the
// DELETE doesn't skip the row, it THROWS. Measured: save a preset holding a
// leftover-backed food and "Delete this profile" fails with "FOREIGN KEY
// constraint failed" forever, while binning that leftover returns the same
// error AFTER the leftover row is already gone.
//
// So the list lives here once. A fifth table pointing at foods only has to be
// added in one place, and the clause is a no-op rather than an exception when
// something still references the row.
const FOOD_REFERRERS = ['meal_entries', 'leftovers', 'batches', 'preset_items'];

// Drop-in for a `DELETE FROM foods WHERE …` — true only when nothing at all
// refers to the row. Written against the bare table name `foods`, so it belongs
// in a statement whose target is `foods`.
const UNREFERENCED_SQL = FOOD_REFERRERS
  .map(t => `NOT EXISTS (SELECT 1 FROM ${t} ref_${t} WHERE ref_${t}.food_id = foods.id)`)
  .join('\n        AND ');

module.exports = { PRIVATE_SOURCES, VISIBLE_SQL, usableFood, FOOD_REFERRERS, UNREFERENCED_SQL };
