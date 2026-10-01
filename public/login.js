const errorEl = document.getElementById('login-error');
const forms = { login: document.getElementById('form-login'), register: document.getElementById('form-register') };

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

async function submit(url, body, button) {
  errorEl.textContent = '';
  button.disabled = true;
  try {
    await post(url, body);
    location.href = '/';
  } catch (err) {
    errorEl.textContent = err.message;
    button.disabled = false;
  }
}

function showTab(name) {
  for (const [key, form] of Object.entries(forms)) form.hidden = key !== name;
  document.querySelectorAll('#login-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  errorEl.textContent = '';
  forms[name].querySelector('input').focus();
}

document.getElementById('login-tabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
};

forms.login.onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(forms.login);
  submit('/auth/login', { email: f.get('email'), password: f.get('password') }, forms.login.querySelector('button'));
};

forms.register.onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(forms.register);
  if (f.get('password') !== f.get('password2')) {
    errorEl.textContent = 'As senhas não conferem.';
    return;
  }
  submit('/auth/register', { name: f.get('name'), email: f.get('email'), password: f.get('password') }, forms.register.querySelector('button'));
};

function loadGoogle(clientId) {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: (resp) => submit('/auth/google', { credential: resp.credential }, document.createElement('button')),
    });
    google.accounts.id.renderButton(document.getElementById('google-btn'), {
      theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'pt-BR',
    });
    document.getElementById('google-area').hidden = false;
  };
  document.head.appendChild(s);
}

(async () => {
  // Já logado? vai direto para o painel.
  if ((await fetch('/api/me')).ok) return (location.href = '/');
  const cfg = await (await fetch('/api/config')).json();
  if (!cfg.allowRegistration) document.getElementById('tab-register').hidden = true;
  if (location.hash === '#cadastro' && cfg.allowRegistration) showTab('register');
  if (cfg.googleClientId) loadGoogle(cfg.googleClientId);
})();
