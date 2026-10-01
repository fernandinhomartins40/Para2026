const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { chromium } = require('playwright');
const { DATA_DIR } = require('./db');

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
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  async sendMessage({ phone, text, imagePath, imageFirst = false }) {
    if (this.state !== 'ready' || !this.page) throw new Error('WhatsApp não está conectado');
    if (this.busy) throw new Error('Já existe um envio em andamento, aguarde');
    if (!text && !imagePath) throw new Error('Configure a mensagem e/ou a imagem antes de enviar');
    this.busy = true;
    this.lastSeen = Date.now();
    try {
      await this.openChat(phone);
      await sleep(800);
      const steps = [];
      if (text) steps.push(() => this.sendText(text));
      if (imagePath) steps.push(() => this.sendImage(imagePath));
      if (imageFirst) steps.reverse();
      for (const step of steps) {
        await step();
        await this.waitDelivered();
        await sleep(800);
      }
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
