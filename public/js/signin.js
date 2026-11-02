// The only admin script anyone can load. It shows the sign-in (or first-time setup) screen and,
// once the server confirms a signed-in admin, loads the control panel. The server refuses to send
// the panel's code (/js/app.js and the rest) to a browser that is not signed in.
import { h, api, installTooltips } from './signin-core.js';
import { loginView, setupView } from './views/auth.js';

const app = document.getElementById('app');
let panelOpen = false, opening = null;

function openPanel() { return opening || (opening = loadPanel()); }
async function loadPanel() {
  try {
    await import('/js/app.js');
    panelOpen = true; // from here the panel routes every link itself
  } catch {
    app.replaceChildren(loginView(() => location.reload()));
    app.querySelector('.auth-card')?.prepend(h('p', { class: 'form-error', role: 'alert' }, 'The control panel could not load. Please sign in again.'));
  }
}

async function start() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'setup' && parts[1]) {
    app.replaceChildren(setupView(parts[1], () => { location.hash = '#/overview'; openPanel(); }));
    return;
  }
  let admin = null;
  try { admin = (await api('/me')).admin; } catch { admin = null; }
  if (admin) { openPanel(); return; }
  app.replaceChildren(loginView(() => openPanel()));
}

installTooltips();
// A setup link opened in a tab that already shows the sign-in page only changes the # part.
window.addEventListener('hashchange', () => { if (!panelOpen && !opening) start(); });
start();
