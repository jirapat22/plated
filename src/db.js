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

  const foods = [
    // ── Proteins ───────────────────────────────────────────────
    { name:'Chicken Breast (Raw)',         cal:165, pro:31,  carb:0,    fat:3.6, fib:0,   srv:150 },
    { name:'Chicken Breast (Cooked)',      cal:185, pro:35,  carb:0,    fat:4,   fib:0,   srv:150 },
    { name:'Chicken Thigh (Raw)',          cal:175, pro:18,  carb:0,    fat:11,  fib:0,   srv:130 },
    { name:'Chicken Mince',               cal:150, pro:17,  carb:0,    fat:9,   fib:0,   srv:120 },
    { name:'Basa Fillet',                 cal:90,  pro:18,  carb:0,    fat:1.5, fib:0,   srv:120 },
    { name:'Salmon (Atlantic)',            cal:208, pro:20,  carb:0,    fat:13,  fib:0,   srv:150 },
    { name:'Tuna (Canned in Water)',       cal:116, pro:26,  carb:0,    fat:1,   fib:0,   srv:95  },
    { name:'Snapper Fillet',              cal:100, pro:20,  carb:0,    fat:1.3, fib:0,   srv:150 },
    { name:'Beef Mince (Lean)',            cal:180, pro:20,  carb:0,    fat:11,  fib:0,   srv:120 },
    { name:'Beef Mince (Regular)',         cal:250, pro:17,  carb:0,    fat:20,  fib:0,   srv:120 },
    { name:'Beef Steak',                  cal:200, pro:26,  carb:0,    fat:10,  fib:0,   srv:180 },
    { name:'Lamb Mince',                  cal:235, pro:18,  carb:0,    fat:18,  fib:0,   srv:120 },
    { name:'Pork Mince',                  cal:185, pro:17,  carb:0,    fat:13,  fib:0,   srv:120 },
    { name:'Egg (Whole)',                  cal:155, pro:13,  carb:1.1,  fat:11,  fib:0,   srv:60  },
    { name:'Egg White',                   cal:52,  pro:11,  carb:0.7,  fat:0.2, fib:0,   srv:30  },
    { name:'Tofu (Firm)',                  cal:76,  pro:8,   carb:2,    fat:4,   fib:0.3, srv:100 },
    { name:'Edamame (Shelled)',            cal:122, pro:11,  carb:10,   fat:5,   fib:5,   srv:150 },
    { name:'Prawns / Shrimp',             cal:99,  pro:24,  carb:0,    fat:0.3, fib:0,   srv:100 },
    { name:'Cottage Cheese',              cal:98,  pro:11,  carb:3.4,  fat:4.3, fib:0,   srv:100 },
    { name:'Whey Protein Powder',         cal:380, pro:75,  carb:10,   fat:5,   fib:1,   srv:30  },
    { name:'Tempeh',                      cal:193, pro:19,  carb:9,    fat:11,  fib:5,   srv:100 },

    // ── Frozen Vegetables ──────────────────────────────────────
    { name:'Frozen Peas',                 cal:77,  pro:5,   carb:14,   fat:0.4, fib:5,   srv:80  },
    { name:'Frozen Corn',                 cal:86,  pro:3,   carb:19,   fat:1,   fib:2,   srv:80  },
    { name:'Frozen Broccoli',             cal:28,  pro:3,   carb:5,    fat:0.3, fib:3,   srv:100 },
    { name:'Frozen Spinach',              cal:23,  pro:3,   carb:3,    fat:0.3, fib:3,   srv:100 },
    { name:'Frozen Mixed Vegetables',     cal:55,  pro:3,   carb:10,   fat:0.3, fib:3,   srv:100 },
    { name:'Frozen Edamame (Shelled)',    cal:122, pro:11,  carb:10,   fat:5,   fib:5,   srv:150 },
    { name:'Frozen Green Beans',          cal:31,  pro:2,   carb:7,    fat:0.1, fib:3,   srv:100 },
    { name:'Frozen Cauliflower',          cal:25,  pro:2,   carb:5,    fat:0.1, fib:2,   srv:100 },
    { name:'Frozen Asian Stir Fry Mix',   cal:40,  pro:2,   carb:7,    fat:0.3, fib:2,   srv:150 },
    { name:'Frozen Baby Carrots',         cal:41,  pro:0.9, carb:10,   fat:0.2, fib:3,   srv:100 },
    { name:'Frozen Peas & Corn',          cal:82,  pro:4,   carb:16,   fat:0.7, fib:3.5, srv:80  },

    // ── Carbohydrates ──────────────────────────────────────────
    { name:'White Rice (Raw)',            cal:365, pro:7,   carb:80,   fat:0.6, fib:0.4, srv:75  },
    { name:'White Rice (Cooked)',         cal:130, pro:2.7, carb:28,   fat:0.3, fib:0.4, srv:200 },
    { name:'Brown Rice (Cooked)',         cal:123, pro:2.7, carb:26,   fat:1,   fib:1.8, srv:200 },
    { name:'Basmati Rice (Cooked)',       cal:121, pro:3.5, carb:25,   fat:0.4, fib:0.7, srv:200 },
    { name:'Rolled Oats',                 cal:389, pro:17,  carb:66,   fat:7,   fib:10,  srv:60  },
    { name:'White Bread',                 cal:265, pro:9,   carb:49,   fat:3,   fib:2,   srv:35  },
    { name:'Wholegrain Bread',            cal:250, pro:10,  carb:41,   fat:4,   fib:7,   srv:35  },
    { name:'Pasta (Dry)',                 cal:371, pro:13,  carb:74,   fat:1.5, fib:3,   srv:80  },
    { name:'Pasta (Cooked)',              cal:158, pro:5.8, carb:31,   fat:0.9, fib:1.8, srv:200 },
    { name:'Potato',                      cal:77,  pro:2,   carb:17,   fat:0.1, fib:2,   srv:150 },
    { name:'Kumara (Sweet Potato)',       cal:86,  pro:1.6, carb:20,   fat:0.1, fib:3,   srv:150 },
    { name:'Quinoa (Cooked)',             cal:120, pro:4.4, carb:22,   fat:1.9, fib:2.8, srv:185 },
    { name:'Pita Bread',                  cal:275, pro:9,   carb:55,   fat:1.5, fib:2,   srv:60  },
    { name:'Corn Tortilla',               cal:218, pro:5.7, carb:46,   fat:2.5, fib:4,   srv:45  },
    { name:'Couscous (Cooked)',           cal:112, pro:3.8, carb:23,   fat:0.2, fib:1.4, srv:180 },
    { name:'Noodles (Cooked)',            cal:138, pro:4.5, carb:27,   fat:1.5, fib:1,   srv:200 },

    // ── Dairy ──────────────────────────────────────────────────
    { name:'Milk (Trim)',                 cal:34,  pro:3.4, carb:5,    fat:0.1, fib:0,   srv:250 },
    { name:'Milk (Full Fat)',             cal:61,  pro:3.2, carb:4.8,  fat:3.3, fib:0,   srv:250 },
    { name:'Greek Yoghurt (Plain)',       cal:97,  pro:9,   carb:4,    fat:5,   fib:0,   srv:200 },
    { name:'Greek Yoghurt (Non-Fat)',     cal:59,  pro:10,  carb:3.6,  fat:0.4, fib:0,   srv:200 },
    { name:'Cheddar Cheese',             cal:403, pro:25,  carb:1.3,  fat:33,  fib:0,   srv:30  },
    { name:'Mozzarella',                 cal:280, pro:28,  carb:2.2,  fat:17,  fib:0,   srv:30  },
    { name:'Cream Cheese',               cal:342, pro:6,   carb:4.1,  fat:34,  fib:0,   srv:30  },

    // ── Vegetables (Fresh) ─────────────────────────────────────
    { name:'Broccoli',                   cal:34,  pro:2.8, carb:7,    fat:0.4, fib:2.6, srv:100 },
    { name:'Spinach',                    cal:23,  pro:2.9, carb:3.6,  fat:0.4, fib:2.2, srv:100 },
    { name:'Carrot',                     cal:41,  pro:0.9, carb:10,   fat:0.2, fib:2.8, srv:100 },
    { name:'Capsicum (Bell Pepper)',      cal:31,  pro:1,   carb:6,    fat:0.3, fib:2.1, srv:100 },
    { name:'Zucchini / Courgette',       cal:17,  pro:1.2, carb:3.1,  fat:0.3, fib:1,   srv:100 },
    { name:'Cucumber',                   cal:16,  pro:0.7, carb:3.6,  fat:0.1, fib:0.5, srv:100 },
    { name:'Onion',                      cal:40,  pro:1.1, carb:9,    fat:0.1, fib:1.7, srv:100 },
    { name:'Garlic',                     cal:149, pro:6.4, carb:33,   fat:0.5, fib:2.1, srv:5   },
    { name:'Tomato',                     cal:18,  pro:0.9, carb:3.9,  fat:0.2, fib:1.2, srv:100 },
    { name:'Mushroom',                   cal:22,  pro:3.1, carb:3.3,  fat:0.3, fib:1,   srv:100 },
    { name:'Lettuce / Salad Greens',     cal:15,  pro:1.4, carb:2.9,  fat:0.2, fib:1.8, srv:50  },

    // ── Fruit ──────────────────────────────────────────────────
    { name:'Banana',                     cal:89,  pro:1.1, carb:23,   fat:0.3, fib:2.6, srv:120 },
    { name:'Apple',                      cal:52,  pro:0.3, carb:14,   fat:0.2, fib:2.4, srv:150 },
    { name:'Blueberries',                cal:57,  pro:0.7, carb:14,   fat:0.3, fib:2.4, srv:100 },
    { name:'Strawberries',               cal:32,  pro:0.7, carb:7.7,  fat:0.3, fib:2,   srv:100 },
    { name:'Avocado',                    cal:160, pro:2,   carb:9,    fat:15,  fib:7,   srv:100 },
    { name:'Mango',                      cal:60,  pro:0.8, carb:15,   fat:0.4, fib:1.6, srv:150 },
    { name:'Orange',                     cal:47,  pro:0.9, carb:12,   fat:0.1, fib:2.4, srv:130 },

    // ── Fats & Extras ──────────────────────────────────────────
    { name:'Olive Oil',                  cal:884, pro:0,   carb:0,    fat:100, fib:0,   srv:15  },
    { name:'Coconut Oil',                cal:862, pro:0,   carb:0,    fat:100, fib:0,   srv:15  },
    { name:'Peanut Butter',              cal:588, pro:25,  carb:20,   fat:50,  fib:6,   srv:30  },
    { name:'Almonds',                    cal:579, pro:21,  carb:22,   fat:50,  fib:12.5,srv:30  },
    { name:'Cashews',                    cal:553, pro:18,  carb:30,   fat:44,  fib:3.3, srv:30  },
    { name:'Mixed Nuts',                 cal:607, pro:20,  carb:20,   fat:54,  fib:5,   srv:30  },
    { name:'Chia Seeds',                 cal:486, pro:17,  carb:42,   fat:31,  fib:34,  srv:15  },
    { name:'Soy Sauce',                  cal:60,  pro:6,   carb:6,    fat:0,   fib:0,   srv:15  },
    { name:'Sriracha',                   cal:93,  pro:1.3, carb:18,   fat:2.2, fib:0,   srv:10  },
  ];

  let added = 0;
  for (const f of foods) {
    if (!alreadyExists.get({ name: f.name })) {
      insert.run({ name: f.name, cal: f.cal, pro: f.pro, carb: f.carb, fat: f.fat, fib: f.fib, srv: f.srv });
      added++;
    }
  }
  if (added > 0) console.log(`Seeded ${added} NZ foods`);
}

module.exports = { initDb, getDb };
