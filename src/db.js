const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const NZ_FOODS     = require('./nz-foods.json');
const AUSNUT_FOODS = require('./ausnut-foods.json');

let db;

function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

function initDb() {
  const dbPath = path.join(process.env.DATA_DIR || './data', 'plated.db');
  db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS foods (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      brand             TEXT,
      barcode           TEXT UNIQUE,
      calories_per_100g REAL,
      protein_per_100g  REAL,
      carbs_per_100g    REAL,
      fat_per_100g      REAL,
      fiber_per_100g    REAL,
      serving_size_g    REAL    DEFAULT 100,
      source            TEXT    DEFAULT 'custom',
      is_favourite      INTEGER DEFAULT 0,
      use_count         INTEGER DEFAULT 0,
      created_at        TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meal_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT    NOT NULL,
      name        TEXT,
      meal_index  INTEGER NOT NULL,
      logged_at   TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meal_entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_session_id INTEGER REFERENCES meal_sessions(id) ON DELETE CASCADE,
      food_id         INTEGER REFERENCES foods(id),
      quantity_g      REAL    NOT NULL,
      calories        REAL,
      protein         REAL,
      carbs           REAL,
      fat             REAL,
      fiber           REAL,
      logged_at       TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS water_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT    NOT NULL,
      amount_ml  INTEGER NOT NULL,
      logged_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weight_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT    NOT NULL,
      weight_kg  REAL    NOT NULL,
      note       TEXT,
      logged_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meal_templates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_at TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meal_template_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER REFERENCES meal_templates(id) ON DELETE CASCADE,
      food_id     INTEGER REFERENCES foods(id),
      food_name   TEXT    NOT NULL,
      quantity_g  REAL    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_overrides (
      profile_id INTEGER NOT NULL DEFAULT 0,
      date  TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (profile_id, date, key)
    );

    -- ── Multi-profile ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS profiles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      accent_color TEXT    DEFAULT '#c8b8ff',
      pass_hash    TEXT    NOT NULL,
      pass_salt    TEXT    NOT NULL,
      created_at   TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_settings (
      profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value      TEXT,
      PRIMARY KEY (profile_id, key)
    );

    CREATE TABLE IF NOT EXISTS profile_food_stats (
      profile_id   INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
      food_id      INTEGER REFERENCES foods(id) ON DELETE CASCADE,
      is_favourite INTEGER DEFAULT 0,
      use_count    INTEGER DEFAULT 0,
      last_used    TEXT,
      PRIMARY KEY (profile_id, food_id)
    );

    -- ── Meal-prep batches: totals + cooked weight, drawn down by weight ──
    CREATE TABLE IF NOT EXISTS batches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      food_id     INTEGER REFERENCES foods(id),   -- backing food used for portion entries
      calories    REAL, protein REAL, carbs REAL, fat REAL, fiber REAL,  -- whole-batch totals
      cooked_g    REAL    NOT NULL,                -- weight after cooking (the divisor)
      remaining_g REAL    NOT NULL,                -- decrements as portions are logged
      ingredients TEXT,                            -- JSON [{name, grams}] for display
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- ── Bug reports / feature ideas (forwarded to Orbit) ───────
    CREATE TABLE IF NOT EXISTS bug_reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source     TEXT    NOT NULL,                  -- frontend | backend | manual
      type       TEXT    DEFAULT 'bug_report',      -- bug_report | idea
      message    TEXT    NOT NULL,
      stack      TEXT,
      context    TEXT,                              -- JSON string
      orbit_sent INTEGER DEFAULT 0,
      created_at TEXT    DEFAULT (datetime('now'))
    );
  `);

  migrateSchema(db);

  ensureIndexes(db);

  seedNzFoods(db);

  console.log(`DB ready: ${dbPath}`);
  return db;
}

// ── Schema migration: add profile_id to per-profile tables ───────
function tableHasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

function migrateSchema(db) {
  // Add nullable profile_id to data tables that predate multi-profile.
  // NULL marks "orphan" rows adopted by the first profile created.
  for (const t of ['meal_sessions', 'water_log', 'weight_log', 'meal_templates']) {
    if (!tableHasColumn(db, t, 'profile_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN profile_id INTEGER`);
    }
  }

  // daily_overrides changed its primary key (now includes profile_id). If the
  // table still has the old shape, rebuild it and park rows under profile 0.
  if (!tableHasColumn(db, 'daily_overrides', 'profile_id')) {
    db.exec(`
      ALTER TABLE daily_overrides RENAME TO daily_overrides_old;
      CREATE TABLE daily_overrides (
        profile_id INTEGER NOT NULL DEFAULT 0,
        date  TEXT NOT NULL,
        key   TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (profile_id, date, key)
      );
      INSERT INTO daily_overrides (profile_id, date, key, value)
        SELECT 0, date, key, value FROM daily_overrides_old;
      DROP TABLE daily_overrides_old;
    `);
  }

  // Admin flag, food creator + soft-delete, bodyweight source
  if (!tableHasColumn(db, 'profiles', 'is_admin')) {
    db.exec('ALTER TABLE profiles ADD COLUMN is_admin INTEGER DEFAULT 0');
  }
  if (!tableHasColumn(db, 'foods', 'created_by_profile')) {
    db.exec('ALTER TABLE foods ADD COLUMN created_by_profile INTEGER');
  }
  if (!tableHasColumn(db, 'foods', 'hidden')) {
    db.exec('ALTER TABLE foods ADD COLUMN hidden INTEGER DEFAULT 0');
  }
  if (!tableHasColumn(db, 'weight_log', 'source')) {
    db.exec("ALTER TABLE weight_log ADD COLUMN source TEXT DEFAULT 'manual'");
  }

  // Ensure exactly one admin exists — the first profile (e.g. the migrated one).
  const profileCount = db.prepare('SELECT COUNT(*) AS c FROM profiles').get().c;
  if (profileCount > 0) {
    const adminCount = db.prepare('SELECT COUNT(*) AS c FROM profiles WHERE is_admin = 1').get().c;
    if (adminCount === 0) {
      const first = db.prepare('SELECT id FROM profiles ORDER BY id ASC LIMIT 1').get();
      db.prepare('UPDATE profiles SET is_admin = 1 WHERE id = $id').run({ id: first.id });
    }
  }
}

// Indexes for the hot read paths. Runs after migrateSchema so the profile_id
// columns (added by ALTER TABLE there) exist. Without these, every day-load,
// summary, and food-search join falls back to a full table scan and slows as
// the logs grow. PK/UNIQUE columns are already indexed; these cover the
// foreign-key joins and (profile_id, date) filters that run on every screen.
function ensureIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_meal_entries_session   ON meal_entries(meal_session_id);
    CREATE INDEX IF NOT EXISTS idx_meal_sessions_pid_date ON meal_sessions(profile_id, date);
    CREATE INDEX IF NOT EXISTS idx_weight_log_pid_date    ON weight_log(profile_id, date);
    CREATE INDEX IF NOT EXISTS idx_foods_name             ON foods(name);
  `);
}

// Default per-profile settings, seeded when a profile is created.
const PROFILE_DEFAULTS = [
  ['calorie_goal', '2000'], ['protein_goal', '150'], ['carb_goal', '250'],
  ['fat_goal', '65'], ['fiber_goal', '30'], ['water_goal_ml', '2500'],
  ['ironlog_api_url', ''], ['ironlog_api_key', ''], ['ironlog_last_synced', ''],
  ['protein_multiplier', '2.2'], ['energy_unit', 'kcal'], ['phase', 'maintain'],
  ['tdee', ''], ['cut_deficit', '500'], ['bulk_surplus', '300'],
];

function seedProfileDefaults(db, profileId) {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES ($p, $k, $v)'
  );
  for (const [k, v] of PROFILE_DEFAULTS) ins.run({ p: profileId, k, v });
}

// The first profile created adopts all pre-existing single-user data:
// orphan meals/water/weight/templates/overrides, the old global settings
// values, and any favourites / use-counts recorded on the shared foods table.
function adoptOrphanData(db, profileId) {
  for (const t of ['meal_sessions', 'water_log', 'weight_log', 'meal_templates']) {
    db.prepare(`UPDATE ${t} SET profile_id = $p WHERE profile_id IS NULL`).run({ p: profileId });
  }
  db.prepare('UPDATE daily_overrides SET profile_id = $p WHERE profile_id = 0').run({ p: profileId });

  // Overlay any saved values from the legacy global settings table.
  const hasLegacy = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
  ).get();
  if (hasLegacy) {
    db.prepare(`
      INSERT OR REPLACE INTO profile_settings (profile_id, key, value)
      SELECT $p, key, value FROM settings WHERE key != 'passcode_hash'
    `).run({ p: profileId });
  }

  // Carry over favourites / usage from the shared foods table.
  db.prepare(`
    INSERT OR IGNORE INTO profile_food_stats (profile_id, food_id, is_favourite, use_count)
    SELECT $p, id, is_favourite, use_count FROM foods WHERE is_favourite = 1 OR use_count > 0
  `).run({ p: profileId });

  // Inherit any IronLog connection that was configured via server env vars.
  const setPref = (key, value) => {
    if (!value) return;
    db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($p, $k, $v)')
      .run({ p: profileId, k: key, v: value });
  };
  setPref('ironlog_api_url', process.env.IRONLOG_API_URL?.trim());
  setPref('ironlog_api_key', process.env.IRONLOG_API_KEY?.trim());
}

function countProfiles(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM profiles').get().c;
}

// Bump this whenever the seed lists below change — it forces a one-time
// re-seed on the next startup, then boots skip the (multi-thousand-row) build
// entirely. Keeps cold start fast without losing the "add new foods on
// upgrade" behaviour.
const SEED_VERSION = '2024-nzfcd14-ausnut23-v1';

function seedNzFoods(db) {
  const seededVersion = db.prepare("SELECT value FROM settings WHERE key = 'seed_version'").get()?.value;
  if (seededVersion === SEED_VERSION) return;   // this exact seed set is already applied

  const alreadyExists = db.prepare(
    "SELECT 1 FROM foods WHERE name = $name AND source = 'nz_seed'"
  );
  const insert = db.prepare(`
    INSERT INTO foods (name, calories_per_100g, protein_per_100g, carbs_per_100g,
      fat_per_100g, fiber_per_100g, serving_size_g, source)
    VALUES ($name, $cal, $pro, $carb, $fat, $fib, $srv, 'nz_seed')
  `);

  // Curated extras not in NZFCD official data
  const extras = [
    { name:'Whey Protein Powder',        cal:380, pro:75,  carb:10,  fat:5,   fib:1,   srv:30  },
    { name:'Protein Bar',                cal:380, pro:20,  carb:38,  fat:12,  fib:4,   srv:60  },
    { name:'Protein Shake (mixed)',      cal:150, pro:25,  carb:8,   fat:2,   fib:1,   srv:350 },
    { name:'Flat White (full cream)',    cal:120, pro:6.5, carb:9,   fat:6,   fib:0,   srv:220 },
    { name:'Flat White (trim milk)',     cal:80,  pro:7,   carb:9.5, fat:1.5, fib:0,   srv:220 },
    { name:'Frozen Mixed Vegetables',    cal:55,  pro:3,   carb:10,  fat:0.3, fib:3,   srv:100 },
    { name:'Frozen Edamame (Shelled)',   cal:122, pro:11,  carb:10,  fat:5,   fib:5,   srv:150 },
    { name:'Frozen Asian Stir Fry Mix',  cal:40,  pro:2,   carb:7,   fat:0.3, fib:2,   srv:150 },
    { name:'Oat Milk',                   cal:42,  pro:1,   carb:7,   fat:1,   fib:0.5, srv:250 },
    { name:'Almond Milk (Unsweetened)',  cal:15,  pro:0.6, carb:0.3, fat:1.1, fib:0.3, srv:250 },
    { name:'Kimchi',                     cal:15,  pro:1,   carb:2.4, fat:0.5, fib:1.6, srv:50  },
    { name:'Dumplings / Gyoza (frozen)', cal:220, pro:9,   carb:25,  fat:9,   fib:1.5, srv:100 },
    { name:'Nutritional Yeast',          cal:325, pro:50,  carb:38,  fat:5,   fib:26,  srv:10  },
    { name:'Stir Fry (veg + protein)',   cal:130, pro:12,  carb:8,   fat:6,   fib:2.5, srv:200 },
    { name:'Cottage Cheese',             cal:98,  pro:11,  carb:3.4, fat:4.3, fib:0,   srv:100 },
    { name:'Collagen Powder',            cal:370, pro:90,  carb:0,   fat:0,   fib:0,   srv:10  },
    { name:'Electrolyte Powder',         cal:5,   pro:0,   carb:1,   fat:0,   fib:0,   srv:5   },
    { name:'Beef Jerky',                 cal:410, pro:33,  carb:11,  fat:25,  fib:1,   srv:30  },
    { name:'Mass Gainer Powder',         cal:400, pro:30,  carb:55,  fat:5,   fib:2,   srv:100 },
  ];

  const ALCOHOL_RE = /beer|wine|spirit|cider|whisky|vodka|rum|\bgin\b|liqueur|champagne|brandy|sake|mead/i;

  const allFoods = [
    ...extras,
    ...NZ_FOODS.map(f => ({
      name: f.name,
      cal:  f.calories_per_100g,
      pro:  f.protein_per_100g,
      carb: f.carbs_per_100g,
      fat:  f.fat_per_100g,
      fib:  f.fiber_per_100g,
      srv:  f.serving_size_g,
    })),
    // AUSNUT 2023 — skip alcoholic drinks
    ...AUSNUT_FOODS
      .filter(f => !ALCOHOL_RE.test(f.name))
      .map(f => ({
        name: f.name,
        cal:  f.calories_per_100g,
        pro:  f.protein_per_100g,
        carb: f.carbs_per_100g,
        fat:  f.fat_per_100g,
        fib:  f.fiber_per_100g,
        srv:  f.serving_size_g,
      })),
  ];

  let added = 0;
  db.exec('BEGIN TRANSACTION');
  try {
    for (const f of allFoods) {
      if (!f.name || !alreadyExists.get({ name: f.name })) {
        try {
          insert.run({ name: f.name, cal: f.cal ?? null, pro: f.pro ?? null, carb: f.carb ?? null, fat: f.fat ?? null, fib: f.fib ?? null, srv: f.srv ?? 100 });
          added++;
        } catch { /* skip duplicates */ }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (added > 0) console.log('Seeded ' + added + ' foods (NZFCD 14th Ed. + AUSNUT 2023 + extras)');

  removeUnwantedSeeds(db);

  // Mark this seed set as applied so subsequent boots skip the whole build.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seed_version', $v)").run({ v: SEED_VERSION });
}

// One-off cleanup of seeded foods that shouldn't be in a personal tracker
// (infant/toddler products, stray "Insect, raw" entry). Only removes
// rows that have never been logged, so it's safe to run on every startup.
const UNWANTED_SEED_NAMES = [
  'Insect, raw',
  "Babyccino, from cow's milk",
  'Babyccino, from dairy milk alternative',
  'Infant formula, 6-12 months, made with water',
  'Infant formula, 6-12 months, added omega-3 fatty acids, made with water',
  'Toddler milk, added omega-3 fatty acids, made with water',
  'Toddler milk, S26 Gold, made with water',
  'Toddler milk, soy, made with water',
  'Toddler milk, goat milk, made with water',
  'Toddler milk, goat milk, added omega-3 fatty acids, made with water',
  'Infant cereal, mixed grain, added vitamins & minerals',
  'Infant cereal, mixed grains, added vitamins & minerals, made with water',
  'Infant cereal, rice, added vitamin C & Fe',
  'Infant cereal, rice, added vitamin C & Fe, made with water',
  'Infant cereal, flavoured, added vitamins & minerals',
  'Infant cereal, flavoured, added vitamins & minerals, made with water',
  'Infant cereal, flavoured, purchased ready to eat',
  'Infant custard or yoghurt, dairy, commercial',
  'Infant custard or yoghurt, dairy, no added sugar, commercial',
  'Infant food, fruit, puree or stewed',
  'Infant food, fruit & vegetable, puree or stewed',
  'Infant pasta, added Fe, all grain types, uncooked',
  'Infant pasta, added Fe, all grain types, cooked',
  'Infant rusk, teething',
  'Infant snack, bar, grain based',
  'Infant snack, sweet biscuits',
  'Infant snack, bar, fruit based',
  'Infant food, fruit, vegetable & grain, puree or stewed',
  'Infant food, meat & vegetable, puree or mash',
  'Infant food, meat, vegetable & fruit, puree or mash',
  'Infant food, meat, vegetable & grain, puree or mash',
  'Infant food, pasta dish',
  'Infant food, rice dish',
  'Infant food, vegetables, puree or mash',
];

function removeUnwantedSeeds(db) {
  const del = db.prepare(
    "DELETE FROM foods WHERE name = $name AND source = 'nz_seed' AND use_count = 0"
  );
  let removed = 0;
  for (const name of UNWANTED_SEED_NAMES) {
    removed += del.run({ name }).changes;
  }
  if (removed > 0) console.log(`Removed ${removed} unwanted seed foods (infant/toddler products, etc.)`);
}

module.exports = { initDb, getDb, seedProfileDefaults, adoptOrphanData, countProfiles };
