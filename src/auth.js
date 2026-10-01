const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

// Login principal: cadastro próprio com e-mail e senha (hash scrypt do Node, sem serviço externo).
// Login com Google é opcional: só aparece se GOOGLE_CLIENT_ID estiver definido.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// false = só quem já tem conta entra (novos cadastros bloqueados).
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';
const COOKIE = 'sid';
const MIN_PASSWORD = 6;

// ---- Senhas ----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// Hash fixo para comparar quando o e-mail não existe (tempo de resposta igual, não revela contas).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---- Limite de tentativas de login (memória): 10 erros por IP+e-mail a cada 15 min ----
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

function checkRate(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.count >= MAX_FAILS) {
    throw new Error('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  }
}
function registerFail(key) {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + WINDOW_MS });
  else a.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until < now) attempts.delete(k);
}, WINDOW_MS).unref();

const normEmail = (e) => String(e || '').trim().toLowerCase();

function register({ name, email, password }) {
  if (!ALLOW_REGISTRATION) throw new Error('Novos cadastros estão desativados.');
  email = normEmail(email);
  name = String(name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Informe um e-mail válido.');
  if (!name) throw new Error('Informe seu nome.');
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  return db.createLocalUser({ email, name, passwordHash: hashPassword(password) });
}

function login({ email, password }, ip) {
  email = normEmail(email);
  const key = `${ip}|${email}`;
  checkRate(key);
  const user = db.userByEmail(email);
  const ok = verifyPassword(String(password || ''), user && user.password_hash ? user.password_hash : DUMMY_HASH);
  if (!user || !user.password_hash || !ok) {
    registerFail(key);
    throw new Error('E-mail ou senha incorretos.');
  }
  attempts.delete(key);
  db.touchLogin(user.id);
  return user;
}

function changePassword(user, current, next) {
  const fresh = db.userByEmail(user.email);
  if (fresh.password_hash && !verifyPassword(String(current || ''), fresh.password_hash)) {
    throw new Error('Senha atual incorreta.');
  }
  if (String(next || '').length < MIN_PASSWORD) throw new Error(`A nova senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  db.setPassword(user.id, hashPassword(next));
}

// ---- Google (opcional) ----
const googleClient = new OAuth2Client();

async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) throw new Error('Login com Google não está habilitado.');
  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  } catch (err) {
    console.warn('Login Google recusado:', err.message);
    throw new Error('Não foi possível validar o login com Google. Tente novamente.');
  }
  const p = ticket.getPayload();
  if (!p || !p.email || !p.email_verified) throw new Error('Conta Google sem e-mail verificado');
  return { sub: p.sub, email: normEmail(p.email), name: p.name, picture: p.picture };
}

// ---- Sessão por cookie ----
function setSessionCookie(req, res, userId) {
  const { token, maxAge } = db.createSession(userId);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
}

function loadUser(req, res, next) {
  req.user = db.userBySession(req.cookies[COOKIE]);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar' });
  next();
}

function logout(req, res) {
  const token = req.cookies[COOKIE];
  if (token) db.deleteSession(token);
  res.clearCookie(COOKIE, { path: '/' });
}

module.exports = {
  GOOGLE_CLIENT_ID, ALLOW_REGISTRATION, MIN_PASSWORD,
  register, login, changePassword, verifyGoogleCredential,
  setSessionCookie, loadUser, requireUser, logout,
};
