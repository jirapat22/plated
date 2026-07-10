// One-off cleanup for data-import artifacts in the seeded NZ/AU food set
// (nz_seed). Found by manual audit 2026-07-11, not part of the automatic
// boot-time migration in src/db.js — run by hand, against whichever
// DATA_DIR you point it at (defaults to ./data).
//
//   node --experimental-sqlite scripts/clean-seed-foods.js [--dry-run]
//
// Two fixes, both idempotent (safe to re-run):
//   1. Hides one genuinely corrupted row: "1 tuber (24.0 cm long)" — a
//      serving-size description landed in the name field instead of an
//      actual food name, and its macros are physically impossible
//      (130g carbs + 13g protein + 2.5g fat = 145.5g per 100g).
//   2. Tidies name strings with double-spaces or a trailing comma left
//      over from the source CSV — the food itself is valid, just the
//      formatting is off (e.g. "fortified  vitamins" -> "fortified vitamins").
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dryRun = process.argv.includes('--dry-run');
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'plated.db');

const db = new DatabaseSync(dbPath);

const corrupted = db.prepare(
  "SELECT id, name FROM foods WHERE source = 'nz_seed' AND hidden = 0 AND name = '1 tuber (24.0 cm long)'"
).all();

const messy = db.prepare(
  "SELECT id, name FROM foods WHERE source = 'nz_seed' AND (name LIKE '%  %' OR name LIKE '%,')"
).all().map(r => ({ ...r, clean: r.name.replace(/\s+/g, ' ').replace(/,\s*$/, '').trim() }))
  .filter(r => r.clean !== r.name);

console.log(`DB: ${dbPath}`);
console.log(`Corrupted entries to hide: ${corrupted.length}`);
corrupted.forEach(r => console.log(`  #${r.id} ${JSON.stringify(r.name)}`));
console.log(`Names to tidy: ${messy.length}`);
messy.forEach(r => console.log(`  #${r.id} ${JSON.stringify(r.name)} -> ${JSON.stringify(r.clean)}`));

if (dryRun) {
  console.log('\n--dry-run: no changes written');
  process.exit(0);
}

const hide = db.prepare('UPDATE foods SET hidden = 1 WHERE id = $id');
const rename = db.prepare('UPDATE foods SET name = $name WHERE id = $id');
for (const r of corrupted) hide.run({ id: r.id });
for (const r of messy) rename.run({ id: r.id, name: r.clean });

console.log(`\nDone — hid ${corrupted.length}, renamed ${messy.length}`);
