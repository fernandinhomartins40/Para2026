const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const wa = require('./whatsapp');
const { parseList } = require('./phone');

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `imagem-${Date.now()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});

const app = express();

app.get('/health', (req, res) => res.json({ ok: true, whatsapp: wa.getStatus().state }));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

function currentImagePath() {
  const file = db.getSetting('image');
  if (!file) return null;
  const full = path.join(UPLOAD_DIR, file);
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

// ---- WhatsApp ----
app.get('/api/status', (req, res) => res.json({ ...wa.getStatus(), counts: db.counts() }));
app.post('/api/whatsapp/restart', wrap(async (req, res) => { await wa.restart(); res.json(wa.getStatus()); }));
app.post('/api/whatsapp/logout', wrap(async (req, res) => { await wa.logout(); res.json(wa.getStatus()); }));

// ---- Mensagem ----
app.get('/api/message', (req, res) => {
  const image = currentImagePath() ? db.getSetting('image') : null;
  res.json({ text: db.getSetting('text', ''), image: image ? `/uploads/${image}` : null });
});

app.put('/api/message', (req, res) => {
  db.setSetting('text', String(req.body.text || ''));
  res.json({ ok: true });
});

app.post('/api/message/image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie uma imagem PNG, JPG, WEBP ou GIF (até 16MB)' });
  const old = currentImagePath();
  if (old) fs.rmSync(old, { force: true });
  db.setSetting('image', req.file.filename);
  res.json({ image: `/uploads/${req.file.filename}` });
});

app.delete('/api/message/image', (req, res) => {
  const old = currentImagePath();
  if (old) fs.rmSync(old, { force: true });
  db.setSetting('image', '');
  res.json({ ok: true });
});

// ---- Contatos ----
app.get('/api/contacts', (req, res) => res.json({ contacts: db.listContacts(req.query.status), counts: db.counts() }));

app.post('/api/contacts', (req, res) => {
  const { valid, invalid } = parseList(req.body.text);
  const { added, existing } = db.addContacts(valid);
  res.json({ added, existing, invalid });
});

app.post('/api/contacts/:id/reset', (req, res) => { db.resetContact(req.params.id); res.json({ ok: true }); });
app.delete('/api/contacts/:id', (req, res) => { db.deleteContact(req.params.id); res.json({ ok: true }); });
app.delete('/api/contacts', (req, res) => { const r = db.deleteNotSent(); res.json({ removed: r.changes }); });

async function sendTo(contact) {
  if (!contact) throw new Error('Contato não encontrado');
  const template = db.getSetting('text', '');
  const imagePath = currentImagePath();
  const text = renderText(template, contact);
  try {
    await wa.sendMessage({ phone: contact.phone, text, imagePath });
    db.markSent(contact.id);
    db.log(contact, 'sent', text, imagePath && path.basename(imagePath));
    return { ok: true, contact: db.getContact(contact.id) };
  } catch (err) {
    const status = wa.getStatus();
    // Erros de conexão/concorrência não marcam o contato como falho.
    if (status.state === 'ready' && !/em andamento|não está conectado|Configure a mensagem/.test(err.message)) {
      db.markFailed(contact.id, err.message);
      db.log(contact, 'failed', text, imagePath && path.basename(imagePath), err.message);
    }
    throw err;
  }
}

app.post('/api/contacts/:id/send', wrap(async (req, res) => {
  const contact = db.getContact(req.params.id);
  if (contact && contact.status === 'sent' && !req.body.force) {
    throw new Error('Esse número já recebeu a mensagem. Use "Reenviar" se quiser mandar de novo.');
  }
  res.json(await sendTo(contact));
}));

app.post('/api/send-next', wrap(async (req, res) => {
  const contact = db.nextPending();
  if (!contact) throw new Error('Não há números pendentes');
  res.json(await sendTo(contact));
}));

app.get('/api/history', (req, res) => res.json({ history: db.history() }));

app.listen(PORT, () => {
  console.log(`Aplicação rodando em http://localhost:${PORT}`);
  wa.start();
});

process.on('SIGINT', async () => { await wa.stop(); process.exit(0); });
