const { DatabaseSync } = require('node:sqlite');
const path = require('path');

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
    { key: 'ironlog_api_url',   value: ''         },
    { key: 'protein_multiplier',value: '2.2'      },
    { key: 'phase',             value: 'maintain' },
    { key: 'tdee',              value: ''         },
    { key: 'cut_deficit',       value: '500'      },
    { key: 'bulk_surplus',      value: '300'      },
  ].forEach(d => setDefault.run(d));

  console.log(`DB ready: ${dbPath}`);
  return db;
}

module.exports = { initDb, getDb };
