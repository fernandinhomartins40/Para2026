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

// Cada linha: "numero" ou "numero;nome" / "numero,nome" / "nome;numero"
function parseList(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[;,\t]/).map((p) => p.trim()).filter(Boolean);
    let phonePart = parts.find((p) => /\d{8,}/.test(p.replace(/\D/g, ''))) || parts[0];
    const name = parts.filter((p) => p !== phonePart).join(' ') || null;
    const phone = normalizePhone(phonePart);
    if (!phone) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(phone)) continue;
    seen.add(phone);
    valid.push({ phone, name });
  }
  return { valid, invalid };
}

module.exports = { normalizePhone, parseList };
