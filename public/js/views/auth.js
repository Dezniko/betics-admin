// Sign in, and first-time account setup (password + authenticator app).
import { h, api, toast, field } from '../signin-core.js';
import { qrSvg } from '../qr.js';

const shell = (...children) => h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
  h('div', { class: 'logo big' }, h('i'), 'qu-BETICS Admin'), ...children));

export function loginView(onDone) {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com' });
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { class: 'input code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123 456' });
  const codeRow = field('6-digit code from your authenticator app', code, 'Open Google Authenticator (or 1Password, Authy) and type the code shown for qu-BETICS Admin. It changes every 30 seconds.');
  codeRow.hidden = true;
  const msg = h('p', { class: 'form-error', role: 'alert' });
  const button = h('button', { class: 'btn primary wide', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault(); msg.textContent = ''; button.disabled = true;
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: email.value, password: password.value, code: codeRow.hidden ? undefined : code.value.replace(/\s/g, '') } });
      if (r.needCode) { codeRow.hidden = false; code.focus(); button.textContent = 'Check code and sign in'; return; }
      onDone(r.admin);
    } catch (err) { msg.textContent = err.message; } finally { button.disabled = false; }
  } }, field('Email', email), field('Password', password), codeRow, msg, button);
  return shell(h('h1', {}, 'Sign in'), h('p', { class: 'sub' }, 'Casino control panel. You will need your password and your authenticator app.'), form);
}

export function setupView(token, onDone) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'sub' }, 'Checking your setup link...'));
  const view = shell(h('h1', {}, 'Set up your account'), body);
  (async () => {
    let who;
    try { who = await api('/auth/setup/info', { method: 'POST', body: { token } }); }
    catch (e) { body.replaceChildren(h('p', { class: 'form-error' }, e.message)); return; }
    const steps = h('ol', { class: 'steps' }, h('li', { class: 'now' }, 'Choose a password'), h('li', {}, 'Connect your authenticator app'), h('li', {}, 'Done'));
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 12 });
    const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const msg = h('p', { class: 'form-error', role: 'alert' });
    const go = h('button', { class: 'btn primary wide', type: 'submit' }, 'Save password');
    body.replaceChildren(h('p', { class: 'sub' }, `${who.name}, you are joining as ${who.role} (${who.email}).`), steps,
      h('form', { class: 'stack', onsubmit: async e => {
        e.preventDefault(); msg.textContent = '';
        if (pw.value !== pw2.value) { msg.textContent = 'The two passwords do not match.'; return; }
        go.disabled = true;
        try { const r = await api('/auth/setup/password', { method: 'POST', body: { token, password: pw.value } }); stepTwo(r); }
        catch (err) { msg.textContent = err.message; } finally { go.disabled = false; }
      } }, field('New password', pw, 'At least 12 characters, with letters and at least one number. A short sentence works well.'), field('Type it again', pw2), msg, go));
    function stepTwo({ secret, uri }) {
      steps.children[0].className = 'done'; steps.children[1].className = 'now';
      const code = h('input', { class: 'input code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123 456' });
      const msg2 = h('p', { class: 'form-error', role: 'alert' });
      const ok = h('button', { class: 'btn primary wide', type: 'submit' }, 'Finish setup');
      const keyText = secret.match(/.{1,4}/g).join(' ');
      body.replaceChildren(steps,
        h('p', {}, '1. On your phone, open Google Authenticator (or 1Password, Authy, Microsoft Authenticator).'),
        h('p', {}, '2. Tap the + button and scan this code:'),
        h('div', { class: 'qr', html: qrSvg(uri, { scale: 5 }), 'aria-label': 'QR code for your authenticator app' }),
        h('details', { class: 'muted' }, h('summary', {}, 'Cannot scan? Type this key instead'), h('p', { class: 'mono' }, keyText),
          h('button', { class: 'btn small', type: 'button', onclick: () => { navigator.clipboard.writeText(secret); toast('Key copied'); } }, 'Copy key')),
        h('p', {}, '3. Type the 6-digit code the app now shows for qu-BETICS Admin:'),
        h('form', { class: 'stack', onsubmit: async e => {
          e.preventDefault(); msg2.textContent = ''; ok.disabled = true;
          try { const r = await api('/auth/setup/code', { method: 'POST', body: { token, code: code.value.replace(/\s/g, '') } }); history.replaceState(null, '', '/#/overview'); toast('All set. Welcome in.'); onDone(r.admin); }
          catch (err) { msg2.textContent = err.message; } finally { ok.disabled = false; }
        } }, code, msg2, ok));
      code.focus();
    }
  })();
  return view;
}
