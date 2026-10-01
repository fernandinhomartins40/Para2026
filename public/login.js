const errorEl = document.getElementById('login-error');

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

async function login(url, body) {
  errorEl.textContent = '';
  try {
    await post(url, body);
    location.href = '/';
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function waitGoogle() {
  return new Promise((resolve) => {
    const check = () => (window.google && google.accounts ? resolve() : setTimeout(check, 100));
    check();
  });
}

(async () => {
  // Já logado? vai direto para o painel.
  if ((await fetch('/api/me')).ok) return (location.href = '/');

  const cfg = await (await fetch('/api/config')).json();
  if (cfg.devLogin) {
    const form = document.getElementById('dev-form');
    form.hidden = false;
    form.onsubmit = (e) => {
      e.preventDefault();
      login('/auth/dev', { email: document.getElementById('dev-email').value });
    };
  }
  if (!cfg.googleClientId) {
    if (!cfg.devLogin) errorEl.textContent = 'Login com Google ainda não configurado (falta o GOOGLE_CLIENT_ID).';
    return;
  }
  await waitGoogle();
  google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: (resp) => login('/auth/google', { credential: resp.credential }),
  });
  google.accounts.id.renderButton(document.getElementById('google-btn'), {
    theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', locale: 'pt-BR',
  });
})();
