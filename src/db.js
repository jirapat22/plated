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
      date  TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (date, key)
    );

    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT    NOT NULL,
      done       INTEGER DEFAULT 0,
      created_at TEXT    DEFAULT (datetime('now'))
    );
  `);

  const setDefault = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES ($key, $value)'
  );
  [
    { key: 'calorie_goal',      value: '2000' },
    { key: 'protein_goal',      value: '150'  },
    { key: 'carb_goal',         value: '250'  },
    { key: 'fat_goal',          value: '65'   },
    { key: 'fiber_goal',        value: '30'   },
    { key: 'water_goal_ml',     value: '2500' },
    { key: 'ironlog_api_url',      value: ''         },
    { key: 'ironlog_last_synced',  value: ''         },
    { key: 'protein_multiplier',value: '2.2'      },
    { key: 'energy_unit',       value: 'kcal'     },
    { key: 'phase',             value: 'maintain' },
    { key: 'tdee',              value: ''         },
    { key: 'cut_deficit',       value: '500'      },
    { key: 'bulk_surplus',      value: '300'      },
  ].forEach(d => setDefault.run(d));

  seedNzFoods(db);

  console.log(`DB ready: ${dbPath}`);
  return db;
}

function seedNzFoods(db) {
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

module.exports = { initDb, getDb };
