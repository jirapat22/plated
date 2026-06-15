const express = require('express');
const { getDb } = require('../db');

const router = express.Router();
const APP_NAME = 'plated';

// Forward a report to the shared Orbit dashboard. Best-effort/fire-and-forget:
// never throws, never blocks. No-ops if ORBIT_URL isn't configured.
async function sendToOrbit({ type, message, stack, context, created_at }) {
  const base   = process.env.ORBIT_URL?.trim();
  const secret = process.env.INGEST_SECRET?.trim();
  if (!base) return { sent: false, reason: 'ORBIT_URL not configured' };
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/api/bug-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-API-Key': secret } : {}) },
      body: JSON.stringify({
        app: APP_NAME,
        type: type || 'bug_report',
        message,
        stack: stack || null,
        context: context ?? {},
        created_at: created_at || new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(6000),
    });
    return { sent: resp.ok, reason: resp.ok ? undefined : `Orbit returned ${resp.status}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// Was an identical (source, message, stack) report stored in the last 5 minutes?
function isDuplicate(db, source, message, stack) {
  return !!db.prepare(`
    SELECT 1 FROM bug_reports
    WHERE source = $source AND message = $message
      AND IFNULL(stack,'') = IFNULL($stack,'')
      AND created_at >= datetime('now', '-5 minutes')
    LIMIT 1
  `).get({ source, message, stack: stack ?? null });
}

// Store a report locally, then try to forward it to Orbit (best-effort).
// Returns { id, orbit }. Used by the endpoint AND the backend error handler.
async function captureReport({ source, type, message, stack, context }) {
  const db = getDb();
  const ctxStr = context == null ? null
    : (typeof context === 'string' ? context : JSON.stringify(context));
  const created_at = new Date().toISOString();

  const info = db.prepare(`
    INSERT INTO bug_reports (source, type, message, stack, context, orbit_sent, created_at)
    VALUES ($source, $type, $message, $stack, $context, 0, $created_at)
  `).run({
    source,
    type: type || 'bug_report',
    message,
    stack: stack ?? null,
    context: ctxStr,
    created_at,
  });

  const orbit = await sendToOrbit({ type, message, stack, context: context ?? {}, created_at });
  if (orbit.sent) {
    db.prepare('UPDATE bug_reports SET orbit_sent = 1 WHERE id = $id').run({ id: info.lastInsertRowid });
  }
  return { id: info.lastInsertRowid, orbit };
}

// POST /api/bug-report — manual + frontend-automatic reports
router.post('/', async (req, res) => {
  try {
    const { source, type, message, stack, context } = req.body || {};
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg) return res.status(400).json({ error: 'message is required' });

    const src = ['frontend', 'backend', 'manual'].includes(source) ? source : 'manual';
    const db = getDb();

    if (isDuplicate(db, src, msg, stack)) {
      return res.status(202).json({ received: true, deduped: true });
    }

    const { id, orbit } = await captureReport({ source: src, type, message: msg, stack, context });
    res.status(201).json({ received: true, id, orbit_sent: orbit.sent, orbit_reason: orbit.reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.captureReport = captureReport;
module.exports.isDuplicate = isDuplicate;
