/* Sign Up + Sign In pages */
const msg = document.getElementById('formMessage');
const setMsg = (t, cls) => { msg.textContent = t; msg.className = 'msg ' + (cls || ''); };
const val = id => document.getElementById(id).value;

async function authRequest(endpoint, data) {
  // Use api helper which handles backend fetch with automatic localApi fallback
  if (typeof api === 'function') {
    return await api(endpoint, { json: data });
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'Unable to reach the sign-in service.');
  return result;
}

// already signed in? skip straight to the dashboard
(async () => {
  try {
    if (typeof api === 'function') {
      const { user } = await api('/api/auth/me');
      if (user) {
        location.href = 'dashboard.html';
        return;
      }
    } else {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (r.ok) {
        location.href = 'dashboard.html';
        return;
      }
    }
  } catch (_) {}
})();

const signupForm = document.getElementById('signupForm');
if (signupForm) signupForm.addEventListener('submit', async e => {
  e.preventDefault();
  setMsg('');
  const body = {
    fullName: val('fullName').trim(),
    username: val('username').trim(),
    email: val('email').trim(),
    password: val('password'),
    confirmPassword: val('confirmPassword')
  };

  if (!body.fullName || !body.username || !body.email || !body.password || !body.confirmPassword) {
    return setMsg('Please fill in every field.', 'err');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) {
    return setMsg('Invalid email address.', 'err');
  }
  if (body.password.length < 8) {
    return setMsg('Password is too short (minimum 8 characters).', 'err');
  }
  if (body.password !== body.confirmPassword) {
    return setMsg('Passwords do not match.', 'err');
  }

  const btn = document.getElementById('signupBtn');
  btn.disabled = true;

  try {
    // 1. Submit signup request to the portal backend (which stores in Firebase Auth + portal DB)
    const r = await authRequest('/api/auth/signup', body);

    // 2. Persist session locally so dashboard and local storage are instantly authenticated
    if (r.user && r.user.id) {
      localStorage.setItem('osp_session', String(r.user.id));
    }

    // 3. Ensure Firebase Auth client SDK is synced with username and full name
    const formattedDisplayName = typeof window.formatDisplayName === 'function'
      ? window.formatDisplayName(body.fullName, body.username)
      : `${body.fullName} (@${body.username})`;

    if (window.firebaseAuth && typeof window.firebaseAuth.createUserWithEmailAndPassword === 'function') {
      try {
        const cred = await window.firebaseAuth.createUserWithEmailAndPassword(body.email, body.password);
        if (cred && cred.user && cred.user.updateProfile) {
          await cred.user.updateProfile({ displayName: formattedDisplayName });
        }
      } catch (fbAuthErr) {
        if (fbAuthErr.code === 'auth/email-already-in-use') {
          try {
            const cred = await window.firebaseAuth.signInWithEmailAndPassword(body.email, body.password);
            if (cred && cred.user && cred.user.updateProfile) {
              await cred.user.updateProfile({ displayName: formattedDisplayName });
            }
          } catch (_) {}
        } else {
          console.warn('Firebase Auth client notice:', fbAuthErr.message);
        }
      }
    }

    // 4. Show success message and immediately enter homepage (dashboard.html)
    setMsg('Account created successfully! Redirecting to dashboard...', 'ok');
    location.href = r.redirect || 'dashboard.html';
  } catch (err) {
    setMsg(err.message, 'err');
    btn.disabled = false;
  }
});

const loginForm = document.getElementById('loginForm');
if (loginForm) loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  setMsg('');
  const body = {
    email: val('email').trim(),
    password: val('password'),
    code: (document.getElementById('totp') ? val('totp') : '').trim()
  };

  if (!body.email || !body.password) {
    return setMsg('Invalid email or password.', 'err');
  }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true;

  try {
    const r = await authRequest('/api/auth/login', body);
    if (r.needs2fa) {
      document.getElementById('totpRow').hidden = false;
      document.getElementById('totp').focus();
      setMsg('Enter the 6-digit code from your authenticator app.');
      btn.disabled = false;
      return;
    }

    // Save user session for client & offline continuity
    if (r.user && r.user.id) {
      localStorage.setItem('osp_session', String(r.user.id));
    }

    // Optional: Sync Firebase Auth session if initialized
    if (window.firebaseAuth && typeof window.firebaseAuth.signInWithEmailAndPassword === 'function') {
      try {
        await window.firebaseAuth.signInWithEmailAndPassword(body.email, body.password);
      } catch (fbAuthErr) {
        console.warn('Firebase Auth login notice:', fbAuthErr.message);
      }
    }

    location.href = r.redirect || 'dashboard.html';
  } catch (err) {
    setMsg(err.message, 'err');
    btn.disabled = false;
  }
});
