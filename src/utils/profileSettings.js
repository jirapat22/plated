// Every profile_settings row for one profile as a plain { key: value } object.
// A leaf module (src/utils rule: no route-to-route requires) because the
// settings routes, the report builder and the export payload all read it.

'use strict';

function allSettings(db, pid) {
  const rows = db.prepare(
    'SELECT key, value FROM profile_settings WHERE profile_id = $pid'
  ).all({ pid });
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

module.exports = { allSettings };
