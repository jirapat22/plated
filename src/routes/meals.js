const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

function round1(n) { return Math.round(n * 10) / 10; }

function calcMacros(food, qty) {
  const r = qty / 100;
  return {
    calories: food.calories_per_100g != null ? round1(food.calories_per_100g * r) : null,
    protein:  food.protein_per_100g  != null ? round1(food.protein_per_100g  * r) : null,
    carbs:    food.carbs_per_100g    != null ? round1(food.carbs_per_100g    * r) : null,
    fat:      food.fat_per_100g      != null ? round1(food.fat_per_100g      * r) : null,
    fiber:    food.fiber_per_100g    != null ? round1(food.fiber_per_100g    * r) : null,
  };
}

function sumTotals(sessions) {
  return sessions.reduce(
    (acc, s) => {
      for (const e of s.entries) {
        acc.calories += e.calories || 0;
        acc.protein  += e.protein  || 0;
        acc.carbs    += e.carbs    || 0;
        acc.fat      += e.fat      || 0;
        acc.fiber    += e.fiber    || 0;
      }
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  );
}

function loadDay(db, date) {
  const sessions = db.prepare(`
    SELECT * FROM meal_sessions WHERE date = $date ORDER BY meal_index ASC
  `).all({ date });

  return sessions.map(s => {
    const entries = db.prepare(`
      SELECT me.*, f.name AS food_name, f.brand AS food_brand,
             f.calories_per_100g, f.protein_per_100g, f.carbs_per_100g,
             f.fat_per_100g, f.fiber_per_100g, f.serving_size_g
      FROM meal_entries me
      JOIN foods f ON f.id = me.food_id
      WHERE me.meal_session_id = $sid
      ORDER BY me.logged_at ASC
    `).all({ sid: s.id });
    return { ...s, entries };
  });
}

// GET /api/meals/today
router.get('/today', (req, res) => {
  try {
    const db = getDb();
    const date = new Date().toISOString().split('T')[0];
    const sessions = loadDay(db, date);
    res.json({ date, sessions, totals: sumTotals(sessions) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meals/day/:date
router.get('/day/:date', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
    }
    const db = getDb();
    const sessions = loadDay(db, date);
    res.json({ date, sessions, totals: sumTotals(sessions) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meals/summary?days=30  — aggregate totals per date
router.get('/summary', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const rows = getDb().prepare(`
      SELECT
        ms.date,
        COALESCE(SUM(me.calories), 0) AS calories,
        COALESCE(SUM(me.protein),  0) AS protein,
        COALESCE(SUM(me.carbs),    0) AS carbs,
        COALESCE(SUM(me.fat),      0) AS fat,
        COALESCE(SUM(me.fiber),    0) AS fiber
      FROM meal_sessions ms
      LEFT JOIN meal_entries me ON me.meal_session_id = ms.id
      WHERE ms.date >= date('now', $offset)
      GROUP BY ms.date
      ORDER BY ms.date ASC
    `).all({ offset: `-${days} days` });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/meals/sessions/:id — rename and/or move date
router.patch('/sessions/:id', (req, res) => {
  try {
    const { name, date } = req.body;
    if (!name && !date) return res.status(400).json({ error: 'name or date required' });
    const db = getDb();
    if (name?.trim()) {
      db.prepare('UPDATE meal_sessions SET name = $name WHERE id = $id')
        .run({ name: name.trim(), id: req.params.id });
    }
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      // Recalculate meal_index so it doesn't collide with existing sessions on target date
      const { max_idx } = db.prepare(
        'SELECT COALESCE(MAX(meal_index), 0) AS max_idx FROM meal_sessions WHERE date = $date AND id != $id'
      ).get({ date, id: req.params.id });
      db.prepare('UPDATE meal_sessions SET date = $date, meal_index = $idx WHERE id = $id')
        .run({ date, idx: max_idx + 1, id: req.params.id });
    }
    const session = db.prepare('SELECT * FROM meal_sessions WHERE id = $id').get({ id: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions — create new meal session for a date
router.post('/sessions', (req, res) => {
  try {
    const db = getDb();
    const date = req.body.date || new Date().toISOString().split('T')[0];

    const { max_idx } = db.prepare(`
      SELECT COALESCE(MAX(meal_index), 0) AS max_idx
      FROM meal_sessions WHERE date = $date
    `).get({ date });

    const meal_index = max_idx + 1;
    const name = (req.body.name?.trim()) || `Meal ${meal_index}`;
    const result = db.prepare(
      'INSERT INTO meal_sessions (date, name, meal_index) VALUES ($date, $name, $meal_index)'
    ).run({ date, name, meal_index });

    const session = db.prepare('SELECT * FROM meal_sessions WHERE id = $id')
      .get({ id: result.lastInsertRowid });
    res.status(201).json({ ...session, entries: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions/:id/entries
router.post('/sessions/:id/entries', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { food_id, quantity_g } = req.body;

    if (!food_id || !quantity_g || quantity_g <= 0) {
      return res.status(400).json({ error: 'food_id and quantity_g > 0 required' });
    }

    const session = db.prepare('SELECT * FROM meal_sessions WHERE id = $id').get({ id });
    if (!session) return res.status(404).json({ error: 'Meal session not found' });

    const food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: food_id });
    if (!food) return res.status(404).json({ error: 'Food not found' });

    const macros = calcMacros(food, quantity_g);
    const result = db.prepare(`
      INSERT INTO meal_entries
        (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber)
      VALUES
        ($sid, $food_id, $quantity_g, $calories, $protein, $carbs, $fat, $fiber)
    `).run({
      sid: id, food_id, quantity_g,
      calories: macros.calories, protein: macros.protein,
      carbs: macros.carbs, fat: macros.fat, fiber: macros.fiber,
    });

    db.prepare('UPDATE foods SET use_count = use_count + 1 WHERE id = $id')
      .run({ id: food_id });

    const entry = db.prepare(`
      SELECT me.*, f.name AS food_name, f.brand AS food_brand, f.serving_size_g
      FROM meal_entries me
      JOIN foods f ON f.id = me.food_id
      WHERE me.id = $id
    `).get({ id: result.lastInsertRowid });

    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/meals/entries/:id — update quantity
router.patch('/entries/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { quantity_g } = req.body;

    if (!quantity_g || quantity_g <= 0) {
      return res.status(400).json({ error: 'quantity_g must be > 0' });
    }

    const entry = db.prepare('SELECT * FROM meal_entries WHERE id = $id').get({ id });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: entry.food_id });
    const macros = calcMacros(food, quantity_g);

    db.prepare(`
      UPDATE meal_entries
      SET quantity_g = $qty, calories = $calories, protein = $protein,
          carbs = $carbs, fat = $fat, fiber = $fiber
      WHERE id = $id
    `).run({ id, qty: quantity_g, ...macros });

    const updated = db.prepare(`
      SELECT me.*, f.name AS food_name, f.brand AS food_brand, f.serving_size_g
      FROM meal_entries me
      JOIN foods f ON f.id = me.food_id
      WHERE me.id = $id
    `).get({ id });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/meals/entries/:id
router.delete('/entries/:id', (req, res) => {
  try {
    const result = getDb()
      .prepare('DELETE FROM meal_entries WHERE id = $id')
      .run({ id: req.params.id });
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/meals/sessions/:id (cascades to entries)
router.delete('/sessions/:id', (req, res) => {
  try {
    const result = getDb()
      .prepare('DELETE FROM meal_sessions WHERE id = $id')
      .run({ id: req.params.id });
    if (result.changes === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
