const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'envios.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL UNIQUE,
    name       TEXT,
    status     TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
    error      TEXT,
    sent_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS send_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    phone      TEXT NOT NULL,
    status     TEXT NOT NULL, -- sent | failed
    message    TEXT,
    image      TEXT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const stmts = {
  insertContact: db.prepare('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)'),
  updateName: db.prepare("UPDATE contacts SET name = ? WHERE phone = ? AND (name IS NULL OR name = '')"),
  getContact: db.prepare('SELECT * FROM contacts WHERE id = ?'),
  nextPending: db.prepare("SELECT * FROM contacts WHERE status = 'pending' ORDER BY id LIMIT 1"),
  markSent: db.prepare("UPDATE contacts SET status = 'sent', error = NULL, sent_at = datetime('now', 'localtime') WHERE id = ?"),
  markFailed: db.prepare("UPDATE contacts SET status = 'failed', error = ? WHERE id = ?"),
  resetContact: db.prepare("UPDATE contacts SET status = 'pending', error = NULL, sent_at = NULL WHERE id = ?"),
  deleteContact: db.prepare('DELETE FROM contacts WHERE id = ?'),
  deletePending: db.prepare("DELETE FROM contacts WHERE status != 'sent'"),
  counts: db.prepare('SELECT status, COUNT(*) AS n FROM contacts GROUP BY status'),
  log: db.prepare('INSERT INTO send_log (contact_id, phone, status, message, image, error) VALUES (?, ?, ?, ?, ?, ?)'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

const addContacts = db.transaction((items) => {
  let added = 0;
  let existing = 0;
  for (const { phone, name } of items) {
    const r = stmts.insertContact.run(phone, name || null);
    if (r.changes) added++;
    else {
      existing++;
      if (name) stmts.updateName.run(name, phone);
    }
  }
  return { added, existing };
});

function listContacts(status) {
  if (status && status !== 'all') {
    return db.prepare('SELECT * FROM contacts WHERE status = ? ORDER BY id').all(status);
  }
  return db.prepare('SELECT * FROM contacts ORDER BY id').all();
}

function counts() {
  const out = { pending: 0, sent: 0, failed: 0, total: 0 };
  for (const row of stmts.counts.all()) {
    out[row.status] = row.n;
    out.total += row.n;
  }
  return out;
}

function getSetting(key, fallback = null) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  stmts.setSetting.run(key, value);
}

module.exports = {
  DATA_DIR,
  addContacts,
  listContacts,
  counts,
  getContact: (id) => stmts.getContact.get(id),
  nextPending: () => stmts.nextPending.get(),
  markSent: (id) => stmts.markSent.run(id),
  markFailed: (id, error) => stmts.markFailed.run(error, id),
  resetContact: (id) => stmts.resetContact.run(id),
  deleteContact: (id) => stmts.deleteContact.run(id),
  deleteNotSent: () => stmts.deletePending.run(),
  log: (c, status, message, image, error) =>
    stmts.log.run(c.id, c.phone, status, message || null, image || null, error || null),
  history: (limit = 200) =>
    db.prepare('SELECT * FROM send_log ORDER BY id DESC LIMIT ?').all(limit),
  getSetting,
  setSetting,
};
