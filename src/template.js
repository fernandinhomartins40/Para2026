// Variáveis aceitas no texto (maiúsculas/minúsculas e espaços tanto faz):
// {nome} {{nome}} [nome]  ->  nome completo
// {primeiro_nome} {primeiro nome} {{primeiro_nome}} [primeiro nome]  ->  só o primeiro nome
const FIRST_RE = /\{\{?\s*primeiro[\s_-]*nome\s*\}?\}|\[\s*primeiro[\s_-]*nome\s*\]/gi;
const FULL_RE = /\{\{?\s*nome\s*\}?\}|\[\s*nome\s*\]/gi;

function hasNamePlaceholder(template) {
  const t = String(template || '');
  FIRST_RE.lastIndex = 0;
  FULL_RE.lastIndex = 0;
  return FIRST_RE.test(t) || FULL_RE.test(t);
}

function renderText(template, name) {
  const full = String(name || '').trim();
  const first = full.split(/\s+/)[0] || '';
  let text = String(template || '')
    .replace(FIRST_RE, first)
    .replace(FULL_RE, full);
  if (!full) {
    // Sem nome: evita "Olá , tudo bem?" e espaços duplos.
    text = text.replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }
  return text.trim();
}

module.exports = { hasNamePlaceholder, renderText };
