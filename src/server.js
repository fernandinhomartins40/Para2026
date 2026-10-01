const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const db = require('./db');
const wa = require('./whatsapp');
const auth = require('./auth');
const { parseList } = require('./phone');

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const userUploadDir = (userId) => path.join(UPLOAD_DIR, String(userId));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = userUploadDir(req.user.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `imagem-${Date.now()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});

const app = express();
// Atrás do proxy HTTPS da VPS: req.secure passa a refletir o X-Forwarded-Proto.
app.set('trust proxy', 1);

app.get('/health', (req, res) => res.json({ ok: true, browsers: wa.stats() }));

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.loadUser);
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

// ---- Login ----
app.get('/api/config', (req, res) => res.json({ googleClientId: auth.GOOGLE_CLIENT_ID, allowRegistration: auth.ALLOW_REGISTRATION }));

// Arquivos da versão de usuário único (antes do login) vão para o primeiro usuário.
function claimLegacyFiles(userId) {
  const oldSession = path.join(db.DATA_DIR, 'wa-session');
  const newSession = path.join(db.DATA_DIR, 'wa-sessions', String(userId));
  if (fs.existsSync(oldSession) && !fs.existsSync(newSession)) {
    fs.mkdirSync(path.dirname(newSession), { recursive: true });
    fs.renameSync(oldSession, newSession);
  }
  const image = db.getSetting(userId, 'image');
  const oldImage = image && path.join(UPLOAD_DIR, image);
  if (oldImage && fs.existsSync(oldImage)) {
    fs.mkdirSync(userUploadDir(userId), { recursive: true });
    fs.renameSync(oldImage, path.join(userUploadDir(userId), image));
  }
}

function startSession(req, res, { user, isFirst }) {
  if (isFirst && db.claimLegacy(user.id)) claimLegacyFiles(user.id);
  auth.setSessionCookie(req, res, user.id);
  res.json({ ok: true });
}

app.post('/auth/register', (req, res) => {
  try {
    startSession(req, res, auth.register(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/auth/login', (req, res) => {
  try {
    const user = auth.login(req.body, req.ip);
    startSession(req, res, { user, isFirst: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login com Google: opcional, só funciona com GOOGLE_CLIENT_ID definido.
app.post('/auth/google', wrap(async (req, res) => {
  const profile = await auth.verifyGoogleCredential(req.body.credential);
  startSession(req, res, db.upsertUser(profile));
}));

app.post('/auth/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

// ---- Daqui para baixo tudo exige login e é isolado por usuário ----
app.use('/api', auth.requireUser);

app.get('/api/me', (req, res) => {
  const { id, email, name, picture, password_hash } = req.user;
  res.json({ id, email, name, picture, hasPassword: !!password_hash });
});

app.post('/api/password', (req, res) => {
  try {
    auth.changePassword(req.user, req.body.current, req.body.password);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function currentImagePath(userId) {
  const file = db.getSetting(userId, 'image');
  if (!file) return null;
  const full = path.join(userUploadDir(userId), path.basename(file));
  return fs.existsSync(full) ? full : null;
}

function renderText(template, contact) {
  const name = (contact.name || '').trim();
  const first = name.split(/\s+/)[0] || '';
  return String(template || '')
    .replace(/\{nome\}/gi, name)
    .replace(/\{primeiro_nome\}/gi, first)
    .trim();
}

// ---- WhatsApp (um por usuário) ----
// Abrir a página já liga o WhatsApp do usuário; ele é fechado sozinho após um tempo sem uso.
app.get('/api/status', wrap(async (req, res) => {
  const c = await wa.ensureStarted(req.user.id);
  res.json({ ...c.getStatus(), counts: db.counts(req.user.id) });
}));

app.post('/api/whatsapp/restart', wrap(async (req, res) => {
  const c = wa.get(req.user.id);
  await c.stop();
  c.state = 'stopped';
  await wa.ensureStarted(req.user.id, { force: true });
  res.json(c.getStatus());
}));

app.post('/api/whatsapp/logout', wrap(async (req, res) => {
  const c = wa.get(req.user.id);
  await c.logout();
  res.json(c.getStatus());
}));

// ---- Mensagem ----
app.get('/api/message', (req, res) => {
  const uid = req.user.id;
  res.json({
    text: db.getSetting(uid, 'text', ''),
    image: currentImagePath(uid) ? '/api/message/image' : null,
    order: db.getSetting(uid, 'order', 'text_first'),
  });
});

app.put('/api/message', (req, res) => {
  db.setSetting(req.user.id, 'text', String(req.body.text || ''));
  if (req.body.order) db.setSetting(req.user.id, 'order', req.body.order === 'image_first' ? 'image_first' : 'text_first');
  res.json({ ok: true });
});

app.get('/api/message/image', (req, res) => {
  const file = currentImagePath(req.user.id);
  if (!file) return res.status(404).end();
  res.sendFile(file);
});

app.post('/api/message/image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie uma imagem PNG, JPG, WEBP ou GIF (até 16MB)' });
  const old = currentImagePath(req.user.id);
  if (old) fs.rmSync(old, { force: true });
  db.setSetting(req.user.id, 'image', req.file.filename);
  res.json({ image: '/api/message/image' });
});

app.delete('/api/message/image', (req, res) => {
  const old = currentImagePath(req.user.id);
  if (old) fs.rmSync(old, { force: true });
  db.setSetting(req.user.id, 'image', '');
  res.json({ ok: true });
});

// ---- Contatos ----
app.get('/api/contacts', (req, res) =>
  res.json({ contacts: db.listContacts(req.user.id, req.query.status), counts: db.counts(req.user.id) }));

app.post('/api/contacts', (req, res) => {
  const { valid, invalid } = parseList(req.body.text);
  const { added, existing } = db.addContacts(req.user.id, valid);
  res.json({ added, existing, invalid });
});

app.post('/api/contacts/:id/reset', (req, res) => { db.resetContact(req.user.id, req.params.id); res.json({ ok: true }); });
app.delete('/api/contacts/:id', (req, res) => { db.deleteContact(req.user.id, req.params.id); res.json({ ok: true }); });
app.delete('/api/contacts', (req, res) => { const r = db.deleteNotSent(req.user.id); res.json({ removed: r.changes }); });

async function sendTo(userId, contact) {
  if (!contact) throw new Error('Contato não encontrado');
  const client = wa.get(userId);
  const imagePath = currentImagePath(userId);
  const text = renderText(db.getSetting(userId, 'text', ''), contact);
  try {
    const imageFirst = db.getSetting(userId, 'order', 'text_first') === 'image_first';
    await client.sendMessage({ phone: contact.phone, text, imagePath, imageFirst });
    db.markSent(userId, contact.id);
    db.log(userId, contact, 'sent', text, imagePath && path.basename(imagePath));
    return { ok: true, contact: db.getContact(userId, contact.id) };
  } catch (err) {
    // Erros de conexão/concorrência não marcam o contato como falho.
    if (client.state === 'ready' && !/em andamento|não está conectado|Configure a mensagem/.test(err.message)) {
      db.markFailed(userId, contact.id, err.message);
      db.log(userId, contact, 'failed', text, imagePath && path.basename(imagePath), err.message);
    }
    throw err;
  }
}

app.post('/api/contacts/:id/send', wrap(async (req, res) => {
  const contact = db.getContact(req.user.id, req.params.id);
  if (contact && contact.status === 'sent' && !req.body.force) {
    throw new Error('Esse número já recebeu a mensagem. Use "Reenviar" se quiser mandar de novo.');
  }
  res.json(await sendTo(req.user.id, contact));
}));

app.post('/api/send-next', wrap(async (req, res) => {
  const contact = db.nextPending(req.user.id);
  if (!contact) throw new Error('Não há números pendentes');
  res.json(await sendTo(req.user.id, contact));
}));

app.get('/api/history', (req, res) => res.json({ history: db.history(req.user.id) }));

app.listen(PORT, () => {
  console.log(`Aplicação rodando em http://localhost:${PORT}`);
});

process.on('SIGTERM', async () => { await wa.stopAll(); process.exit(0); });
process.on('SIGINT', async () => { await wa.stopAll(); process.exit(0); });
