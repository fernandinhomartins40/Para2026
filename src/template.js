// Variáveis aceitas no texto (maiúsculas/minúsculas e espaços tanto faz):
// {nome} {primeiro_nome} {primeiro nome} {{nome}} [nome]  ->  primeiro nome da lista ("Maria")
// {nome_completo} {nome completo}                          ->  nome completo da lista ("Maria Silva")
const FULL_RE = /\{\{?\s*nome[\s_-]*completo\s*\}?\}|\[\s*nome[\s_-]*completo\s*\]/gi;
const FIRST_RE = /\{\{?\s*(?:primeiro[\s_-]*)?nome\s*\}?\}|\[\s*(?:primeiro[\s_-]*)?nome\s*\]/gi;

// "MARIA" / "maria" -> "Maria"; mantém nomes já escritos com maiúsculas e minúsculas.
function tidy(word) {
  if (!word) return '';
  if (word === word.toUpperCase() || word === word.toLowerCase()) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return word;
}

function renderText(template, name) {
  const full = String(name || '').trim().replace(/\s+/g, ' ');
  const first = tidy(full.split(' ')[0] || '');
  const fullTidy = full.split(' ').map((w) => (w.length > 2 ? tidy(w) : w.toLowerCase())).join(' ');
  let text = String(template || '')
    .replace(FULL_RE, fullTidy ? first && fullTidy.replace(/^\S+/, first) : '')
    .replace(FIRST_RE, first);
  if (!full) {
    // Sem nome: evita "Olá , tudo bem?" e espaços duplos.
    text = text.replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }
  return text.trim();
}

module.exports = { renderText };
