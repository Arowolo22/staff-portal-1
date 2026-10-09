/* Settings: account, profile picture, theme, password, 2FA, logout */
function showSection(name) {
  document.querySelectorAll('.settings-nav li[data-section]').forEach(li => li.classList.toggle('active', li.dataset.section === name));
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'panel-' + name);
}
document.querySelectorAll('.settings-nav li[data-section]').forEach(li => li.addEventListener('click', () => showSection(li.dataset.section)));

function fillAccount() {
  acctFullName.value = currentUser.full_name; acctUsername.value = currentUser.username;
  acctEmail.value = currentUser.email; acctDepartment.value = currentUser.department;
  document.querySelectorAll('.theme-list button').forEach(b => b.classList.toggle('active', b.dataset.theme === currentUser.theme));
  twoFaStatus.textContent = currentUser.totp_enabled ? '(On)' : '(Off)';
  renderUserChrome();
}

async function updateAccount(e) {
  e.preventDefault();
  try {
    const r = await api('/api/settings/account', { method: 'PUT', json: { fullName: acctFullName.value, username: acctUsername.value, email: acctEmail.value, department: acctDepartment.value } });
    currentUser = r.user; fillAccount(); toast(r.message);        // navbar email updates immediately
  } catch (err) { toast(err.message, 'err'); }
}

async function uploadProfilePicture() {
  const f = avatarInput.files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) { avatarInput.value = ''; return toast('Image must be 2 MB or smaller.', 'err'); }
  const fd = new FormData(); fd.append('avatar', f);
  try {
    const r = await api('/api/settings/profile-picture', { method: 'POST', body: fd });
    currentUser.avatarUrl = r.avatarUrl; renderUserChrome(); toast(r.message);
  } catch (err) { toast(err.message, 'err'); }
  avatarInput.value = '';
}

async function setTheme(theme) {
  try { await api('/api/settings/theme', { method: 'PUT', json: { theme } }); currentUser.theme = theme; applyTheme(theme); fillAccount(); toast('Theme saved.'); }
  catch (err) { toast(err.message, 'err'); }
}

function changePasswordModal() {
  const body = html(`<form novalidate><label>Current password</label><input type="password" name="cur" autocomplete="current-password">
    <label>New password</label><input type="password" name="new" autocomplete="new-password">
    <label>Confirm new password</label><input type="password" name="conf" autocomplete="new-password">
    <div class="err"></div><div class="modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn btn-primary">Change Password</button></div></form>`);
  const m = openModal('Change Password', body);
  body.querySelector('[data-c]').onclick = m.close;
  body.onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/api/settings/password', { method: 'PUT', json: { currentPassword: body.cur.value, newPassword: body.new.value, confirmPassword: body.conf.value } });
      m.close(); toast(r.message);
    } catch (err) { body.querySelector('.err').textContent = err.message; }
  };
}

async function twoFactorModal() {
  if (currentUser.totp_enabled) {
    const body = html(`<form novalidate><p style="font-size:13px">Two-factor authentication is <b>on</b>. To turn it off, confirm your password and a current code.</p>
      <label>Password</label><input type="password" name="pw" autocomplete="current-password"><label>Authenticator code</label><input name="code" inputmode="numeric" maxlength="6">
      <div class="err"></div><div class="modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn btn-danger">Disable 2FA</button></div></form>`);
    const m = openModal('Two-Factor Authentication', body); body.querySelector('[data-c]').onclick = m.close;
    body.onsubmit = async e => {
      e.preventDefault();
      try { const r = await api('/api/settings/2fa/disable', { json: { password: body.pw.value, code: body.code.value } }); currentUser.totp_enabled = false; fillAccount(); m.close(); toast(r.message); }
      catch (err) { body.querySelector('.err').textContent = err.message; }
    };
    return;
  }
  try {
    const s = await api('/api/settings/2fa/setup', { method: 'POST' });
    const body = html(`<form novalidate><p style="font-size:13px">In an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) choose “Enter a setup key”, type the key below (time-based), then enter the 6-digit code it shows.</p>
      <div style="text-align:center"><code style="font-size:15px;word-break:break-all">${escapeHtml(s.secret)}</code><br><small><a href="${escapeHtml(s.otpauth)}">Open in authenticator app</a> (mobile)</small></div>
      <label>Verification code</label><input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
      <div class="err"></div><div class="modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn btn-primary">Enable 2FA</button></div></form>`);
    const m = openModal('Enable Two-Factor Authentication', body); body.querySelector('[data-c]').onclick = m.close;
    body.onsubmit = async e => {
      e.preventDefault();
      try { const r = await api('/api/settings/2fa/enable', { json: { code: body.code.value } }); currentUser.totp_enabled = true; fillAccount(); m.close(); toast(r.message); }
      catch (err) { body.querySelector('.err').textContent = err.message; }
    };
  } catch (err) { toast(err.message, 'err'); }
}

(async () => {
  await initPage(); fillAccount();
  accountForm.addEventListener('submit', updateAccount);
  avatarInput.addEventListener('change', uploadProfilePicture);
  document.querySelectorAll('.theme-list button').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.theme)));
  changePasswordRow.addEventListener('click', changePasswordModal);
  twoFactorRow.addEventListener('click', twoFactorModal);
})();
