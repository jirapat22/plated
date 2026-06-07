const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// List — unchecked items first (newest first), then checked items
router.get('/', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT * FROM notes
      ORDER BY done ASC, created_at DESC
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const text = req.body.text?.trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const db = getDb();
    const result = db.prepare('INSERT INTO notes (text) VALUES ($text)').run({ text });
    const note = db.prepare('SELECT * FROM notes WHERE id = $id').get({ id: result.lastInsertRowid });
    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const note = db.prepare('SELECT * FROM notes WHERE id = $id').get({ id });
    if (!note) return res.status(404).json({ error: 'Note not found' });

    if (req.body.text !== undefined) {
      const text = req.body.text?.trim();
      if (!text) return res.status(400).json({ error: 'text cannot be empty' });
      db.prepare('UPDATE notes SET text = $text WHERE id = $id').run({ text, id });
    }
    if (req.body.done !== undefined) {
      db.prepare('UPDATE notes SET done = $done WHERE id = $id').run({ done: req.body.done ? 1 : 0, id });
    }

    res.json(db.prepare('SELECT * FROM notes WHERE id = $id').get({ id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = getDb().prepare('DELETE FROM notes WHERE id = $id').run({ id: req.params.id });
    if (result.changes === 0) return res.status(404).json({ error: 'Note not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
