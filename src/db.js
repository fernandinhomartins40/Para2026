const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'envios.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

// Versão anterior (um único usuário): guarda as tabelas antigas como *_legacy.
// Elas são transferidas para o primeiro usuário que fizer login (claimLegacy).
if (hasTable('contacts') && !hasColumn('contacts', 'user_id')) {
  db.exec(`
    ALTER TABLE contacts RENAME TO contacts_legacy;
    ALTER TABLE send_log RENAME TO send_log_legacy;
    ALTER TABLE settings RENAME TO settings_legacy;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT NOT NULL UNIQUE,
    email      TEXT NOT NULL,
    name       TEXT,
    picture    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone      TEXT NOT NULL,
    name       TEXT,
    status     TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
    error      TEXT,
    sent_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (user_id, phone)
  );

  CREATE TABLE IF NOT EXISTS send_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    phone      TEXT NOT NULL,
    status     TEXT NOT NULL, -- sent | failed
    message    TEXT,
    image      TEXT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT,
    PRIMARY KEY (user_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_user_status ON contacts(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

const SESSION_DAYS = 30;

const stmts = {
  // usuários e sessões
  userBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (google_sub, email, name, picture, last_login) VALUES (?, ?, ?, ?, datetime(\'now\', \'localtime\'))'),
  updateUser: db.prepare('UPDATE users SET email = ?, name = ?, picture = ?, last_login = datetime(\'now\', \'localtime\') WHERE id = ?'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  // contatos (sempre filtrados por user_id)
  insertContact: db.prepare('INSERT OR IGNORE INTO contacts (user_id, phone, name) VALUES (?, ?, ?)'),
  updateName: db.prepare("UPDATE contacts SET name = ? WHERE user_id = ? AND phone = ? AND (name IS NULL OR name = '')"),
  getContact: db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?'),
  nextPending: db.prepare("SELECT * FROM contacts WHERE user_id = ? AND status = 'pending' ORDER BY id LIMIT 1"),
  markSent: db.prepare("UPDATE contacts SET status = 'sent', error = NULL, sent_at = datetime('now', 'localtime') WHERE id = ? AND user_id = ?"),
  markFailed: db.prepare("UPDATE contacts SET status = 'failed', error = ? WHERE id = ? AND user_id = ?"),
  resetContact: db.prepare("UPDATE contacts SET status = 'pending', error = NULL, sent_at = NULL WHERE id = ? AND user_id = ?"),
  deleteContact: db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?'),
  deleteNotSent: db.prepare("DELETE FROM contacts WHERE user_id = ? AND status != 'sent'"),
  counts: db.prepare('SELECT status, COUNT(*) AS n FROM contacts WHERE user_id = ? GROUP BY status'),
  listAll: db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY id'),
  listByStatus: db.prepare('SELECT * FROM contacts WHERE user_id = ? AND status = ? ORDER BY id'),
  log: db.prepare('INSERT INTO send_log (user_id, contact_id, phone, status, message, image, error) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  history: db.prepare('SELECT * FROM send_log WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?'),
  setSetting: db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'),
};

// Cria ou atualiza o usuário a partir do perfil do Google. Retorna { user, isFirst }.
const upsertUser = db.transaction(({ sub, email, name, picture }) => {
  const existing = stmts.userBySub.get(sub);
  if (existing) {
    stmts.updateUser.run(email, name || null, picture || null, existing.id);
    return { user: stmts.userById.get(existing.id), isFirst: false };
  }
  const isFirst = stmts.countUsers.get().n === 0;
  const r = stmts.insertUser.run(sub, email, name || null, picture || null);
  return { user: stmts.userById.get(r.lastInsertRowid), isFirst };
});

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  stmts.insertSession.run(token, userId, Date.now() + SESSION_DAYS * 86400000);
  return { token, maxAge: SESSION_DAYS * 86400000 };
}

function userBySession(token) {
  if (!token) return null;
  return stmts.sessionUser.get(token, Date.now()) || null;
}

setInterval(() => stmts.purgeSessions.run(Date.now()), 3600 * 1000).unref();

// Transfere os dados da versão de usuário único para o primeiro usuário que entrar.
const claimLegacy = db.transaction((userId) => {
  if (!hasTable('contacts_legacy')) return false;
  db.prepare(`INSERT OR IGNORE INTO contacts (user_id, phone, name, status, error, sent_at, created_at)
              SELECT ?, phone, name, status, error, sent_at, created_at FROM contacts_legacy`).run(userId);
  db.prepare(`INSERT INTO send_log (user_id, contact_id, phone, status, message, image, error, created_at)
              SELECT ?, (SELECT c.id FROM contacts c WHERE c.user_id = ? AND c.phone = l.phone), l.phone, l.status, l.message, l.image, l.error, l.created_at
              FROM send_log_legacy l`).run(userId, userId);
  db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) SELECT ?, key, value FROM settings_legacy').run(userId);
  db.exec('DROP TABLE send_log_legacy; DROP TABLE contacts_legacy; DROP TABLE settings_legacy;');
  return true;
});

const addContacts = db.transaction((userId, items) => {
  let added = 0;
  let existing = 0;
  for (const { phone, name } of items) {
    const r = stmts.insertContact.run(userId, phone, name || null);
    if (r.changes) added++;
    else {
      existing++;
      if (name) stmts.updateName.run(name, userId, phone);
    }
  }
  return { added, existing };
});

function listContacts(userId, status) {
  if (status && status !== 'all') return stmts.listByStatus.all(userId, status);
  return stmts.listAll.all(userId);
}

function counts(userId) {
  const out = { pending: 0, sent: 0, failed: 0, total: 0 };
  for (const row of stmts.counts.all(userId)) {
    out[row.status] = row.n;
    out.total += row.n;
  }
  return out;
}

function getSetting(userId, key, fallback = null) {
  const row = stmts.getSetting.get(userId, key);
  return row ? row.value : fallback;
}

module.exports = {
  DATA_DIR,
  upsertUser,
  createSession,
  userBySession,
  deleteSession: (token) => stmts.deleteSession.run(token),
  claimLegacy,
  addContacts,
  listContacts,
  counts,
  getContact: (userId, id) => stmts.getContact.get(id, userId),
  nextPending: (userId) => stmts.nextPending.get(userId),
  markSent: (userId, id) => stmts.markSent.run(id, userId),
  markFailed: (userId, id, error) => stmts.markFailed.run(error, id, userId),
  resetContact: (userId, id) => stmts.resetContact.run(id, userId),
  deleteContact: (userId, id) => stmts.deleteContact.run(id, userId),
  deleteNotSent: (userId) => stmts.deleteNotSent.run(userId),
  log: (userId, c, status, message, image, error) =>
    stmts.log.run(userId, c.id, c.phone, status, message || null, image || null, error || null),
  history: (userId, limit = 200) => stmts.history.all(userId, limit),
  getSetting,
  setSetting: (userId, key, value) => stmts.setSetting.run(userId, key, value),
};
