// Writes made with no connection, held on the device until there is one.
//
// Page-driven, not Background Sync. Background Sync does not exist on iOS
// Safari, which is most of this app's install base, and the queue needs the
// session token — which lives in page state, not in the worker. So the flush is
// an ordinary fetch from an ordinary page, triggered when the browser says it
// is back online and again on every boot.
//
// Only writes the server can recognise twice go in here. Every queued request
// carries a client_id, and the routes behind them replay the stored response
// instead of repeating the work — without that, a flush that half-succeeds
// before the signal drops would log your dinner twice and take the grams out of
// a batch twice with it.

import { api } from '../api.js';
import { enqueue, queued, dequeue, bumpTries, newClientId } from './offlineStore.js';

// Fired whenever the pending count changes, so the UI can show it without this
// module knowing anything about the UI.
const CHANGED = 'plated:queue-changed';
const announce = () => window.dispatchEvent(new CustomEvent(CHANGED));
export const onQueueChanged = fn => window.addEventListener(CHANGED, fn);

// Give up after this many failed attempts. Not infinite: a request that the
// server keeps rejecting with a 500 would otherwise be retried forever on every
// launch, and a queue that never drains is worse than a lost entry you were
// told about.
const MAX_TRIES = 5;

let flushing = false;

// What to do with a failed send. Pulled out and exported because the cost of
// getting one of these wrong is lopsided: 'hold' costs a retry, 'drop' loses a
// meal someone logged with no way to know it went. Worth testing directly
// rather than through a queue that needs IndexedDB to exist.
//
//   'stop' — leave this and everything after it, try the whole queue later
//   'hold' — leave this one, count the attempt
//   'drop' — it can never succeed; discard and tell the user
export function classifyFailure(err, tries, max = MAX_TRIES) {
  // Checked BEFORE status on purpose. The service worker answers an unsendable
  // request with a synthetic 503, so classifying by status would read "no
  // signal" as a server fault, burn a retry on every pocket launch, and hit the
  // ceiling after five — silently discarding a meal because the phone was in a
  // basement.
  if (err.offline || err.unreachable) return 'stop';
  // The session expired while this sat in the queue. api.js has already bounced
  // to the lock screen; the write is still perfectly valid once they log back
  // in. This is the single most important 'not a drop' in the function.
  if (/session expired/i.test(err.message || '')) return 'stop';
  // A 4xx that is not auth will never succeed however many times it is sent —
  // the food was deleted, the date was rejected, the body is malformed.
  if (err.status >= 400 && err.status < 500) return 'drop';
  return (tries + 1) >= max ? 'drop' : 'hold';
}

// Queue a write and hand back the optimistic client_id. Callers use it as the
// local key for whatever they draw on screen in the meantime.
export async function queueWrite(profileId, path, body) {
  const client_id = newClientId();
  await enqueue(profileId, { path, body: { ...body, client_id }, clientId: client_id });
  announce();
  return client_id;
}

export async function pendingCount(profileId) {
  return (await queued(profileId)).length;
}

// Send everything held for this profile, oldest first. Order matters: two meals
// logged offline should land in the order they were eaten.
//
// Returns { sent, failed, held }.
export async function flushQueue(profileId) {
  if (flushing || profileId == null || !navigator.onLine) return { sent: 0, failed: 0, held: 0 };
  flushing = true;
  let sent = 0, failed = 0, held = 0;
  try {
    for (const row of await queued(profileId)) {
      try {
        await api.post(row.path, row.body);
        await dequeue(row.id);
        sent++;
      } catch (err) {
        const verdict = classifyFailure(err, row.tries || 0);
        if (verdict === 'stop') { held++; break; }   // everything left keeps its place
        if (verdict === 'drop') { await dequeue(row.id); failed++; continue; }
        await bumpTries(row.id, (row.tries || 0) + 1);
        held++;
      }
    }
  } finally {
    flushing = false;
    if (sent || failed) announce();
  }
  return { sent, failed, held };
}

// Flush on reconnect and at boot. Idempotency on the server is what makes this
// safe to fire more often than strictly necessary.
export function startQueue(getProfileId, onResult) {
  const run = async () => {
    const pid = getProfileId();
    if (pid == null) return;
    const r = await flushQueue(pid);
    if (r.sent || r.failed) onResult?.(r);
  };
  window.addEventListener('online', run);
  // Coming back to a backgrounded PWA is the other moment a phone regains
  // signal without ever firing 'online'.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
  return run;
}
