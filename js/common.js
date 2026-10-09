/* Shared helpers: API wrapper, auth check, navbar, theme, toast, modal */
const DEFAULT_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#b4b8b8"/><circle cx="50" cy="38" r="18" fill="#eee"/><ellipse cx="50" cy="90" rx="32" ry="26" fill="#eee"/></svg>');
let currentUser = null;

/* ----- theme (saved in DB; localStorage is only a flash-prevention cache) ----- */
function applyTheme(theme) {
  let eff = theme || 'system';
  if (eff === 'system') eff = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', eff);
  try { localStorage.setItem('theme_cache', theme || 'system'); } catch (e) {}
}
try { applyTheme(localStorage.getItem('theme_cache')); } catch (e) {}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentUser && currentUser.theme === 'system') applyTheme('system'); });

/* ----- sidebar: expanded <-> icon-only (mobile default) ----- */
const MINI_BP = 800;
(function () {      // runs in <head> so there is no flash of the wrong size
  let saved = null; try { saved = localStorage.getItem('sidebar_mini'); } catch (e) {}
  document.documentElement.classList.toggle('mini', innerWidth <= MINI_BP ? true : saved === '1');
})();
function setupSidebar() {
  document.querySelectorAll('.nav a').forEach(a => {      // wrap bare label text so CSS can hide it
    const texts = [...a.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
    if (texts.length) {
      const span = document.createElement('span'); span.className = 'label';
      span.textContent = texts.map(n => n.textContent.trim()).join(' ');
      texts[0].replaceWith(span); texts.slice(1).forEach(n => n.remove());
    }
    const l = a.querySelector('.label'); if (l) a.title = l.textContent.trim();   // tooltip in icon mode
  });
  const root = document.documentElement, t = document.getElementById('menuToggle');
  if (t) t.addEventListener('click', () => {
    const mini = root.classList.toggle('mini');
    if (innerWidth > MINI_BP) { try { localStorage.setItem('sidebar_mini', mini ? '1' : '0'); } catch (e) {} }  // remember on desktop only
  });
  const main = document.querySelector('.main');            // mobile: tap the page to close the expanded menu
  if (main) main.addEventListener('click', () => { if (innerWidth <= MINI_BP) root.classList.add('mini'); });
}

/* ----- API wrapper: try the real backend first, then fall back to local browser storage ----- */
async function api(url, opts = {}) {
  const method = (opts.method || (opts.json !== undefined ? 'POST' : 'GET')).toUpperCase();
  const headers = { ...(opts.headers || {}) };
  const hasJsonBody = opts.json !== undefined;

  if (hasJsonBody && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const requestInit = {
    method,
    headers,
    credentials: 'same-origin',
  };

  if (opts.body !== undefined) requestInit.body = opts.body;
  else if (hasJsonBody) requestInit.body = JSON.stringify(opts.json);

  try {
    const response = await fetch(url, requestInit);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const err = new Error(payload.message || 'Request failed.');
      err.status = response.status;
      throw err;
    }
    return await response.json();
  } catch (e) {
    // If backend was reached and returned a client error (validation, wrong password, conflict), throw it directly
    if (e.status && e.status >= 400 && e.status < 500) {
      if (e.status === 401 && !url.startsWith('/api/auth/login') && !url.startsWith('/api/auth/me')) location.href = 'login.html';
      if (e.status === 401 && url.startsWith('/api/auth/me') && !/(login|signup)\.html/.test(location.pathname)) location.href = 'login.html';
      throw e;
    }
    try {
      return await localApi(url, opts);
    } catch (localErr) {
      if (localErr.status === 401 && !url.startsWith('/api/auth/login') && !url.startsWith('/api/auth/me')) location.href = 'login.html';
      if (localErr.status === 401 && url.startsWith('/api/auth/me') && !/(login|signup)\.html/.test(location.pathname)) location.href = 'login.html';
      throw e?.status ? e : localErr;
    }
  }
}

/* ----- auth ----- */
async function getCurrentUser() {
  const { user } = await api('/api/auth/me');
  currentUser = user; applyTheme(user.theme); return user;
}
function renderUserChrome() {
  const e = document.getElementById('userEmail'); if (e) e.textContent = currentUser.email;
  const a = document.getElementById('navAvatar'); if (a) a.src = currentUser.avatarUrl || DEFAULT_AVATAR;
  const s = document.getElementById('settingsAvatar'); if (s) s.src = currentUser.avatarUrl || DEFAULT_AVATAR;
}
async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  try { localStorage.removeItem('osp_session'); } catch (e) {}
  try { localStorage.removeItem('theme_cache'); } catch (e) {}
  if (window.firebaseAuth && typeof window.firebaseAuth.signOut === 'function') {
    try { await window.firebaseAuth.signOut(); } catch (e) {}
  }
  location.href = 'login.html';
}
async function initPage() {       // call at start of every authenticated page
  const user = await getCurrentUser();
  renderUserChrome();
  document.querySelectorAll('[data-action="logout"]').forEach(el => el.addEventListener('click', logout));
  setupSidebar();
  return user;
}

/* ----- UI helpers ----- */
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function html(str) { const t = document.createElement('template'); t.innerHTML = str.trim(); return t.content.firstElementChild; }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(s) { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-'); return `${MONTHS[+m - 1]} ${+d}`; }
function fmtRange(a, b) { return a === b ? fmtDate(a) : `${fmtDate(a)} - ${fmtDate(b)}`; }
function fmtBytes(n) { n = Number(n); return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
function toast(msg, type = 'ok') {
  const box = document.getElementById('toasts') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toasts' }));
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; box.append(t);
  setTimeout(() => t.remove(), 4000);
}
function openModal(title, bodyNode) {
  const ov = html('<div class="modal-overlay"><div class="modal"><h3></h3><div class="modal-body"></div></div></div>');
  ov.querySelector('h3').textContent = title; ov.querySelector('.modal-body').append(bodyNode);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  document.body.append(ov);
  const first = ov.querySelector('input,select,textarea'); if (first) first.focus();
  return { close, el: ov };
}
function confirmDialog(message, okLabel = 'Remove') {
  return new Promise(resolve => {
    const body = html('<div><p></p><div class="modal-actions"><button class="btn" data-c>Cancel</button><button class="btn btn-danger" data-ok></button></div></div>');
    body.querySelector('p').textContent = message; body.querySelector('[data-ok]').textContent = okLabel;
    const m = openModal('Please confirm', body);
    body.querySelector('[data-c]').onclick = () => { m.close(); resolve(false); };
    body.querySelector('[data-ok]').onclick = () => { m.close(); resolve(true); };
  });
}
const PRIORITY_ICON = { Urgent: '🔴', High: '🟠', Medium: '🟡', Low: '🟢' };
