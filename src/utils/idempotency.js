// Make a write safe to send twice.
//
// The client stamps `client_id` on a write. The first time it arrives the route
// does its work and records the response; if the same id arrives again — a
// retry after a lost response, or the offline queue flushing something it
// already managed to send — the stored response is replayed and nothing
// happens a second time.
//
// This matters more than it looks. Logging a food does three things in one
// request: inserts a meal_entries row, draws down batch stock, and bumps a
// use count. Only the insert is visible, so a duplicate looks like one extra
// entry you can delete — while the batch has quietly lost twice the grams and
// no amount of tidying the day view puts them back.
//
// No transaction is wrapped around the check and the write because none is
// needed here: every route using this is fully synchronous (node:sqlite's
// DatabaseSync, no awaits), and Node runs one at a time, so a handler cannot
// interleave with another copy of itself. If an await ever appears in one of
// these paths, that assumption dies and this needs a real lock.

// How long a client_id is remembered. Long enough for a phone that was offline
// over a weekend to flush its queue and still be recognised; short enough that
// the table stays small. Pruned once at boot rather than on a timer — the row
// count is tiny and nothing here is worth a background job.
const RETENTION_DAYS = 30;

// The stored response for this id, or null if it is new. Returns the status too,
// so a replay reproduces the original exactly rather than flattening to 200.
function replayOf(db, profileId, clientId) {
  if (!clientId) return null;
  const row = db.prepare(
    'SELECT status, response FROM idempotency WHERE profile_id = $p AND client_id = $c'
  ).get({ p: profileId, c: clientId });
  if (!row) return null;
  try {
    return { status: row.status, body: JSON.parse(row.response) };
  } catch {
    return null;              // unreadable row: treat as new rather than 500
  }
}

// Record what this write answered. INSERT OR IGNORE, not a plain INSERT: losing
// a race here should cost nothing, and the first answer is the one that counts.
// Never throws — failing to remember a response is a missed optimisation, not a
// reason to fail a write that already succeeded.
function remember(db, profileId, clientId, status, body) {
  if (!clientId) return;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO idempotency (client_id, profile_id, status, response)
       VALUES ($c, $p, $s, $r)`
    ).run({ c: clientId, p: profileId, s: status, r: JSON.stringify(body) });
  } catch { /* bookkeeping must never fail a committed write */ }
}

// A client_id has to look like one. Without this a caller could send a
// megabyte, or an array, and it would be stored as the primary key of a table
// every write consults.
const isValidClientId = v =>
  typeof v === 'string' && v.length >= 8 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);

function pruneIdempotency(db) {
  try {
    db.prepare(
      `DELETE FROM idempotency WHERE created_at < datetime('now', $age)`
    ).run({ age: `-${RETENTION_DAYS} days` });
  } catch { /* table may not exist on a very old database mid-migration */ }
}

module.exports = { replayOf, remember, isValidClientId, pruneIdempotency, RETENTION_DAYS };
