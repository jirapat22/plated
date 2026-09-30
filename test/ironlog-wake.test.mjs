// One retry when IronLog is waking, never when it answered.
//
// Railway App Sleeping stops IronLog after ~10 minutes idle, so Plated's first
// call after a quiet afternoon pays a container start. That looks like a
// timeout, a refused connection, or a 502 from the proxy — and a thrown
// getProfile makes /api/ironlog/today answer `connected: false`, which puts
// "IronLog disconnected" on Today for a service that is merely asleep, with
// nothing to retry it until the view is opened again.
//
// The URL guard correctly refuses loopback, so this cannot be driven end to
// end without weakening an SSRF check that exists for good reason. The retry
// DECISION is pure, so it is pinned here instead — an off-by-one is a retry
// loop against someone else's server.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { shouldRetryIron } = require_('../src/routes/ironlog.js');

test('a waking service is retried exactly once', () => {
  for (const status of [null, 502, 503, 504]) {
    assert.strictEqual(shouldRetryIron(status, false), true,
      `${status ?? 'transport failure'} should get one retry`);
    assert.strictEqual(shouldRetryIron(status, true), false,
      `${status ?? 'transport failure'} retried twice — that is a loop`);
  }
});

test('an answer is never retried', () => {
  // These are things IronLog said, not symptoms of it starting up. Asking
  // again wastes a round trip and, on 401, re-sends a key already refused.
  for (const status of [200, 400, 401, 403, 404, 409, 422, 500]) {
    assert.strictEqual(shouldRetryIron(status, false), false,
      `HTTP ${status} was retried, but it is an answer`);
  }
});
