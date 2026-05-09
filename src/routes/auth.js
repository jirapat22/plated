const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 10;

function signToken() {
  return jwt.sign({ app: 'plated' }, process.env.JWT_SECRET || 'dev_secret', {
    expiresIn: '24h',
  });
}

// Check whether a passcode has been set (no auth needed)
router.get('/status', (req, res) => {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = $key')
      .get({ key: 'passcode_hash' });
    res.json({ hasPasscode: !!(row && row.value) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// First-time setup — only works when no passcode exists yet
router.post('/setup', async (req, res) => {
  try {
    const { passcode } = req.body;
    if (!passcode || !/^\d{4,6}$/.test(passcode)) {
      return res.status(400).json({ error: 'Passcode must be 4-6 digits' });
    }

    const db = getDb();
    const existing = db
      .prepare('SELECT value FROM settings WHERE key = $key')
      .get({ key: 'passcode_hash' });
    if (existing && existing.value) {
      return res
        .status(409)
        .json({ error: 'Passcode already set — use /api/auth/change' });
    }

    const hash = await bcrypt.hash(passcode, SALT_ROUNDS);
    db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)'
    ).run({ key: 'passcode_hash', value: hash });

    res.json({ token: signToken() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify passcode → return JWT
router.post('/verify', async (req, res) => {
  try {
    const { passcode } = req.body;
    if (!passcode) return res.status(400).json({ error: 'Passcode required' });

    const db = getDb();
    const row = db
      .prepare('SELECT value FROM settings WHERE key = $key')
      .get({ key: 'passcode_hash' });
    if (!row || !row.value) {
      return res.status(404).json({ error: 'No passcode set' });
    }

    const valid = await bcrypt.compare(String(passcode), row.value);
    if (!valid) return res.status(401).json({ error: 'Invalid passcode' });

    res.json({ token: signToken() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change passcode (requires valid JWT + current passcode)
router.post('/change', authenticateToken, async (req, res) => {
  try {
    const { currentPasscode, newPasscode } = req.body;
    if (!newPasscode || !/^\d{4,6}$/.test(newPasscode)) {
      return res.status(400).json({ error: 'New passcode must be 4-6 digits' });
    }

    const db = getDb();
    const row = db
      .prepare('SELECT value FROM settings WHERE key = $key')
      .get({ key: 'passcode_hash' });

    if (row && row.value) {
      if (!currentPasscode) {
        return res.status(400).json({ error: 'Current passcode required' });
      }
      const valid = await bcrypt.compare(String(currentPasscode), row.value);
      if (!valid) {
        return res.status(401).json({ error: 'Current passcode incorrect' });
      }
    }

    const hash = await bcrypt.hash(newPasscode, SALT_ROUNDS);
    db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)'
    ).run({ key: 'passcode_hash', value: hash });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
