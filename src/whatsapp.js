const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { chromium } = require('playwright');
const { DATA_DIR } = require('./db');

const SESSION_DIR = path.join(DATA_DIR, 'wa-session');
const HEADLESS = process.env.HEADLESS !== 'false';
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

let context = null;
let page = null;
let state = 'stopped'; // stopped | starting | loading | qr | ready | error
let qrDataUrl = null;
let lastError = null;
let busy = false;
let pollTimer = null;
let lastQrRef = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Remove cores ANSI e o "call log" do Playwright das mensagens de erro.
const cleanError = (err) => String(err.message || err).replace(/\u001b\[\d+m/g, '').split('\n')[0];

function getStatus() {
  return { state, qr: state === 'qr' ? qrDataUrl : null, error: lastError, busy };
}

async function start() {
  if (context) return;
  state = 'starting';
  lastError = null;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: HEADLESS,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      userAgent: USER_AGENT,
      locale: 'pt-BR',
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    context.on('close', () => {
      context = null;
      page = null;
      if (state !== 'error') state = 'stopped';
      clearInterval(pollTimer);
    });
    page = context.pages()[0] || (await context.newPage());
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    state = 'loading';
    pollTimer = setInterval(() => poll().catch(() => {}), 2000);
    poll().catch(() => {});
  } catch (err) {
    state = 'error';
    lastError = cleanError(err);
    await stop();
    state = 'error';
  }
}

async function stop() {
  clearInterval(pollTimer);
  const ctx = context;
  context = null;
  page = null;
  if (ctx) await ctx.close().catch(() => {});
  if (state !== 'error') state = 'stopped';
}

async function restart() {
  await stop();
  await start();
}

async function logout() {
  await stop();
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  qrDataUrl = null;
  lastQrRef = null;
  await start();
}

// Verifica periodicamente se está logado ou se há QR Code para exibir.
async function poll() {
  if (!page || page.isClosed() || busy) return;
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
    state = 'ready';
    qrDataUrl = null;
    lastError = null;
    return;
  }
  if (info.ref) {
    if (info.ref !== lastQrRef) {
      lastQrRef = info.ref;
      qrDataUrl = await QRCode.toDataURL(info.ref, { width: 300, margin: 2 });
    }
    state = 'qr';
    return;
  }
  if (info.hasCanvas) {
    const buf = await page.locator('canvas').first().screenshot({ timeout: 5000 });
    qrDataUrl = 'data:image/png;base64,' + buf.toString('base64');
    state = 'qr';
    return;
  }
  if (state !== 'ready') state = 'loading';
}

async function openChat(phone) {
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

async function typeMultiline(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    }
  }
}

async function sendText(text) {
  const box = page.locator(SEL.compose).first();
  await box.click();
  await typeMultiline(text);
  await sleep(300);
  await page.keyboard.press('Enter');
}

// Procura a caixa de legenda do editor de mídia (um contenteditable fora do rodapé da conversa e da lista lateral).
async function waitMediaEditor(timeout) {
  try {
    await page.waitForFunction(
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

async function pasteImage(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const payload = {
    b64: fs.readFileSync(imagePath).toString('base64'),
    mime: MIME[ext] || 'image/jpeg',
    name: 'imagem' + (ext || '.jpg'),
    sel: SEL.compose,
  };
  await page.locator(SEL.compose).first().click();
  await page.evaluate(({ b64, mime, name, sel }) => {
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

async function attachImage(imagePath) {
  await page.locator(SEL.attach).first().click({ timeout: 5000 });
  await sleep(500);
  await page.locator(SEL.imageInput).first().setInputFiles(imagePath);
}

async function sendImage(imagePath, caption) {
  await pasteImage(imagePath);
  let opened = await waitMediaEditor(8000);
  if (!opened) {
    await attachImage(imagePath);
    opened = await waitMediaEditor(10000);
  }
  if (!opened) throw new Error('Não foi possível abrir o editor de imagem do WhatsApp');

  await sleep(500);
  let captionSent = false;
  if (caption) {
    const captionBox = page.locator('[data-wa-caption="1"]');
    if (await captionBox.isVisible().catch(() => false)) {
      await captionBox.click();
      await typeMultiline(caption);
      captionSent = true;
    }
  }
  await sleep(300);
  await page.keyboard.press('Enter');

  // Espera o editor de mídia fechar
  const closed = await page
    .waitForFunction(() => !document.querySelector('[data-wa-caption="1"]') || document.querySelector('[data-wa-caption="1"]').offsetParent === null, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    await page.locator(SEL.mediaSend).last().click({ timeout: 5000 });
  }

  if (caption && !captionSent) {
    await sleep(800);
    await sendText(caption);
  }
}

async function waitDelivered() {
  await sleep(1500);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if ((await page.locator(SEL.pending).count()) === 0) return;
    await sleep(1000);
  }
  throw new Error('A mensagem ficou pendente (relógio) por muito tempo');
}

async function sendMessage({ phone, text, imagePath }) {
  if (state !== 'ready' || !page) throw new Error('WhatsApp não está conectado');
  if (busy) throw new Error('Já existe um envio em andamento, aguarde');
  if (!text && !imagePath) throw new Error('Configure a mensagem e/ou a imagem antes de enviar');
  busy = true;
  try {
    await openChat(phone);
    await sleep(800);
    if (imagePath) await sendImage(imagePath, text);
    else await sendText(text);
    await waitDelivered();
  } catch (err) {
    throw new Error(cleanError(err));
  } finally {
    busy = false;
  }
}

module.exports = { start, stop, restart, logout, getStatus, sendMessage };
