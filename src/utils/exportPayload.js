'use strict';

const { allSettings } = require('./profileSettings');

// The full backup for one profile. Shared by GET /api/settings/export (session)
// and GET /api/orbit/weekly-export (API key), so the weekly vault copy is the
// exact payload a manual export produces.
function buildExportPayload(db, pid) {
  const payload = {
    exported_at: new Date().toISOString(),
    // Only foods this profile actually logged — not the whole shared
    // ~4,800-row seed table, which every profile can already re-derive
    // (it's re-seeded on a fresh DB) and would bloat every export.
    // The UNION covers foods that back a batch: a batch you've never taken a
    // portion from has no meal_entries row, so its backing food would be
    // missing and the restored batch would have nothing to log against.
    foods: db.prepare(`
      SELECT DISTINCT f.* FROM foods f
      JOIN meal_entries me ON me.food_id = f.id
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      WHERE ms.profile_id = $pid
      UNION
      SELECT f.* FROM foods f
      JOIN batches b ON b.food_id = f.id
      WHERE b.profile_id = $pid
      UNION
      -- A whole-meal leftover mints its own backing food and has no
      -- meal_entries until it is eaten, so neither branch above reaches it.
      -- Without this the restored leftover's food_id remaps to null, and
      -- because loadDay INNER JOINs foods the entry it creates is written and
      -- then never rendered: measured at 0 of 400 kcal landing on the day.
      SELECT f.* FROM foods f
      JOIN leftovers l ON l.food_id = f.id
      WHERE l.profile_id = $pid
    `).all({ pid }),
    // Batches were absent from every export until now, while "Clear all
    // logged data" deleted them — so export → clear → restore silently lost
    // every meal prep you'd saved.
    batches: db.prepare('SELECT * FROM batches WHERE profile_id = $pid').all({ pid }),
    // Same clear-deletes-it/export-misses-it trap batches and daily_overrides
    // each fell into once. Carried from the start this time.
    leftovers: db.prepare('SELECT * FROM leftovers WHERE profile_id = $pid').all({ pid }),
    meal_sessions: db.prepare('SELECT * FROM meal_sessions WHERE profile_id = $pid').all({ pid }),
    meal_entries:  db.prepare(`
      SELECT me.* FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      WHERE ms.profile_id = $pid
    `).all({ pid }),
    weight_log:    db.prepare('SELECT * FROM weight_log WHERE profile_id = $pid').all({ pid }),
    // Without this, export → "clear all data" → import silently reinstates the
    // exact defect goal_history exists to prevent: settings come back, boot
    // re-anchors the current goal at TODAY, and every past day quietly reverts
    // to being judged against a target set afterwards. Unrecoverable, because
    // nothing else in the file records what you were aiming at and when.
    goal_history:  db.prepare('SELECT * FROM goal_history WHERE profile_id = $pid ORDER BY effective_from').all({ pid }),
    // Waist history. Never captured, so restoring onto a new device or a fresh
    // DB lost the whole series — and it is the one measurement that keeps
    // meaning something when the scale is arguing with you.
    measurements:  db.prepare('SELECT date, waist_cm, logged_at FROM measurements WHERE profile_id = $pid ORDER BY date').all({ pid }),
    // The "I ate light, this day is fine" confirmations. THE dangerous gap:
    // "Clear all logged data" deletes these and the export did not carry them,
    // so export -> clear -> import silently un-confirmed every day. Those days
    // go back to counting as under-logged, which drops them from the 28-day
    // intake average behind the maintenance estimate — so a restore quietly
    // changed a number the user makes decisions on.
    daily_overrides: db.prepare('SELECT date, key, value FROM daily_overrides WHERE profile_id = $pid').all({ pid }),
    // Use counts and last portion sizes. Not data you'd mourn, but it is what
    // makes logging fast — without it "recent foods" is empty and every
    // quantity sheet forgets the portion you always take.
    food_stats:    db.prepare('SELECT food_id, use_count, last_used, last_qty_g FROM profile_food_stats WHERE profile_id = $pid').all({ pid }),
    // Presets, carried from the day they were built rather than after
    // someone lost them. Two arrays rather than a nested shape so the import
    // can remap food ids the same way it does everywhere else.
    presets: db.prepare('SELECT * FROM presets WHERE profile_id = $pid ORDER BY id').all({ pid }),
    preset_items: db.prepare(`
      SELECT pi.* FROM preset_items pi
      JOIN presets p ON p.id = pi.preset_id
      WHERE p.profile_id = $pid
      ORDER BY pi.preset_id, pi.sort, pi.id
    `).all({ pid }),
    settings:      allSettings(db, pid),
  };
  return payload;
}

module.exports = { buildExportPayload };
