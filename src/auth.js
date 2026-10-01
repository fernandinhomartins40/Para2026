const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

// Login com "Sign in with Google" (Google Identity Services): o navegador recebe um ID token
// assinado pelo Google e o servidor só valida a assinatura e o audience. Precisa apenas do
// Client ID (público) — não há client secret.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Só para desenvolvimento local: permite entrar informando um e-mail, sem Google. Nunca ative em produção.
const DEV_LOGIN = process.env.DEV_LOGIN === 'true';
const COOKIE = 'sid';

const client = new OAuth2Client();

async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) throw new Error('Login com Google não configurado (GOOGLE_CLIENT_ID vazio)');
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  } catch (err) {
    console.warn('Login Google recusado:', err.message);
    throw new Error('Não foi possível validar o login com Google. Tente novamente.');
  }
  const p = ticket.getPayload();
  if (!p || !p.email || !p.email_verified) throw new Error('Conta Google sem e-mail verificado');
  return { sub: p.sub, email: p.email, name: p.name, picture: p.picture };
}

function setSessionCookie(req, res, userId) {
  const { token, maxAge } = db.createSession(userId);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
}

// Coloca req.user quando há sessão válida.
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

module.exports = { GOOGLE_CLIENT_ID, DEV_LOGIN, verifyGoogleCredential, setSessionCookie, loadUser, requireUser, logout };
