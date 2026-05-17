const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT t.id, t.name, t.created_at, COUNT(ti.id) AS item_count
      FROM meal_templates t
      LEFT JOIN meal_template_items ti ON ti.template_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/items', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT ti.id, ti.food_id, ti.food_name, ti.quantity_g,
             f.calories_per_100g, f.protein_per_100g, f.carbs_per_100g, f.fat_per_100g
      FROM meal_template_items ti
      LEFT JOIN foods f ON f.id = ti.food_id
      WHERE ti.template_id = $id
    `).all({ id: req.params.id });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, items } = req.body;
    if (!name?.trim() || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'name and items[] required' });
    }
    const db = getDb();
    const result = db.prepare('INSERT INTO meal_templates (name) VALUES ($name)')
      .run({ name: name.trim() });
    const id = result.lastInsertRowid;
    const insertItem = db.prepare(
      'INSERT INTO meal_template_items (template_id, food_id, food_name, quantity_g) VALUES ($tid, $fid, $fname, $qty)'
    );
    db.exec('BEGIN TRANSACTION');
    try {
      for (const item of items) {
        insertItem.run({ tid: id, fid: item.food_id, fname: item.food_name || '', qty: item.quantity_g });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.status(201).json(db.prepare('SELECT * FROM meal_templates WHERE id = $id').get({ id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = getDb()
      .prepare('DELETE FROM meal_templates WHERE id = $id')
      .run({ id: req.params.id });
    if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
