const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { chromium } = require('playwright');
const { DATA_DIR } = require('./db');
const { renderText } = require('./template');

const WAJS_PATH = require.resolve('@wppconnect/wa-js');

const SESSIONS_DIR = path.join(DATA_DIR, 'wa-sessions');
const HEADLESS = process.env.HEADLESS !== 'false';
// Máximo de navegadores abertos ao mesmo tempo (cada WhatsApp Web usa ~300-400 MB de RAM).
const MAX_BROWSERS = Number(process.env.MAX_BROWSERS) || 4;
// Fecha o navegador de quem ficou sem abrir a página por este tempo (a sessão fica salva em disco).
const IDLE_MS = (Number(process.env.IDLE_MINUTES) || 15) * 60 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEL = {
  logged: '#side, #pane-side',
  compose: '#main footer div[contenteditable="true"]',
  dialog: 'div[role="dialog"], [data-animate-modal-popup="true"]',
  attach: [
    '#main footer [data-icon="plus-rounded"]',
    '#main footer [data-icon="plus"]',
    '#main footer [data-icon="attach-menu-plus"]',
    '#main footer [data-icon="clip"]',
    '#main footer [title="Anexar"]',
    '#main footer [title="Attach"]',
    '#main footer [aria-label="Anexar"]',
    '#main footer [aria-label="Attach"]',
  ].join(', '),
  imageInput: 'input[type="file"][accept*="image"]',
  mediaSend: [
    '[data-icon="send"]',
    '[data-icon="wds-ic-send-filled"]',
    'div[aria-label="Enviar"]',
    'div[aria-label="Send"]',
  ].join(', '),
  pending: '#main [data-icon="msg-time"]',
  side: '#pane-side',
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Erro de verificação antes de tentar enviar (nada foi tentado): não marca o contato como falho.
const precheckError = (msg) => Object.assign(new Error(msg), { precheck: true });
// Remove cores ANSI e o "call log" do Playwright das mensagens de erro.
const cleanError = (err) => String(err.message || err).replace(/\u001b\[\d+m/g, '').split('\n')[0];

// Um WhatsApp Web (navegador + sessão em disco) por usuário.
class WhatsAppClient {
  constructor(userId) {
    this.userId = userId;
    this.sessionDir = path.join(SESSIONS_DIR, String(userId));
    this.context = null;
    this.page = null;
    this.state = 'stopped'; // stopped | waiting | starting | loading | qr | ready | error
    this.qrDataUrl = null;
    this.lastError = null;
    this.busy = false;
    this.pollTimer = null;
    this.lastQrRef = null;
    this.lastSeen = Date.now();
  }

  getStatus() {
    return { state: this.state, qr: this.state === 'qr' ? this.qrDataUrl : null, error: this.lastError, busy: this.busy };
  }

  get running() {
    return !!this.context || this.state === 'starting';
  }

  async start() {
    if (this.running) return;
    this.state = 'starting';
    this.lastError = null;
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      // Travas deixadas por um container anterior (outro hostname) impediriam abrir o perfil.
      // Seguro remover: este processo é o único que usa a pasta deste usuário.
      for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        fs.rmSync(path.join(this.sessionDir, f), { force: true });
      }
      this.context = await chromium.launchPersistentContext(this.sessionDir, {
        headless: HEADLESS,
        // Necessário para injetar o WA-JS no WhatsApp Web. Sem isso, a CSP da
        // página bloqueia page.addScriptTag({ path }) como script inline.
        bypassCSP: true,
        executablePath: process.env.CHROMIUM_PATH || undefined,
        userAgent: USER_AGENT,
        locale: 'pt-BR',
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
      this.context.on('close', () => {
        this.context = null;
        this.page = null;
        if (this.state !== 'error') this.state = 'stopped';
        clearInterval(this.pollTimer);
      });
      this.page = this.context.pages()[0] || (await this.context.newPage());
      await this.page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      this.state = 'loading';
      this.pollTimer = setInterval(() => this.poll().catch(() => {}), 2000);
      this.poll().catch(() => {});
    } catch (err) {
      this.lastError = cleanError(err);
      await this.stop();
      this.state = 'error';
    }
  }

  async stop() {
    clearInterval(this.pollTimer);
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
    if (this.state !== 'error') this.state = 'stopped';
  }

  async restart() {
    await this.stop();
    this.state = 'stopped';
    await this.start();
  }

  async logout() {
    await this.stop();
    fs.rmSync(this.sessionDir, { recursive: true, force: true });
    this.qrDataUrl = null;
    this.lastQrRef = null;
    this.state = 'stopped';
    await this.start();
  }

  // Verifica periodicamente se está logado ou se há QR Code para exibir.
  async poll() {
    const page = this.page;
    if (!page || page.isClosed() || this.busy) return;
    const info = await page.evaluate((loggedSel) => {
      const logged = !!document.querySelector(loggedSel);
      const refEl = document.querySelector('div[data-ref]');
      // Clica em "recarregar QR code" quando ele expira.
      const refresh = document.querySelector('[data-icon*="refresh"]');
      if (!logged && refresh) (refresh.closest('button') || refresh).click();
      return {
        logged,
        ref: refEl ? refEl.getAttribute('data-ref') : null,
        hasCanvas: !!document.querySelector('canvas'),
      };
    }, SEL.logged);

    if (info.logged) {
      this.state = 'ready';
      this.qrDataUrl = null;
      this.lastError = null;
      return;
    }
    if (info.ref) {
      if (info.ref !== this.lastQrRef) {
        this.lastQrRef = info.ref;
        this.qrDataUrl = await QRCode.toDataURL(info.ref, { width: 300, margin: 2 });
      }
      this.state = 'qr';
      return;
    }
    if (info.hasCanvas) {
      const buf = await page.locator('canvas').first().screenshot({ timeout: 5000 });
      this.qrDataUrl = 'data:image/png;base64,' + buf.toString('base64');
      this.state = 'qr';
      return;
    }
    if (this.state !== 'ready') this.state = 'loading';
  }

  async openChat(phone) {
    const page = this.page;
    await page.goto(`https://web.whatsapp.com/send?phone=${phone}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await page.locator(SEL.compose).first().isVisible().catch(() => false)) return;
      const dialog = page.locator(SEL.dialog).first();
      if (await dialog.isVisible().catch(() => false)) {
        const text = (await dialog.innerText().catch(() => '')).trim();
        if (/inv[aá]lid|n[aã]o est[aá] no whatsapp|not on whatsapp/i.test(text)) {
          await dialog.locator('button').first().click().catch(() => {});
          throw new Error('Número inválido ou sem WhatsApp');
        }
      }
      await sleep(500);
    }
    throw new Error('Tempo esgotado ao abrir a conversa');
  }

  async typeMultiline(text) {
    const kb = this.page.keyboard;
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await kb.insertText(lines[i]);
      if (i < lines.length - 1) {
        await kb.down('Shift');
        await kb.press('Enter');
        await kb.up('Shift');
      }
    }
  }

  async sendText(text) {
    const page = this.page;
    const box = page.locator(SEL.compose).first();
    await box.click();
    await this.typeMultiline(text);
    await sleep(300);
    await page.keyboard.press('Enter');
    // Confirma que saiu: a caixa de digitação fica vazia. Se não, tenta pelo botão de enviar.
    const emptied = await page
      .waitForFunction((sel) => !(document.querySelector(sel)?.innerText || '').trim(), SEL.compose, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!emptied) {
      await page.locator(`#main footer ${SEL.mediaSend.split(', ').join(', #main footer ')}`).first().click({ timeout: 3000 }).catch(() => {});
      const ok = await page
        .waitForFunction((sel) => !(document.querySelector(sel)?.innerText || '').trim(), SEL.compose, { timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (!ok) throw new Error('O texto não foi enviado (ficou na caixa de digitação)');
    }
  }

  // Procura a caixa de legenda do editor de mídia (um contenteditable fora do rodapé da conversa e da lista lateral).
  async waitMediaEditor(timeout) {
    try {
      await this.page.waitForFunction(
        () => {
          const els = [...document.querySelectorAll('div[contenteditable="true"]')].filter(
            (el) => !el.closest('#main footer') && !el.closest('#side') && el.offsetParent !== null
          );
          document.querySelectorAll('[data-wa-caption]').forEach((el) => el.removeAttribute('data-wa-caption'));
          if (els.length) els[els.length - 1].setAttribute('data-wa-caption', '1');
          return els.length > 0;
        },
        null,
        { timeout }
      );
      return true;
    } catch {
      return false;
    }
  }

  async pasteImage(imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    const payload = {
      b64: fs.readFileSync(imagePath).toString('base64'),
      mime: MIME[ext] || 'image/jpeg',
      name: 'imagem' + (ext || '.jpg'),
      sel: SEL.compose,
    };
    await this.page.locator(SEL.compose).first().click();
    await this.page.evaluate(({ b64, mime, name, sel }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: mime }));
      const target = document.querySelector(sel);
      target.focus();
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, payload);
  }

  async attachImage(imagePath) {
    await this.page.locator(SEL.attach).first().click({ timeout: 5000 });
    await sleep(500);
    await this.page.locator(SEL.imageInput).first().setInputFiles(imagePath);
  }

  // Envia só a imagem (sem legenda): o texto vai como mensagem separada.
  async sendImage(imagePath) {
    const page = this.page;
    await this.pasteImage(imagePath);
    let opened = await this.waitMediaEditor(8000);
    if (!opened) {
      await this.attachImage(imagePath);
      opened = await this.waitMediaEditor(10000);
    }
    if (!opened) throw new Error('Não foi possível abrir o editor de imagem do WhatsApp');

    await sleep(700);
    // Foco no editor da imagem (legenda vazia) para o Enter enviar a imagem.
    await page.locator('[data-wa-caption="1"]').click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Enter');

    // Espera o editor de mídia fechar; se não fechar, clica no botão de enviar.
    const closed = await page
      .waitForFunction(() => !document.querySelector('[data-wa-caption="1"]') || document.querySelector('[data-wa-caption="1"]').offsetParent === null, null, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!closed) {
      await page.locator(SEL.mediaSend).last().click({ timeout: 5000 });
    }
  }

  async waitDelivered() {
    await sleep(1500);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if ((await this.page.locator(SEL.pending).count()) === 0) return;
      await sleep(1000);
    }
    throw new Error('A mensagem ficou pendente (relógio) por muito tempo');
  }

  // Texto e imagem vão em duas mensagens separadas, na ordem escolhida (padrão: texto primeiro).
  // O texto é montado com o nome da lista (primeiro nome). Retorna { text } com o texto enviado.
  // Extracts contact JIDs attached by WhatsApp Web to visible UI items. Saved
  // contacts often only show a name, so the React data attached to each row is
  // inspected as a fallback to DOM attributes.
  async collectVisibleContacts(rootSelector, source) {
    return this.page.evaluate(({ rootSelector, source }) => {
      const root = document.querySelector(rootSelector);
      if (!root) return [];
      const phoneFrom = (value) => {
        const match = String(value || '').match(/(?:^|[^\d])(\d{7,15})@(?:c\.us|s\.whatsapp\.net)(?:$|[^\w])/);
        return match ? match[1] : null;
      };
      const cleanName = (value) => {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 120 || /^\+?[\d\s().-]+$/.test(text)) return null;
        return text;
      };
      const candidates = [...root.querySelectorAll('[role="row"], [data-id], [data-testid="cell-frame-container"]')];
      const rows = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
      const output = [];

      for (const row of rows.length ? rows : [root]) {
        const phones = new Set();
        for (const el of [row, ...row.querySelectorAll('*')]) {
          for (const attr of el.attributes || []) {
            const phone = phoneFrom(attr.value);
            if (phone) phones.add(phone);
          }
        }

        const seen = new WeakSet();
        let visited = 0;
        const inspect = (value, depth) => {
          if (visited++ > 2500 || depth > 7 || value == null) return;
          if (typeof value === 'string') {
            const phone = phoneFrom(value);
            if (phone) phones.add(phone);
            return;
          }
          if (typeof value !== 'object' || seen.has(value)) return;
          seen.add(value);
          for (const key of Object.keys(value)) {
            if (key === 'return' || key === 'sibling' || key === 'alternate' || key === '_owner' || key === 'stateNode') continue;
            try { inspect(value[key], depth + 1); } catch {}
          }
        };
        for (const key of Object.keys(row)) {
          if (key.startsWith('__reactProps') || key.startsWith('__reactFiber')) inspect(row[key], 0);
        }

        const title = [...row.querySelectorAll('span[title]')]
          .map((el) => cleanName(el.getAttribute('title')))
          .find(Boolean);
        for (const phone of phones) output.push({ phone, name: title, source });
      }
      return output;
    }, { rootSelector, source });
  }

  async ensureWppInjected() {
    const ready = await this.page.evaluate(() => !!window.WPP?.isReady).catch(() => false);
    if (!ready) {
      await this.page.addScriptTag({ path: WAJS_PATH });
      await this.page.waitForFunction(() => !!window.WPP?.isReady, null, { timeout: 45000 });
    }
  }

  async listGroupsWithWpp() {
    await this.ensureWppInjected();
    return this.page.evaluate(async () => {
      const groups = await WPP.group.getAllGroups();
      const value = (wid) => wid?._serialized || wid?.id?._serialized || (typeof wid === 'string' ? wid : null);
      return (groups || []).filter(Boolean).map((group) => ({
        id: value(group.id),
        name: group.formattedTitle || group.name || group.contact?.name || group.contact?.pushname || 'Grupo sem nome',
      })).filter((group) => group.id?.endsWith('@g.us'));
    });
  }

  async extractWithWpp(source, groupIds) {
    await this.ensureWppInjected();
    return this.page.evaluate(async ({ source, groupIds }) => {
      const widValue = (value) => value?._serialized || value?.id?._serialized || (typeof value === 'string' ? value : null);
      const digitsFromWid = (value) => {
        const wid = widValue(value) || '';
        const match = wid.match(/^(\d{7,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/);
        return match ? match[1] : null;
      };
      const cleanName = (...values) => {
        for (const value of values) {
          const name = String(value || '').replace(/\s+/g, ' ').trim();
          if (name && name.length <= 120 && !/^\+?[\d\s().-]+$/.test(name)) {
            return name.split(' ')[0].replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '') || null;
          }
        }
        return null;
      };
      const isUserWid = (model) => {
        const id = widValue(model?.id || model) || '';
        return /@(?:c\.us|s\.whatsapp\.net|lid)$/.test(id) && !id.endsWith('@g.us');
      };
      const resolveContact = async (model, sourceName) => {
        const id = widValue(model?.id || model);
        let entry = null;
        if (id) entry = await WPP.contact.getPnLidEntry(id).catch(() => null);
        const phone = digitsFromWid(entry?.phoneNumber) || digitsFromWid(model?.phoneNumber) || digitsFromWid(id);
        const info = entry?.contact || {};
        return {
          phone,
          name: cleanName(model?.name, model?.formattedName, model?.pushname, model?.shortName,
            info.name, info.verifiedName, info.pushname, info.shortName),
          source: sourceName,
          unresolved: !phone,
        };
      };

      const resolved = [];
      if (source === 'contacts') {
        const contacts = await WPP.contact.list({ onlyMyContacts: true });
        for (const contact of (contacts || []).filter(isUserWid)) {
          resolved.push(await resolveContact(contact, 'contato salvo'));
        }
      } else if (source === 'chats') {
        const chats = await WPP.chat.list({ onlyUsers: true });
        for (const chat of (chats || []).filter((item) => isUserWid(item.contact || item))) {
          resolved.push(await resolveContact(chat.contact || chat, 'conversa'));
        }
      } else {
        const groups = await WPP.group.getAllGroups();
        const groupsById = new Map((groups || []).filter(Boolean).map((group) => [widValue(group.id), group]));
        for (const groupId of groupIds) {
          const group = groupsById.get(groupId);
          const groupName = group?.formattedTitle || group?.name || 'grupo selecionado';
          const participants = await WPP.group.getParticipants(groupId);
          for (const participant of participants || []) {
            resolved.push(await resolveContact(participant.contact || participant, groupName));
          }
        }
      }

      const contacts = resolved.filter((item) => item.phone).map(({ unresolved, ...item }) => item);
      return { contacts, unresolved: resolved.filter((item) => item.unresolved).length, examined: resolved.length };
    }, { source, groupIds });
  }

  async collectVisibleGroups() {
    return this.page.evaluate((rootSelector) => {
      const root = document.querySelector(rootSelector);
      if (!root) return [];
      const rows = [...root.querySelectorAll('[role="row"]')];
      const output = [];
      const inspectRow = (row) => {
        const ids = new Set();
        const findId = (value) => {
          const match = String(value || '').match(/([\d-]+)@g\.us/);
          if (match) ids.add(match[1] + '@g.us');
        };
        for (const el of [row, ...row.querySelectorAll('*')]) {
          for (const attr of el.attributes || []) findId(attr.value);
        }
        const seen = new WeakSet();
        let visited = 0;
        const inspect = (value, depth) => {
          if (visited++ > 2500 || depth > 7 || value == null) return;
          if (typeof value === 'string') return findId(value);
          if (typeof value !== 'object' || seen.has(value)) return;
          seen.add(value);
          for (const key of Object.keys(value)) {
            if (['return', 'sibling', 'alternate', '_owner', 'stateNode'].includes(key)) continue;
            try { inspect(value[key], depth + 1); } catch {}
          }
        };
        for (const key of Object.keys(row)) {
          if (key.startsWith('__reactProps') || key.startsWith('__reactFiber')) inspect(row[key], 0);
        }
        const name = [...row.querySelectorAll('span[title]')]
          .map((el) => (el.getAttribute('title') || '').replace(/\s+/g, ' ').trim())
          .find(Boolean);
        for (const id of ids) output.push({ id, name: name || 'Grupo sem nome' });
      };
      rows.forEach(inspectRow);
      return output;
    }, SEL.side);
  }

  async scanGroups() {
    const side = this.page.locator(SEL.side);
    if (!(await side.isVisible().catch(() => false))) throw new Error('A lista de conversas não está disponível');
    const groups = new Map();
    await side.evaluate((el) => { el.scrollTop = 0; });
    for (let attempts = 0; attempts < 500 && groups.size < 1000; attempts++) {
      for (const group of await this.collectVisibleGroups()) groups.set(group.id, group);
      const moved = await side.evaluate((el) => {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + Math.max(300, el.clientHeight * 0.8), el.scrollHeight);
        return el.scrollTop !== before;
      });
      if (!moved) break;
      await sleep(400);
    }
    await side.evaluate((el) => { el.scrollTop = 0; });
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async listGroups() {
    if (this.state !== 'ready' || !this.page) throw precheckError('WhatsApp não está conectado');
    if (this.busy) throw precheckError('Já existe uma operação em andamento, aguarde');
    this.busy = true;
    this.lastSeen = Date.now();
    try {
      return await this.listGroupsWithWpp();
    } finally {
      this.busy = false;
      this.lastSeen = Date.now();
    }
  }

  async openGroup(groupId) {
    const side = this.page.locator(SEL.side);
    await side.evaluate((el) => { el.scrollTop = 0; });
    for (let attempts = 0; attempts < 200; attempts++) {
      const clicked = await this.page.evaluate(({ rootSelector, groupId }) => {
        const root = document.querySelector(rootSelector);
        const rows = root ? [...root.querySelectorAll('[role="row"]')] : [];
        const containsId = (row) => {
          const needle = groupId;
          for (const el of [row, ...row.querySelectorAll('*')]) {
            for (const attr of el.attributes || []) if (String(attr.value).includes(needle)) return true;
          }
          const seen = new WeakSet();
          let visited = 0;
          const inspect = (value, depth) => {
            if (visited++ > 2500 || depth > 7 || value == null) return false;
            if (typeof value === 'string') return value.includes(needle);
            if (typeof value !== 'object' || seen.has(value)) return false;
            seen.add(value);
            for (const key of Object.keys(value)) {
              if (['return', 'sibling', 'alternate', '_owner', 'stateNode'].includes(key)) continue;
              try { if (inspect(value[key], depth + 1)) return true; } catch {}
            }
            return false;
          };
          for (const key of Object.keys(row)) {
            if ((key.startsWith('__reactProps') || key.startsWith('__reactFiber')) && inspect(row[key], 0)) return true;
          }
          return false;
        };
        const row = rows.find(containsId);
        if (!row) return false;
        row.click();
        return true;
      }, { rootSelector: SEL.side, groupId });
      if (clicked) {
        await sleep(1200);
        return;
      }
      const moved = await side.evaluate((el) => {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + Math.max(300, el.clientHeight * 0.8), el.scrollHeight);
        return el.scrollTop !== before;
      });
      if (!moved) break;
      await sleep(350);
    }
    throw new Error('O grupo selecionado não foi encontrado no WhatsApp');
  }

  async extractSavedContacts() {
    const button = this.page.locator([
      '[data-icon="new-chat-outline"]',
      '[data-icon="new-chat"]',
      'button[aria-label="Nova conversa"]',
      'button[aria-label="New chat"]',
      '[title="Nova conversa"]',
      '[title="New chat"]',
    ].join(', ')).first();
    if (!(await button.isVisible().catch(() => false))) {
      throw new Error('Não foi possível abrir a lista de contatos do WhatsApp');
    }
    await button.click();
    await sleep(900);

    const pickerFound = await this.page.evaluate(() => {
      document.querySelectorAll('[data-wa-contact-picker]').forEach((el) => el.removeAttribute('data-wa-contact-picker'));
      const visible = (el) => el.offsetParent !== null && el.clientHeight > 150;
      const candidates = [...document.querySelectorAll('div')]
        .filter((el) => visible(el) && el.scrollHeight > el.clientHeight + 20 && el.querySelector('[role="row"]'))
        .sort((a, b) => {
          const aSide = a.closest('#side') ? 1 : 0;
          const bSide = b.closest('#side') ? 1 : 0;
          return bSide - aSide || b.clientHeight - a.clientHeight;
        });
      const picker = candidates[0];
      if (!picker) return false;
      picker.setAttribute('data-wa-contact-picker', '1');
      picker.scrollTop = 0;
      return true;
    });
    if (!pickerFound) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error('A lista de contatos não foi carregada pelo WhatsApp');
    }

    const found = [];
    try {
      const picker = this.page.locator('[data-wa-contact-picker="1"]');
      for (let attempts = 0; attempts < 500 && found.length < 10000; attempts++) {
        found.push(...await this.collectVisibleContacts('[data-wa-contact-picker="1"]', 'contato salvo'));
        const moved = await picker.evaluate((el) => {
          const before = el.scrollTop;
          el.scrollTop = Math.min(el.scrollTop + Math.max(300, el.clientHeight * 0.8), el.scrollHeight);
          return el.scrollTop !== before;
        });
        if (!moved) break;
        await sleep(350);
      }
      return found;
    } finally {
      await this.page.keyboard.press('Escape').catch(() => {});
    }
  }

  async extractContacts({ source = 'chats', groupIds = [] } = {}) {
    if (this.state !== 'ready' || !this.page) throw precheckError('WhatsApp não está conectado');
    if (this.busy) throw precheckError('Já existe uma operação em andamento, aguarde');
    if (!['chats', 'contacts', 'groups'].includes(source)) throw precheckError('Fonte de extração inválida');
    if (source === 'groups' && (!Array.isArray(groupIds) || !groupIds.length)) {
      throw precheckError('Selecione pelo menos um grupo');
    }
    if (source === 'groups' && groupIds.length > 20) throw precheckError('Selecione no máximo 20 grupos por extração');
    this.busy = true;
    this.lastSeen = Date.now();
    try {
      const result = await this.extractWithWpp(source, [...new Set(groupIds)]);
      const byPhone = new Map();
      for (const item of result.contacts) {
        const current = byPhone.get(item.phone);
        if (!current || (!current.name && item.name)) byPhone.set(item.phone, item);
      }
      return { ...result, contacts: [...byPhone.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR')) };
    } catch (err) {
      throw new Error(`Falha ao ler os dados internos do WhatsApp: ${cleanError(err)}`);
    } finally {
      this.busy = false;
      this.lastSeen = Date.now();
    }
  }

  async extractContactsLegacy({ source = 'chats', groupIds = [] } = {}) {
    if (this.state !== 'ready' || !this.page) throw precheckError('WhatsApp não está conectado');
    if (this.busy) throw precheckError('Já existe uma operação em andamento, aguarde');
    if (!['chats', 'contacts', 'groups'].includes(source)) throw precheckError('Fonte de extração inválida');
    if (source === 'groups' && (!Array.isArray(groupIds) || !groupIds.length)) {
      throw precheckError('Selecione pelo menos um grupo');
    }
    this.busy = true;
    this.lastSeen = Date.now();
    try {
      const found = [];
      if (source === 'chats') {
        const side = this.page.locator(SEL.side);
        if (!(await side.isVisible().catch(() => false))) throw new Error('A lista de conversas não está disponível');
        let unchanged = 0;
        let previousSize = 0;
        await side.evaluate((el) => { el.scrollTop = 0; });
        while (unchanged < 4 && found.length < 5000) {
          found.push(...await this.collectVisibleContacts(SEL.side, 'conversa'));
          const uniqueSize = new Set(found.map((x) => x.phone)).size;
          unchanged = uniqueSize === previousSize ? unchanged + 1 : 0;
          previousSize = uniqueSize;
          const moved = await side.evaluate((el) => {
            const before = el.scrollTop;
            el.scrollTop = Math.min(el.scrollTop + Math.max(300, el.clientHeight * 0.8), el.scrollHeight);
            return el.scrollTop !== before;
          });
          if (!moved) unchanged++;
          await sleep(500);
        }
        await side.evaluate((el) => { el.scrollTop = 0; });
      } else if (source === 'contacts') {
        found.push(...await this.extractSavedContacts());
      } else {
        const available = await this.scanGroups();
        const availableById = new Map(available.map((group) => [group.id, group]));
        const selected = [...new Set(groupIds)].map((id) => availableById.get(id)).filter(Boolean);
        if (selected.length !== new Set(groupIds).size) throw new Error('Um dos grupos selecionados não está mais disponível');
        if (selected.length > 20) throw new Error('Selecione no máximo 20 grupos por extração');
        for (const group of selected) {
          await this.openGroup(group.id);
          found.push(...await this.collectVisibleContacts('#main', group.name));
        }
      }

      const byPhone = new Map();
      for (const item of found) {
        if (!item.phone) continue;
        const current = byPhone.get(item.phone);
        if (!current || (!current.name && item.name)) byPhone.set(item.phone, item);
      }
      return [...byPhone.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
    } catch (err) {
      throw new Error(cleanError(err));
    } finally {
      this.busy = false;
      this.lastSeen = Date.now();
    }
  }

  async sendMessage({ phone, template, listName, imagePath, imageFirst = false }) {
    if (this.state !== 'ready' || !this.page) throw precheckError('WhatsApp não está conectado');
    if (this.busy) throw precheckError('Já existe um envio em andamento, aguarde');
    if (!String(template || '').trim() && !imagePath) throw precheckError('Configure a mensagem e/ou a imagem antes de enviar');
    this.busy = true;
    this.lastSeen = Date.now();
    try {
      await this.openChat(phone);
      await sleep(800);
      const text = renderText(template, listName);
      const steps = [];
      if (text) steps.push(() => this.sendText(text));
      if (imagePath) steps.push(() => this.sendImage(imagePath));
      if (imageFirst) steps.reverse();
      for (const step of steps) {
        await step();
        await this.waitDelivered();
        await sleep(800);
      }
      return { text };
    } catch (err) {
      throw new Error(cleanError(err));
    } finally {
      this.busy = false;
      this.lastSeen = Date.now();
    }
  }
}

// ---- Gerenciador: um cliente por usuário, com limite de navegadores abertos ----
const clients = new Map();

function get(userId) {
  let c = clients.get(userId);
  if (!c) {
    c = new WhatsAppClient(userId);
    clients.set(userId, c);
  }
  return c;
}

// Garante o navegador do usuário aberto. No limite, fecha o de quem está ocioso há mais tempo;
// se todos estiverem em uso, o usuário fica em espera ('waiting') e entra quando abrir vaga.
// Em estado de erro só reabre com force (botão "Reconectar"), para não ficar em loop.
const EVICT_AFTER_MS = 2 * 60 * 1000;

async function ensureStarted(userId, { force = false } = {}) {
  const c = get(userId);
  c.lastSeen = Date.now();
  if (c.running) return c;
  if (c.state === 'error' && !force) return c;
  const running = [...clients.values()].filter((x) => x.running);
  if (running.length >= MAX_BROWSERS) {
    const now = Date.now();
    const victim = running
      .filter((x) => !x.busy && now - x.lastSeen > EVICT_AFTER_MS)
      .sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (!victim) {
      c.state = 'waiting';
      c.lastError = 'Servidor no limite de conexões simultâneas. Você entra automaticamente quando abrir uma vaga.';
      return c;
    }
    await victim.stop();
  }
  c.lastError = null;
  c.start(); // em segundo plano; o status é acompanhado pela página
  return c;
}

// Fecha navegadores de quem não abre a página há IDLE_MS (a sessão do WhatsApp continua salva).
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    if (c.running && !c.busy && now - c.lastSeen > IDLE_MS) c.stop();
  }
}, 60 * 1000).unref();

async function stopAll() {
  await Promise.all([...clients.values()].map((c) => c.stop()));
}

function stats() {
  const all = [...clients.values()];
  return { running: all.filter((c) => c.running).length, max: MAX_BROWSERS };
}

module.exports = { get, ensureStarted, stopAll, stats };
