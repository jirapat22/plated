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

    // Dedupe only auto-captured errors (an error loop can spam). Manual
    // submissions always go through — a user who sends twice means it.
    if (src !== 'manual' && isDuplicate(db, src, msg, stack)) {
      return res.status(202).json({ received: true, deduped: true });
    }

    const { id, orbit } = await captureReport({ source: src, type, message: msg, stack, context });
    res.status(201).json({ received: true, id, orbit_sent: orbit.sent, orbit_reason: orbit.reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bug-report/status — diagnose Orbit delivery. Never exposes the
// secret (only its presence/length so you can compare to what Orbit expects).
router.get('/status', (req, res) => {
  try {
    const db = getDb();
    const base = process.env.ORBIT_URL?.trim() || null;
    let host = null;
    try { host = base ? new URL(base).host : null; } catch { host = 'invalid URL'; }
    const unsent = db.prepare('SELECT COUNT(*) AS c FROM bug_reports WHERE orbit_sent = 0').get().c;
    const sent   = db.prepare('SELECT COUNT(*) AS c FROM bug_reports WHERE orbit_sent = 1').get().c;
    const latest = db.prepare('SELECT id, source, orbit_sent, created_at FROM bug_reports ORDER BY id DESC LIMIT 1').get() || null;
    res.json({
      orbit_configured: !!base,
      orbit_host:       host,                 // compare to orbit-production-3c19.up.railway.app
      forward_path:     '/api/bug-reports',
      secret_present:   !!process.env.INGEST_SECRET,
      secret_len:       (process.env.INGEST_SECRET || '').trim().length,
      unsent_count:     unsent,
      sent_count:       sent,
      latest_report:    latest,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bug-report/flush — force a retry of unsent reports right now.
router.post('/flush', async (req, res) => {
  try { res.json(await flushUnsent()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Retry any locally-stored reports that never reached Orbit (e.g. stored while
// ORBIT_URL was unset, or while Orbit was down). Best-effort; stops on failure
// so it retries next startup. Returns { flushed }.
async function flushUnsent(limit = 200) {
  if (!process.env.ORBIT_URL?.trim()) return { flushed: 0, reason: 'ORBIT_URL not configured' };
  const db = getDb();
  const rows = db.prepare('SELECT * FROM bug_reports WHERE orbit_sent = 0 ORDER BY id LIMIT $n').all({ n: limit });
  let flushed = 0;
  for (const r of rows) {
    let ctx = {};
    try { ctx = r.context ? JSON.parse(r.context) : {}; } catch { /* keep {} */ }
    const res = await sendToOrbit({ type: r.type, message: r.message, stack: r.stack, context: ctx, created_at: r.created_at });
    if (!res.sent) break;  // Orbit unreachable — leave the rest for next startup
    db.prepare('UPDATE bug_reports SET orbit_sent = 1 WHERE id = $id').run({ id: r.id });
    flushed++;
  }
  return { flushed };
}

module.exports = router;
module.exports.captureReport = captureReport;
module.exports.isDuplicate = isDuplicate;
module.exports.flushUnsent = flushUnsent;
