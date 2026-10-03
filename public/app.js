const $ = (id) => document.getElementById(id);
let filter = 'pending';
let sending = false;
let waState = 'loading';

const STATE_LABEL = {
  ready: 'Conectado',
  qr: 'Aguardando leitura do QR Code',
  loading: 'Carregando WhatsApp...',
  starting: 'Abrindo navegador...',
  stopped: 'Desconectado',
  waiting: 'Na fila',
  error: 'Erro',
};
const STATUS_LABEL = { pending: 'Pendente', sent: 'Enviado', failed: 'Falhou' };

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatPhone(p) {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : '+' + p;
}

// ---- Status / QR ----
async function refreshStatus() {
  try {
    const s = await api('/api/status');
    waState = s.state;
    const badge = $('badge');
    badge.textContent = STATE_LABEL[s.state] || s.state;
    badge.className = 'badge ' + s.state;

    const qr = $('qr');
    const msg = $('conn-msg');
    if (s.state === 'qr' && s.qr) {
      qr.src = s.qr;
      qr.hidden = false;
      msg.textContent = 'Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho, e leia o QR Code:';
    } else {
      qr.hidden = true;
      msg.textContent =
        s.state === 'ready' ? '✅ WhatsApp conectado. Pode enviar.' :
        s.state === 'error' ? '❌ ' + (s.error || 'Erro ao iniciar') + ' — clique em Reconectar.' :
        s.state === 'waiting' ? '⏳ ' + s.error :
        STATE_LABEL[s.state] || s.state;
    }
    $('card-conn').dataset.state = s.state;
    renderCounts(s.counts);
    updateNextButton();
  } catch {
    $('badge').textContent = 'Servidor offline';
    $('badge').className = 'badge error';
  }
}

function renderCounts(c) {
  $('c-pending').textContent = c.pending;
  $('c-sent').textContent = c.sent;
  $('c-failed').textContent = c.failed;
  $('next-info').textContent = c.pending
    ? `${c.pending} número(s) aguardando. Clique uma vez para cada envio.`
    : 'Nenhum número pendente.';
}

function updateNextButton() {
  const btn = $('btn-next');
  btn.disabled = sending || waState !== 'ready';
  btn.textContent = sending ? 'Enviando...' : waState === 'ready' ? 'Enviar para o próximo pendente' : 'Conecte o WhatsApp para enviar';
  document.querySelectorAll('.btn-send').forEach((b) => (b.disabled = sending || waState !== 'ready'));
}

// ---- Mensagem ----
async function loadMessage() {
  const m = await api('/api/message');
  $('text').value = m.text || '';
  $('order').value = m.order || 'text_first';
  showImage(m.image);
}

function showImage(url) {
  $('image-preview').hidden = !url;
  $('no-image').hidden = !!url;
  $('btn-remove-image').hidden = !url;
  if (url) $('image-preview').src = url + '?t=' + Date.now();
}

$('order').onchange = async () => {
  await api('/api/message', { method: 'PUT', body: JSON.stringify({ text: $('text').value, order: $('order').value }) });
  toast('Ordem de envio salva');
};

$('btn-save-text').onclick = async () => {
  await api('/api/message', { method: 'PUT', body: JSON.stringify({ text: $('text').value }) });
  $('text-saved').textContent = 'Salvo ✓';
  loadPreview();
  setTimeout(() => ($('text-saved').textContent = ''), 2000);
};

$('btn-pick-image').onclick = () => $('image-input').click();
$('image-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  try {
    const r = await api('/api/message/image', { method: 'POST', body: fd });
    showImage(r.image);
    toast('Imagem salva');
  } catch (err) {
    toast(err.message, true);
  }
  e.target.value = '';
};
$('btn-remove-image').onclick = async () => {
  await api('/api/message/image', { method: 'DELETE' });
  showImage(null);
};

// ---- Contatos ----
$('btn-add').onclick = async () => {
  const text = $('numbers').value;
  if (!text.trim()) return;
  const r = await api('/api/contacts', { method: 'POST', body: JSON.stringify({ text }) });
  let msg = `${r.added} adicionado(s)`;
  if (r.existing) msg += `, ${r.existing} já estava(m) na lista (não duplicados)`;
  if (r.invalid.length) msg += `, ${r.invalid.length} inválido(s): ${r.invalid.join(' | ')}`;
  $('add-result').textContent = msg;
  $('numbers').value = r.invalid.join('\n');
  loadContacts();
};

async function extractContacts(source, groupIds = []) {
  const buttons = [$('btn-extract-chats'), $('btn-extract-contacts'), $('btn-load-groups'), $('btn-extract-groups')];
  buttons.forEach((button) => (button.disabled = true));
  showExtractFeedback('busy', '⏳ Extraindo nomes e números do WhatsApp... Isso pode levar alguns instantes.');
  try {
    const r = await api('/api/contacts/extract', {
      method: 'POST',
      body: JSON.stringify({ source, groupIds }),
    });
    $('numbers').value = r.text;
    if (r.added) {
      filter = 'pending';
      document.querySelectorAll('#tabs button[data-status]').forEach((button) =>
        button.classList.toggle('active', button.dataset.status === 'pending'));
    }
    await loadContacts();
    const detail = r.existing ? ` ${r.existing} já estava(m) na lista e não foi(ram) duplicado(s).` : '';
    const unresolved = r.unresolved ? ` ${r.unresolved} contato(s) usa(m) identificador privado e não expõe(m) o telefone.` : '';
    if (r.total) {
      showExtractFeedback('success', `✅ Extração concluída: ${r.examined} analisado(s), ${r.total} com número, ${r.added} adicionado(s) como pendente(s).${detail}${unresolved}`);
      toast(`${r.added} novo(s) contato(s) adicionado(s) como pendente(s)`);
    } else {
      showExtractFeedback('warning', `⚠️ A extração analisou ${r.examined || 0} contato(s), mas nenhum telefone pôde ser recuperado.${unresolved}`);
      toast('Nenhum número foi encontrado', true);
    }
  } catch (err) {
    showExtractFeedback('error', `❌ Não foi possível concluir a extração: ${err.message}`);
    toast(err.message, true);
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}

function showExtractFeedback(type, message) {
  const result = $('extract-result');
  result.hidden = false;
  result.className = `extract-feedback ${type}`;
  result.textContent = message;
}

$('btn-extract-chats').onclick = () => extractContacts('chats');
$('btn-extract-contacts').onclick = () => extractContacts('contacts');
$('btn-load-groups').onclick = async () => {
  $('btn-load-groups').disabled = true;
  showExtractFeedback('busy', '⏳ Procurando grupos no WhatsApp...');
  try {
    const { groups } = await api('/api/whatsapp/groups');
    $('group-options').innerHTML = groups.map((group) => `
      <label><input type="checkbox" value="${esc(group.id)}"> <span>${esc(group.name)}</span></label>
    `).join('');
    $('group-picker').hidden = false;
    showExtractFeedback(groups.length ? 'success' : 'warning', groups.length
      ? `✅ ${groups.length} grupo(s) encontrado(s). Marque os desejados abaixo.`
      : '⚠️ Nenhum grupo foi encontrado nas conversas carregadas.');
    $('groups-all').checked = false;
  } catch (err) {
    showExtractFeedback('error', `❌ Não foi possível carregar os grupos: ${err.message}`);
    toast(err.message, true);
  } finally {
    $('btn-load-groups').disabled = false;
  }
};
$('groups-all').onchange = (e) => {
  document.querySelectorAll('#group-options input').forEach((input) => (input.checked = e.target.checked));
};
$('btn-extract-groups').onclick = () => {
  const ids = [...document.querySelectorAll('#group-options input:checked')].map((input) => input.value);
  if (!ids.length) return toast('Selecione pelo menos um grupo', true);
  extractContacts('groups', ids);
};

async function loadPreview() {
  try {
    const p = await api('/api/preview');
    $('preview').hidden = !p.contact;
    if (!p.contact) return;
    $('preview-to').textContent = (p.contact.name ? p.contact.name + ' · ' : '') + formatPhone(p.contact.phone);
    $('preview-text').textContent = p.text || '(sem texto — só a imagem)';
    $('preview-warn').hidden = !!p.contact.name || !/[{\[]\s*(primeiro|nome)/i.test($('text').value);
  } catch {}
}

async function loadContacts() {
  const { contacts, counts } = await api('/api/contacts?status=' + filter);
  renderCounts(counts);
  $('empty').hidden = contacts.length > 0;
  $('rows').innerHTML = contacts
    .map((c) => {
      const actions = [];
      if (c.status === 'pending') actions.push(`<button class="small btn-send" data-send="${c.id}">Enviar</button>`);
      if (c.status === 'pending') actions.push(`<button class="small secondary" data-fail="${c.id}" title="Tirar da fila de pendentes">Marcar falha</button>`);
      if (c.status !== 'pending') actions.push(`<button class="small secondary" data-reset="${c.id}">Voltar p/ pendente</button>`);
      actions.push(`<button class="small danger" data-del="${c.id}" title="Remover">✕</button>`);
      return `<tr id="row-${c.id}">
        <td class="select-col">${c.status === 'sent' ? `<input type="checkbox" class="sent-select" value="${c.id}" aria-label="Selecionar ${esc(c.name || formatPhone(c.phone))}">` : ''}</td>
        <td>${esc(formatPhone(c.phone))}</td>
        <td>${esc(c.name || '')}</td>
        <td><span class="st ${c.status}">${STATUS_LABEL[c.status]}</span>${c.error ? `<span class="err">${esc(c.error)}</span>` : ''}</td>
        <td>${esc(c.sent_at || '')}</td>
        <td class="actions">${actions.join('')}</td>
      </tr>`;
    })
    .join('');
  $('sent-batch').hidden = counts.sent === 0 || !['sent', 'all'].includes(filter);
  $('sent-select-all').checked = false;
  $('sent-select-all').indeterminate = false;
  updateSentSelection();
  updateNextButton();
  loadPreview();
}

function updateSentSelection() {
  const boxes = [...document.querySelectorAll('.sent-select')];
  const selected = boxes.filter((box) => box.checked);
  $('sent-selected-count').textContent = selected.length;
  $('btn-reset-selected').disabled = selected.length === 0;
  $('sent-select-all').disabled = boxes.length === 0;
  $('sent-select-all').checked = boxes.length > 0 && selected.length === boxes.length;
  $('sent-select-all').indeterminate = selected.length > 0 && selected.length < boxes.length;
}

$('sent-select-all').onchange = (e) => {
  document.querySelectorAll('.sent-select').forEach((box) => (box.checked = e.target.checked));
  updateSentSelection();
};

$('rows').onchange = (e) => {
  if (e.target.matches('.sent-select')) updateSentSelection();
};

async function resetSent(ids, all = false) {
  const amount = all ? 'todos os contatos enviados' : `${ids.length} contato(s) selecionado(s)`;
  if (!confirm(`Colocar ${amount} novamente como pendente(s) para reenvio?`)) return;
  try {
    const r = await api('/api/contacts/reset-sent', {
      method: 'POST',
      body: JSON.stringify({ ids, all }),
    });
    toast(`${r.changed} contato(s) movido(s) para pendentes`);
    filter = 'pending';
    document.querySelectorAll('#tabs button[data-status]').forEach((button) =>
      button.classList.toggle('active', button.dataset.status === 'pending'));
    await loadContacts();
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-reset-selected').onclick = () => {
  const ids = [...document.querySelectorAll('.sent-select:checked')].map((box) => Number(box.value));
  resetSent(ids);
};
$('btn-reset-all-sent').onclick = () => resetSent([], true);

async function doSend(url, rowId) {
  if (sending) return;
  sending = true;
  updateNextButton();
  if (rowId) $('row-' + rowId)?.classList.add('sending');
  try {
    const r = await api(url, { method: 'POST', body: JSON.stringify({}) });
    toast(`✅ Enviado para ${formatPhone(r.contact.phone)}${r.contact.name ? ' (' + r.contact.name + ')' : ''}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    sending = false;
    await loadContacts();
    refreshStatus();
  }
}

$('btn-next').onclick = () => doSend('/api/send-next');

$('rows').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.send) return doSend(`/api/contacts/${b.dataset.send}/send`, b.dataset.send);
  if (b.dataset.fail) {
    await api(`/api/contacts/${b.dataset.fail}/fail`, { method: 'POST' });
    toast('Marcado como falha');
    return loadContacts();
  }
  if (b.dataset.reset) {
    await api(`/api/contacts/${b.dataset.reset}/reset`, { method: 'POST' });
    return loadContacts();
  }
  if (b.dataset.del && confirm('Remover este número da lista?')) {
    await api(`/api/contacts/${b.dataset.del}`, { method: 'DELETE' });
    loadContacts();
  }
};

$('tabs').onclick = (e) => {
  const b = e.target.closest('button[data-status]');
  if (!b) return;
  filter = b.dataset.status;
  document.querySelectorAll('#tabs button[data-status]').forEach((x) => x.classList.toggle('active', x === b));
  loadContacts();
};

$('btn-clear').onclick = async () => {
  if (!confirm('Remover todos os números pendentes e com falha? (Os já enviados continuam no histórico)')) return;
  const r = await api('/api/contacts', { method: 'DELETE' });
  toast(`${r.removed} removido(s)`);
  loadContacts();
};

// ---- Conexão ----
$('btn-restart').onclick = async () => {
  toast('Reiniciando navegador...');
  api('/api/whatsapp/restart', { method: 'POST' }).catch((e) => toast(e.message, true));
  setTimeout(refreshStatus, 500);
};
$('btn-logout').onclick = async () => {
  if (!confirm('Desconectar o WhatsApp atual? Será necessário ler o QR Code de novo.')) return;
  api('/api/whatsapp/logout', { method: 'POST' }).catch((e) => toast(e.message, true));
  setTimeout(refreshStatus, 500);
};

$('btn-logout-app').onclick = async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/login.html';
};

$('btn-password').onclick = () => {
  $('form-password').reset();
  $('pw-error').textContent = '';
  $('dlg-password').showModal();
};
$('pw-cancel').onclick = () => $('dlg-password').close();
$('form-password').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData($('form-password'));
  if (f.get('password') !== f.get('password2')) return ($('pw-error').textContent = 'As senhas não conferem.');
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ current: f.get('current'), password: f.get('password') }) });
    $('dlg-password').close();
    toast('Senha alterada');
  } catch (err) {
    $('pw-error').textContent = err.message;
  }
};

(async () => {
  const me = await api('/api/me');
  // Conta criada só pelo Google ainda não tem senha: não pede a atual.
  $('pw-current').hidden = !me.hasPassword;
  $('user-name').textContent = me.name || me.email;
  $('user').title = me.email;
  if (me.picture) {
    $('user-pic').src = me.picture;
    $('user-pic').hidden = false;
  }
  loadMessage();
  loadContacts();
  refreshStatus();
  setInterval(refreshStatus, 2500);
})();
