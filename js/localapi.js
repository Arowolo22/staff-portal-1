/* Browser-only "backend": same endpoints as the Express version, stored in localStorage (records)
   and IndexedDB (uploaded files). Nothing leaves the browser. */
(function () {
  const KEY = 'osp_db_v1', SESSION = 'osp_session';
  const err = (status, message) => Object.assign(new Error(message), { status });
  const fresh = () => ({
    users: [
      { id: 1, full_name: 'Admin User', username: 'admin', email: 'admin@olajide.com', password_hash: 'admin123', department: 'Management', profile_picture: null, theme: 'system', totp_secret: null, totp_enabled: false, created_at: now(), last_login: null, account_status: 'active' }
    ],
    projects: [
      { id: 1, name: 'Staff Portal Redesign', description: 'Modernize the employee portal with a clean dashboard, scheduling, project management, and support workflows.', created_by: 1, start_date: todayStr(), end_date: todayStr(), status: 'Active', created_at: now(), updated_at: now() }
    ],
    members: [
      { id: 1, project_id: 1, user_id: 1, added_by: 1, added_at: now() }
    ],
    files: [],
    schedules: [
      { id: 1, user_id: 1, name: 'Sprint Review', description: 'Review current sprint status and unblock team dependencies.', start_date: todayStr(), end_date: todayStr(), project_id: 1, priority: 'High', status: 'In Progress', created_at: now(), updated_at: now() }
    ],
    tickets: [],
    seq: 10
  });
  const load = () => {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.users) && d.users.length) return d;
      const f = fresh();
      localStorage.setItem(KEY, JSON.stringify(f));
      return f;
    } catch (e) {
      return fresh();
    }
  };
  const save = db => localStorage.setItem(KEY, JSON.stringify(db));
  const nid = db => ++db.seq;
  const pad = n => String(n).padStart(2, '0');
  const now = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const todayStr = () => now().slice(0, 10);
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, userRe = /^[A-Za-z0-9_.-]{3,30}$/;
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
  const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'], SCHED_STATUS = ['Pending', 'In Progress', 'Completed'], PROJECT_STATUS = ['Active', 'Completed', 'Archived'];
  const ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip'];
  const INLINE_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt'];
  const extOf = n => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i).toLowerCase(); };

  /* ---------- crypto: PBKDF2 password hashing + TOTP ---------- */
  const b64e = u8 => btoa(String.fromCharCode(...u8)), b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const needCrypto = () => { if (!window.crypto || !crypto.subtle) throw err(500, 'Secure hashing is unavailable. Open the site via http://localhost (e.g. VS Code Live Server), not by double-clicking the file.'); };
  async function hashPw(pw, salt) {
    needCrypto(); salt = salt || crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
    return b64e(salt) + ':' + b64e(new Uint8Array(bits));
  }
  const checkPw = async (pw, stored) => {
    if (!stored) return false;
    if (stored === pw) return true;
    try {
      const idx = stored.indexOf(':');
      if (idx !== -1) {
        return (await hashPw(pw, b64d(stored.slice(0, idx)))) === stored;
      }
    } catch (_) {}
    return stored === pw;
  };
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const b32enc = u8 => { let bits = '', out = ''; u8.forEach(b => bits += b.toString(2).padStart(8, '0')); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
  const b32dec = s => { let bits = ''; for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return new Uint8Array(o); };
  async function totpAt(secret, counter) {
    const key = await crypto.subtle.importKey('raw', b32dec(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const buf = new ArrayBuffer(8); new DataView(buf).setUint32(4, counter);
    const s = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf)); const o = s[19] & 15;
    return String((((s[o] & 0x7f) << 24) | (s[o + 1] << 16) | (s[o + 2] << 8) | s[o + 3]) % 1000000).padStart(6, '0');
  }
  async function verifyTotp(secret, token) {
    needCrypto(); const step = Math.floor(Date.now() / 30000);
    for (const d of [-1, 0, 1]) if ((await totpAt(secret, step + d)) === String(token).trim()) return true;
    return false;
  }

  /* ---------- IndexedDB for file contents ---------- */
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('osp_files', 1); r.onupgradeneeded = () => r.result.createObjectStore('blobs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbOp = async (mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('blobs', mode); const rq = fn(t.objectStore('blobs')); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); }); };
  const idbPut = (k, v) => idbOp('readwrite', s => s.put(v, k)), idbGet = k => idbOp('readonly', s => s.get(k)), idbDel = k => idbOp('readwrite', s => s.delete(k));

  /* ---------- shared logic ---------- */
  const publicUser = u => ({ id: u.id, full_name: u.full_name, username: u.username, email: u.email, department: u.department, theme: u.theme, totp_enabled: !!u.totp_enabled, avatarUrl: u.profile_picture || null });
  const authUser = db => { const id = +localStorage.getItem(SESSION) || 0; const u = db.users.find(x => x.id === id && x.account_status === 'active'); if (!u) throw err(401, 'Not authenticated.'); return u; };
  const projAccess = (db, uid, pid) => {
    const p = db.projects.find(x => x.id === pid);
    if (!p || !db.members.some(m => m.project_id === pid && m.user_id === uid)) throw err(403, 'You do not have permission to access this project.');
    return { p, isOwner: p.created_by === uid };
  };
  const ownerOnly = a => { if (!a.isOwner) throw err(403, 'Only the project creator can do this.'); };
  const userName = (db, id) => (db.users.find(u => u.id === id) || {}).full_name || '';
  const projectRow = (db, p, uid) => ({ id: p.id, name: p.name, description: p.description, start_date: p.start_date, end_date: p.end_date, status: p.status, created_at: p.created_at, created_by: p.created_by, owner_name: userName(db, p.created_by), member_count: db.members.filter(m => m.project_id === p.id).length, file_count: db.files.filter(f => f.project_id === p.id).length, is_owner: p.created_by === uid });
  const listProjects = (db, uid, activeOnly) => db.projects.filter(p => db.members.some(m => m.project_id === p.id && m.user_id === uid) && (!activeOnly || p.status === 'Active')).sort((a, b) => b.id - a.id).map(p => projectRow(db, p, uid));
  const getMembers = (db, pid) => { const p = db.projects.find(x => x.id === pid); return db.members.filter(m => m.project_id === pid).map(m => { const u = db.users.find(x => x.id === m.user_id); return { id: u.id, full_name: u.full_name, username: u.username, email: u.email, department: u.department, added_at: m.added_at, is_owner: u.id === p.created_by }; }).sort((a, b) => (b.is_owner - a.is_owner) || a.full_name.localeCompare(b.full_name)); };
  const getFiles = (db, pid) => db.files.filter(f => f.project_id === pid).sort((a, b) => b.id - a.id).map(f => ({ id: f.id, original_filename: f.original_filename, file_size: f.file_size, mime_type: f.mime_type, uploaded_at: f.uploaded_at, uploaded_by: f.uploaded_by, uploaded_by_name: userName(db, f.uploaded_by) }));
  const schedRow = (db, s) => ({ ...s, project_name: s.project_id ? (db.projects.find(p => p.id === s.project_id) || {}).name || null : null });
  function validateSchedule(db, uid, b) {
    const name = clean(b.name, 150), description = clean(b.description, 5000), priority = b.priority || 'Medium', status = b.status || 'Pending';
    if (!name) throw err(400, 'Schedule name is required.');
    if (!isDate(b.startDate) || !isDate(b.endDate)) throw err(400, 'Valid start and end dates are required.');
    if (b.endDate < b.startDate) throw err(400, 'End date cannot be before start date.');
    if (!PRIORITIES.includes(priority)) throw err(400, 'Invalid priority.');
    if (!SCHED_STATUS.includes(status)) throw err(400, 'Invalid status.');
    let projectId = null;
    if (b.projectId !== null && b.projectId !== undefined && b.projectId !== '') {
      projectId = parseInt(b.projectId, 10);
      if (!db.members.some(m => m.project_id === projectId && m.user_id === uid)) throw err(400, 'You do not have permission to use that project.');
    }
    return { name, description, start_date: b.startDate, end_date: b.endDate, project_id: projectId, priority, status };
  }
  function resizeImage(file, max = 256) {
    return new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res(c.toDataURL('image/jpeg', 0.85)); };
      img.onerror = () => rej(err(400, 'File is not a valid image.')); img.src = u;
    });
  }

  /* ---------- routes ---------- */
  const routes = [];
  const R = (m, re, fn) => routes.push([m, new RegExp('^/api/' + re + '/?$'), fn]);

  R('POST', 'auth/signup', async ({ body: b }) => {
    const db = load();
    const fullName = clean(b.fullName, 100), username = clean(b.username, 30), email = clean(b.email, 150).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '', confirm = typeof b.confirmPassword === 'string' ? b.confirmPassword : '';
    if (fullName.length < 2) throw err(400, 'Full name is required.');
    if (!userRe.test(username)) throw err(400, 'Username must be 3-30 characters (letters, numbers, . _ -).');
    if (!emailRe.test(email)) throw err(400, 'Invalid email address.');
    if (password.length < 8) throw err(400, 'Password is too short (minimum 8 characters).');
    if (password !== confirm) throw err(400, 'Passwords do not match.');
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw err(409, 'Username already exists.');
    if (db.users.some(u => u.email === email)) throw err(409, 'Email already exists.');

    // Save user to Firebase Authentication
    let fbUid = null;
    if (typeof window !== 'undefined' && typeof window.signUpWithFirebaseAuth === 'function') {
      try {
        const fbRes = await window.signUpWithFirebaseAuth({
          email,
          password,
          displayName: typeof window.formatDisplayName === 'function' ? window.formatDisplayName(fullName, username) : `${fullName} (@${username})`,
        });
        if (fbRes && fbRes.uid) fbUid = fbRes.uid;
      } catch (fbErr) {
        if (fbErr.message && fbErr.message.includes('already exists')) {
          throw err(409, fbErr.message);
        }
        console.warn('Firebase Auth signup warning in localapi:', fbErr.message);
      }
    }

    const hash = await hashPw(password);
    const fresh2 = load();   // re-read in case another tab wrote while hashing
    if (fresh2.users.some(u => u.email === email || u.username.toLowerCase() === username.toLowerCase())) throw err(409, 'Username or email already exists.');
    const newUser = {
      id: nid(fresh2),
      firebase_uid: fbUid,
      full_name: fullName,
      username,
      email,
      password_hash: hash,
      department: 'Not set',
      profile_picture: null,
      theme: 'system',
      totp_secret: null,
      totp_enabled: false,
      created_at: now(),
      last_login: now(),
      account_status: 'active'
    };
    fresh2.users.push(newUser);
    save(fresh2);

    // Auto-login session immediately upon signup
    localStorage.setItem(SESSION, String(newUser.id));

    return {
      ok: true,
      message: 'Account created successfully! Logging you in...',
      redirect: 'dashboard.html',
      user: publicUser(newUser)
    };
  });
  R('POST', 'auth/login', async ({ body: b }) => {
    const db = load(), email = clean(b.email, 150).toLowerCase(), u = db.users.find(x => x.email === email);
    const ok = u ? await checkPw(typeof b.password === 'string' ? b.password : '', u.password_hash) : (await hashPw('x'), false);
    if (!u || !ok || u.account_status !== 'active') throw err(401, 'Invalid email or password.');
    if (u.totp_enabled) {
      if (!clean(b.code, 10)) return { needs2fa: true };
      if (!(await verifyTotp(u.totp_secret, clean(b.code, 10)))) throw err(401, 'Invalid verification code.');
    }
    u.last_login = now(); save(db); localStorage.setItem(SESSION, String(u.id));
    return { ok: true, redirect: 'dashboard.html', user: publicUser(u) };
  });
  R('POST', 'auth/logout', async () => { localStorage.removeItem(SESSION); sessionStorage.removeItem('osp_pending2fa'); return { ok: true }; });
  R('GET', 'auth/me', async () => ({ user: publicUser(authUser(load())) }));

  R('GET', 'users/search', async ({ q }) => {
    const db = load(), me = authUser(db), s = clean(q.q, 50).toLowerCase(), pid = parseInt(q.projectId, 10) || 0;
    if (s.length < 2) return { users: [] };
    return { users: db.users.filter(u => u.account_status === 'active' && u.id !== me.id && [u.username, u.email, u.full_name].some(v => v.toLowerCase().includes(s))).slice(0, 10)
      .map(u => ({ id: u.id, full_name: u.full_name, username: u.username, email: u.email, department: u.department, is_member: db.members.some(m => m.project_id === pid && m.user_id === u.id) })) };
  });

  const updateAccount = async ({ body: b }) => {
    const db = load(), me = authUser(db);
    const fullName = clean(b.fullName, 100), username = clean(b.username, 30), email = clean(b.email, 150).toLowerCase(), department = clean(b.department, 100) || 'Not set';
    if (fullName.length < 2) throw err(400, 'Full name is required.');
    if (!userRe.test(username)) throw err(400, 'Username must be 3-30 characters (letters, numbers, . _ -).');
    if (!emailRe.test(email)) throw err(400, 'Invalid email address.');
    if (db.users.some(u => u.id !== me.id && u.username.toLowerCase() === username.toLowerCase())) throw err(409, 'Username already exists.');
    if (db.users.some(u => u.id !== me.id && u.email === email)) throw err(409, 'Email already exists.');
    Object.assign(me, { full_name: fullName, username, email, department }); save(db);
    return { message: 'Account updated successfully.', user: publicUser(me) };
  };
  const setAvatar = async ({ body }) => {
    const db = load(), me = authUser(db), f = body instanceof FormData ? body.get('avatar') : null;
    if (!f || !f.size) throw err(400, 'No image selected.');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) throw err(400, 'Only PNG, JPG or WEBP images are allowed.');
    if (f.size > 2 * 1024 * 1024) throw err(400, 'File is too large.');
    me.profile_picture = await resizeImage(f); save(db);
    return { message: 'Profile picture updated.', avatarUrl: me.profile_picture };
  };
  R('PUT', 'users/profile', updateAccount); R('PUT', 'settings/account', updateAccount);
  R('POST', 'users/profile-picture', setAvatar); R('POST', 'settings/profile-picture', setAvatar);

  R('PUT', 'settings/theme', async ({ body: b }) => {
    const db = load(), me = authUser(db);
    if (!['light', 'dark', 'system'].includes(b.theme)) throw err(400, 'Invalid theme.');
    me.theme = b.theme; save(db); return { message: 'Theme saved.', theme: b.theme };
  });
  R('PUT', 'settings/password', async ({ body: b }) => {
    const db = load(), me = authUser(db);
    if (typeof b.currentPassword !== 'string' || typeof b.newPassword !== 'string') throw err(400, 'All fields are required.');
    if (b.newPassword.length < 8) throw err(400, 'New password is too short (minimum 8 characters).');
    if (b.newPassword !== b.confirmPassword) throw err(400, 'Passwords do not match.');
    if (!(await checkPw(b.currentPassword, me.password_hash))) throw err(400, 'Current password is incorrect.');
    me.password_hash = await hashPw(b.newPassword); save(db); return { message: 'Password changed successfully.' };
  });
  R('POST', 'settings/2fa/setup', async () => {
    const db = load(), me = authUser(db); needCrypto();
    if (me.totp_enabled) throw err(400, 'Two-factor authentication is already enabled.');
    const secret = b32enc(crypto.getRandomValues(new Uint8Array(20)));
    sessionStorage.setItem('osp_pending2fa', secret);
    return { secret, otpauth: `otpauth://totp/Olajide%20Staff%20Portal:${encodeURIComponent(me.email)}?secret=${secret}&issuer=Olajide%20Staff%20Portal` };
  });
  R('POST', 'settings/2fa/enable', async ({ body: b }) => {
    const db = load(), me = authUser(db), secret = sessionStorage.getItem('osp_pending2fa');
    if (!secret) throw err(400, 'Start setup first.');
    if (!(await verifyTotp(secret, clean(b.code, 10)))) throw err(400, 'Invalid verification code.');
    me.totp_secret = secret; me.totp_enabled = true; save(db); sessionStorage.removeItem('osp_pending2fa');
    return { message: 'Two-factor authentication enabled.' };
  });
  R('POST', 'settings/2fa/disable', async ({ body: b }) => {
    const db = load(), me = authUser(db);
    if (!me.totp_enabled) throw err(400, 'Two-factor authentication is not enabled.');
    if (typeof b.password !== 'string' || !(await checkPw(b.password, me.password_hash))) throw err(400, 'Password is incorrect.');
    if (!(await verifyTotp(me.totp_secret, clean(b.code, 10)))) throw err(400, 'Invalid verification code.');
    me.totp_secret = null; me.totp_enabled = false; save(db); return { message: 'Two-factor authentication disabled.' };
  });

  /* projects */
  R('GET', 'projects', async () => { const db = load(); return { projects: listProjects(db, authUser(db).id, false) }; });
  R('POST', 'projects', async ({ body: b }) => {
    const db = load(), me = authUser(db), name = clean(b.name, 150), description = clean(b.description, 5000), start = b.startDate || null, end = b.endDate || null;
    if (!name) throw err(400, 'Project name is required.');
    if (!description) throw err(400, 'Project description is required.');
    if ((start && !isDate(start)) || (end && !isDate(end))) throw err(400, 'Invalid date.');
    if (start && end && end < start) throw err(400, 'End date cannot be before start date.');
    const id = nid(db);
    db.projects.push({ id, name, description, created_by: me.id, start_date: start, end_date: end, status: 'Active', created_at: now(), updated_at: now() });
    db.members.push({ id: nid(db), project_id: id, user_id: me.id, added_by: me.id, added_at: now() });   // creator is a member
    save(db); return { message: 'Project created successfully.', id };
  });
  R('GET', 'projects/(\\d+)', async ({ a }) => { const db = load(), me = authUser(db), x = projAccess(db, me.id, +a[0]); return { project: { ...x.p, owner_name: userName(db, x.p.created_by) }, members: getMembers(db, x.p.id), files: getFiles(db, x.p.id), isOwner: x.isOwner, currentUserId: me.id }; });
  R('PUT', 'projects/(\\d+)', async ({ a, body: b }) => {
    const db = load(), me = authUser(db), x = projAccess(db, me.id, +a[0]); ownerOnly(x); const p = x.p;
    const name = b.name !== undefined ? clean(b.name, 150) : p.name, description = b.description !== undefined ? clean(b.description, 5000) : p.description;
    const start = b.startDate !== undefined ? (b.startDate || null) : p.start_date, end = b.endDate !== undefined ? (b.endDate || null) : p.end_date, status = b.status !== undefined ? b.status : p.status;
    if (!name) throw err(400, 'Project name is required.');
    if (!PROJECT_STATUS.includes(status)) throw err(400, 'Invalid status.');
    if ((start && !isDate(start)) || (end && !isDate(end))) throw err(400, 'Invalid date.');
    if (start && end && end < start) throw err(400, 'End date cannot be before start date.');
    Object.assign(p, { name, description, start_date: start, end_date: end, status, updated_at: now() }); save(db); return { message: 'Project updated successfully.' };
  });
  R('DELETE', 'projects/(\\d+)', async ({ a }) => {
    const db = load(), me = authUser(db), x = projAccess(db, me.id, +a[0]); ownerOnly(x);
    const gone = db.files.filter(f => f.project_id === x.p.id);
    db.files = db.files.filter(f => f.project_id !== x.p.id); db.members = db.members.filter(m => m.project_id !== x.p.id);
    db.schedules.forEach(s => { if (s.project_id === x.p.id) s.project_id = null; });
    db.projects = db.projects.filter(p => p.id !== x.p.id); save(db);
    await Promise.all(gone.map(f => idbDel(f.id))); return { message: 'Project deleted.' };
  });
  R('GET', 'projects/(\\d+)/members', async ({ a }) => { const db = load(); projAccess(db, authUser(db).id, +a[0]); return { members: getMembers(db, +a[0]) }; });
  R('POST', 'projects/(\\d+)/members', async ({ a, body: b }) => {
    const db = load(), me = authUser(db), x = projAccess(db, me.id, +a[0]); ownerOnly(x);
    const uid = parseInt(b.userId, 10), u = db.users.find(z => z.id === uid && z.account_status === 'active');
    if (!u) throw err(404, 'User does not exist.');
    if (db.members.some(m => m.project_id === x.p.id && m.user_id === uid)) throw err(409, 'User is already a member of this project.');
    db.members.push({ id: nid(db), project_id: x.p.id, user_id: uid, added_by: me.id, added_at: now() }); save(db);
    return { message: `${u.full_name} was added to the project.`, members: getMembers(db, x.p.id) };
  });
  R('DELETE', 'projects/(\\d+)/members/(\\d+)', async ({ a }) => {
    const db = load(), me = authUser(db), x = projAccess(db, me.id, +a[0]); ownerOnly(x);
    if (+a[1] === x.p.created_by) throw err(400, 'The project creator cannot be removed.');
    const n = db.members.length; db.members = db.members.filter(m => !(m.project_id === x.p.id && m.user_id === +a[1]));
    if (db.members.length === n) throw err(404, 'Member not found.'); save(db);
    return { message: 'Member removed.', members: getMembers(db, x.p.id) };
  });
  R('GET', 'projects/(\\d+)/files', async ({ a }) => { const db = load(); projAccess(db, authUser(db).id, +a[0]); return { files: getFiles(db, +a[0]) }; });
  R('POST', 'projects/(\\d+)/files', async ({ a, body }) => {
    const db = load(), me = authUser(db), x = projAccess(db, me.id, +a[0]);
    const list = body instanceof FormData ? body.getAll('files').filter(f => f && f.size !== undefined) : [];
    if (!list.length) throw err(400, 'No files selected.');
    if (list.length > 10) throw err(400, 'You can upload up to 10 files at a time.');
    for (const f of list) {
      if (!ALLOWED_EXT.includes(extOf(f.name))) throw err(400, `File type "${extOf(f.name) || 'unknown'}" is not allowed.`);
      if (f.size > 10 * 1024 * 1024) throw err(400, `${f.name} is too large (max 10 MB).`);
    }
    for (const f of list) {
      const id = nid(db);
      await idbPut(id, f);
      db.files.push({ id, project_id: x.p.id, uploaded_by: me.id, original_filename: f.name.replace(/[\\/]/g, '_').slice(0, 255), stored_filename: 'idb:' + id, file_path: 'indexeddb/osp_files/' + id, file_size: f.size, mime_type: f.type || 'application/octet-stream', uploaded_at: now() });
    }
    save(db); return { message: list.length > 1 ? 'Files uploaded successfully.' : 'File uploaded successfully.', files: getFiles(db, x.p.id) };
  });
  R('DELETE', 'projects/(\\d+)/files/(\\d+)', async ({ a }) => {
    const db = load(), me = authUser(db), x = projAccess(db, me.id, +a[0]), f = db.files.find(z => z.id === +a[1] && z.project_id === x.p.id);
    if (!f) throw err(404, 'File not found.');
    if (!x.isOwner && f.uploaded_by !== me.id) throw err(403, 'You do not have permission to remove this file.');
    db.files = db.files.filter(z => z.id !== f.id); save(db); await idbDel(f.id);
    return { message: 'File removed successfully.', files: getFiles(db, x.p.id) };
  });

  /* schedules */
  R('GET', 'schedules', async ({ q }) => {
    const db = load(), me = authUser(db); let list = db.schedules.filter(s => s.user_id === me.id);
    if (isDate(q.from) && isDate(q.to)) list = list.filter(s => s.start_date <= q.to && s.end_date >= q.from);
    return { schedules: list.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id).map(s => schedRow(db, s)) };
  });
  R('POST', 'schedules', async ({ body: b }) => {
    const db = load(), me = authUser(db), v = validateSchedule(db, me.id, b), id = nid(db);
    db.schedules.push({ id, user_id: me.id, ...v, created_at: now(), updated_at: now() }); save(db); return { message: 'Schedule created successfully.', id };
  });
  const ownSched = (db, me, id) => { const s = db.schedules.find(x => x.id === +id && x.user_id === me.id); if (!s) throw err(404, 'Schedule not found.'); return s; };
  R('GET', 'schedules/(\\d+)', async ({ a }) => { const db = load(), me = authUser(db); return { schedule: schedRow(db, ownSched(db, me, a[0])) }; });
  R('PUT', 'schedules/(\\d+)', async ({ a, body: b }) => { const db = load(), me = authUser(db), s = ownSched(db, me, a[0]); Object.assign(s, validateSchedule(db, me.id, b), { updated_at: now() }); save(db); return { message: 'Schedule updated successfully.' }; });
  R('DELETE', 'schedules/(\\d+)', async ({ a }) => { const db = load(), me = authUser(db), s = ownSched(db, me, a[0]); db.schedules = db.schedules.filter(x => x !== s); save(db); return { message: 'Schedule deleted.' }; });

  /* dashboard */
  R('GET', 'dashboard', async () => {
    const db = load(), me = authUser(db), today = todayStr(), cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10), rank = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
    const schedules = db.schedules.filter(s => s.user_id === me.id && s.status !== 'Completed' && s.end_date >= cutoff).map(s => {
      const overdue = s.end_date < today, active = !overdue && s.start_date <= today;
      return { ...schedRow(db, s), state: overdue ? 'overdue' : active ? 'active' : 'upcoming', days_until: overdue || active ? 0 : dayDiff(today, s.start_date) };
    }).sort((a, b) => (a.state === 'overdue' ? 0 : 1) - (b.state === 'overdue' ? 0 : 1) || rank[a.priority] - rank[b.priority] || a.days_until - b.days_until || a.start_date.localeCompare(b.start_date)).slice(0, 10);
    return { projects: listProjects(db, me.id, true), schedules };
  });

  /* support */
  R('GET', 'support/tickets', async () => { const db = load(), me = authUser(db); return { tickets: db.tickets.filter(t => t.user_id === me.id).sort((a, b) => b.id - a.id) }; });
  R('POST', 'support/tickets', async ({ body: b }) => {
    const db = load(), me = authUser(db), subject = clean(b.subject, 200), description = clean(b.description, 5000), priority = b.priority || 'Medium';
    if (!subject) throw err(400, 'Subject is required.'); if (!description) throw err(400, 'Description is required.'); if (!PRIORITIES.includes(priority)) throw err(400, 'Invalid priority.');
    const id = nid(db); db.tickets.push({ id, user_id: me.id, subject, description, priority, status: 'Open', created_at: now(), updated_at: now() }); save(db); return { message: 'Support request submitted.', id };
  });
  R('PUT', 'support/tickets/(\\d+)', async ({ a, body: b }) => {
    const db = load(), me = authUser(db), t = db.tickets.find(x => x.id === +a[0] && x.user_id === me.id);
    if (!t) throw err(404, 'Ticket not found.');
    const status = b.status !== undefined ? b.status : t.status;
    if (!['Open', 'Closed'].includes(status) && status !== t.status) throw err(400, 'Invalid status.');
    if (t.status === 'Open') { if (b.subject !== undefined) t.subject = clean(b.subject, 200) || t.subject; if (b.description !== undefined) t.description = clean(b.description, 5000) || t.description; if (PRIORITIES.includes(b.priority)) t.priority = b.priority; }
    t.status = status; t.updated_at = now(); save(db); return { message: 'Ticket updated.' };
  });

  /* ---------- entry point used by common.js ---------- */
  window.localApi = async function (url, opts = {}) {
    const hasJson = opts.json !== undefined;
    const method = (opts.method || (hasJson ? 'POST' : 'GET')).toUpperCase();
    const u = new URL(url, location.href), path = u.pathname.replace(/^.*?(\/api\/)/, '/api/');
    const body = hasJson ? opts.json : (opts.body instanceof FormData ? opts.body : {});
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const x = re.exec(path);
      if (x) return fn({ q: Object.fromEntries(u.searchParams), body: body || {}, a: x.slice(1) });
    }
    throw err(404, 'Not found.');
  };

  /* open / download a stored file (replaces the server download endpoint) */
  window.openLocalFile = async function (projectId, fileId, inline) {
    const w = inline ? window.open('', '_blank') : null;
    try {
      const db = load(), me = authUser(db), x = projAccess(db, me.id, +projectId), f = db.files.find(z => z.id === +fileId && z.project_id === x.p.id);
      if (!f) throw err(404, 'File not found.');
      const blob = await idbGet(f.id); if (!blob) throw err(404, 'File data is missing in this browser.');
      const url = URL.createObjectURL(blob);
      if (inline && INLINE_EXT.includes(extOf(f.original_filename))) { w.location = url; }
      else { if (w) w.close(); const a = document.createElement('a'); a.href = url; a.download = f.original_filename; document.body.append(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { if (w) w.close(); toast(e.message, 'err'); }
  };
})();
