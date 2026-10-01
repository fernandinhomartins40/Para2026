// Variáveis aceitas no texto (maiúsculas/minúsculas e espaços tanto faz):
// {nome} {primeiro_nome} {primeiro nome} {{nome}} [nome]  ->  primeiro nome da lista ("Maria")
// {nome_completo} {nome completo}                          ->  nome completo da lista ("Maria Silva")
// {periodo} {período} {saudacao}                           ->  "Bom dia" / "Boa tarde" / "Boa noite" (horário de Brasília)
const FULL_RE = /\{\{?\s*nome[\s_-]*completo\s*\}?\}|\[\s*nome[\s_-]*completo\s*\]/gi;
const FIRST_RE = /\{\{?\s*(?:primeiro[\s_-]*)?nome\s*\}?\}|\[\s*(?:primeiro[\s_-]*)?nome\s*\]/gi;

const PERIOD_RE = /\{\{?\s*(?:per[ií]odo|sauda[cç][aã]o)\s*\}?\}|\[\s*(?:per[ií]odo|sauda[cç][aã]o)\s*\]/gi;
const TZ = process.env.TZ || 'America/Sao_Paulo';

// 5h–11h59 Bom dia · 12h–17h59 Boa tarde · 18h–4h59 Boa noite
function greeting(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(date));
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

// "MARIA" / "maria" -> "Maria"; mantém nomes já escritos com maiúsculas e minúsculas.
function tidy(word) {
  if (!word) return '';
  if (word === word.toUpperCase() || word === word.toLowerCase()) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return word;
}

function renderText(template, name, date = new Date()) {
  const full = String(name || '').trim().replace(/\s+/g, ' ');
  const first = tidy(full.split(' ')[0] || '');
  const fullTidy = full.split(' ').map((w) => (w.length > 2 ? tidy(w) : w.toLowerCase())).join(' ');
  let text = String(template || '')
    .replace(PERIOD_RE, greeting(date))
    .replace(FULL_RE, fullTidy ? first && fullTidy.replace(/^\S+/, first) : '')
    .replace(FIRST_RE, first);
  if (!full) {
    // Sem nome: evita "Olá , tudo bem?" e espaços duplos.
    text = text.replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }
  return text.trim();
}

module.exports = { renderText, greeting };
