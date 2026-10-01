const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '55';

// Aceita "11 99999-9999", "+55 (11) 99999-9999", "5511999999999"...
// Números com 10 ou 11 dígitos (DDD + número) recebem o código do país padrão.
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10 || digits.length === 11) digits = DEFAULT_COUNTRY_CODE + digits;
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

// Trecho que parece telefone: opcional "+", dígitos com espaços, parênteses, pontos ou hífens.
const PHONE_RE = /\+?\(?\d[\d\s().-]{7,}\d/;

// Cada linha tem um número e, opcionalmente, um nome — em qualquer ordem e com qualquer separador:
// "11999998888", "Maria;11999998888", "11999998888, Maria", "Maria Silva 11 99999-8888",
// "Maria - (11) 99999-8888", "+55 21 98888-7777 João".
function parseLine(line) {
  const match = line.match(PHONE_RE);
  if (!match) return null;
  const phone = normalizePhone(match[0]);
  if (!phone) return null;
  const name = (line.slice(0, match.index) + ' ' + line.slice(match.index + match[0].length))
    .replace(/[;,\t|:]+/g, ' ')
    .replace(/(^|\s)[-–—]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { phone, name: name || null };
}

function parseList(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const item = parseLine(trimmed);
    if (!item) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(item.phone)) continue;
    seen.add(item.phone);
    valid.push(item);
  }
  return { valid, invalid };
}

module.exports = { normalizePhone, parseList };
