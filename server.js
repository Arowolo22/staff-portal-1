const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  firebaseConfig,
  formatDisplayName,
  parseDisplayName,
  signUpWithFirebaseAuth,
  signInWithFirebaseAuth,
  updateFirebaseAuthProfile,
  getFirebaseUserData,
} = require('./firebase/firebase.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const projectRoot = __dirname;
const DEFAULT_DB = {
  users: [],
  projects: [],
  members: [],
  files: [],
  schedules: [],
  tickets: [],
  seq: 1,
};

const authCookieName = 'osp_session';
const state = {
  memoryDb: JSON.parse(JSON.stringify(DEFAULT_DB)),
  fileData: {},
  sessions: {},
  pending2fa: {},
};
const upload = multer({ storage: multer.memoryStorage() });

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('base64');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const idx = storedHash.indexOf(':');
  if (idx === -1) return storedHash === password;
  const salt = storedHash.slice(0, idx);
  const hash = storedHash.slice(idx + 1);
  const candidate = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(candidate));
}

function success(message, extra = {}) {
  return { message, ...extra };
}

function error(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isValidDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
function sanitizeText(v, max = 255) {
  return String(v ?? '').trim().slice(0, max);
}

function sessionUserId(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${authCookieName}=`));
  const token = match ? match.split('=')[1] : null;
  return token ? state.sessions[token] || null : null;
}

function withSession(req, res, handler) {
  const userId = sessionUserId(req);
  if (!userId) {
    throw error(401, 'Not authenticated.');
  }
  return handler(userId);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    full_name: user.full_name,
    username: user.username,
    email: user.email,
    department: user.department,
    theme: user.theme,
    totp_enabled: !!user.totp_enabled,
    avatarUrl: user.profile_picture || null,
  };
}

function nextId(db) {
  const next = db.seq || 1;
  db.seq = next + 1;
  return next;
}

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const segment = bits.slice(i, i + 5).padEnd(5, '0');
    output += alphabet[parseInt(segment, 2)];
  }
  return output;
}

function totpCode(secret, time = Date.now()) {
  const key = Buffer.from(secret, 'utf8');
  const counter = Math.floor(time / 30000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(0, 0);
  buffer.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  const normalized = String(code).trim();
  const now = Date.now();
  for (let i = -1; i <= 1; i += 1) {
    if (totpCode(secret, now + i * 30000) === normalized) return true;
  }
  return false;
}

function getUserById(db, id) {
  return db.users.find((user) => user.id === id);
}

function getUserByEmail(db, email) {
  return db.users.find((user) => user.email.toLowerCase() === String(email).toLowerCase());
}

function userNameLookup(db, userId) {
  const user = getUserById(db, userId);
  return user ? user.full_name : '';
}

function listProjects(db, uid) {
  return db.projects
    .filter((project) => db.members.some((member) => member.project_id === project.id && member.user_id === uid))
    .sort((a, b) => b.id - a.id)
    .map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      start_date: project.start_date,
      end_date: project.end_date,
      status: project.status,
      created_at: project.created_at,
      created_by: project.created_by,
      owner_name: userNameLookup(db, project.created_by),
      member_count: db.members.filter((m) => m.project_id === project.id).length,
      file_count: db.files.filter((file) => file.project_id === project.id).length,
      is_owner: project.created_by === uid,
    }));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.path === '/service-account.json') return res.sendStatus(404);
  next();
});
app.use(express.static(projectRoot));

/* ---------- Firebase Authentication & Local Data Persistence ---------- */
console.log('Firebase Authentication initialized via Google Identity Toolkit REST API (API key configured).');

const cachePath = path.join(projectRoot, 'data', 'osp-state.json');

async function loadDatabase() {
  if (state.memoryDb && Array.isArray(state.memoryDb.users) && state.memoryDb.users.length) {
    return state.memoryDb;
  }

  // Read from local disk cache if exists
  if (fs.existsSync(cachePath)) {
    try {
      const diskData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (diskData && Array.isArray(diskData.users) && diskData.users.length) {
        state.memoryDb = diskData;
        return state.memoryDb;
      }
    } catch (e) {
      console.warn('Unable to read state from disk cache:', e.message);
    }
  }

  return state.memoryDb;
}

async function saveDatabase(dbSnapshot) {
  state.memoryDb = JSON.parse(JSON.stringify(dbSnapshot));

  // Save to local disk cache for fast offline access and persistent storage
  try {
    const dataDir = path.dirname(cachePath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(dbSnapshot, null, 2), 'utf8');
  } catch (diskErr) {
    console.warn('Disk write notice:', diskErr.message);
  }
}

async function ensureDefaultUser() {
  const db = await loadDatabase();
  if (!db.users || !db.users.length) {
    const user = {
      id: 1,
      full_name: 'Admin User',
      username: 'admin',
      email: 'admin@olajide.com',
      password_hash: hashPassword('admin123'),
      department: 'Management',
      profile_picture: null,
      theme: 'system',
      totp_secret: null,
      totp_enabled: false,
      created_at: new Date().toISOString(),
      last_login: null,
      account_status: 'active',
    };
    db.users = [user];
    db.seq = 2;
    await saveDatabase(db);
    console.log('Default admin user ready. Email: admin@olajide.com / Password: admin123');
  }
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

/* ---------- Authentication & User Endpoints ---------- */
app.get('/api/health', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    res.json({
      ok: true,
      auth: 'Firebase Authentication (Google Identity Toolkit)',
      database: 'Local persistent store (data/osp-state.json)',
      userCount: (db.users || []).length,
    });
  } catch (err) { next(err); }
});

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const fullName = sanitizeText(req.body.fullName, 100);
    const username = sanitizeText(req.body.username, 30).replace(/[^A-Za-z0-9_.-]/g, '');
    const email = sanitizeText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirmPassword || '');

    if (!fullName || fullName.length < 2) throw error(400, 'Full name is required.');
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw error(400, 'Username must be 3-30 characters (letters, numbers, . _ -).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw error(400, 'Invalid email address.');
    if (password.length < 8) throw error(400, 'Password is too short (minimum 8 characters).');
    if (password !== confirm) throw error(400, 'Passwords do not match.');
    if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw error(409, 'Username already exists.');
    if (db.users.some((user) => user.email.toLowerCase() === email)) throw error(409, 'Email already exists.');

    // Save user directly to Firebase Authentication
    let firebaseUid = null;
    try {
      const fbResult = await signUpWithFirebaseAuth({
        email,
        password,
        displayName: formatDisplayName(fullName, username),
      });
      firebaseUid = fbResult.uid;
      console.log(`[Firebase Auth] New user registered: ${email} (UID: ${firebaseUid})`);
    } catch (fbErr) {
      console.warn('[Firebase Auth] Notice during signup:', fbErr.message);
      if (fbErr.message && fbErr.message.includes('already exists')) {
        throw error(409, fbErr.message);
      }
      if (fbErr.message && (fbErr.message.includes('Password') || fbErr.message.includes('email'))) {
        throw error(400, fbErr.message);
      }
    }

    const user = {
      id: nextId(db),
      firebase_uid: firebaseUid,
      full_name: fullName,
      username,
      email,
      password_hash: hashPassword(password),
      department: 'Not set',
      profile_picture: null,
      theme: 'system',
      totp_secret: null,
      totp_enabled: false,
      created_at: new Date().toISOString(),
      last_login: new Date().toISOString(),
      account_status: 'active',
    };
    db.users.push(user);

    // Auto-login session immediately upon signup
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.sessions[token] = user.id;
    res.cookie(authCookieName, token, { httpOnly: true, sameSite: 'lax', secure: false });

    await saveDatabase(db);

    res.json({
      ok: true,
      message: 'Account created successfully! Logging you in...',
      redirect: 'dashboard.html',
      token,
      user: publicUser(user),
    });
  } catch (err) { next(err); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const email = sanitizeText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) throw error(400, 'Email and password are required.');

    let authenticated = false;
    let user = db.users.find((item) => item.email.toLowerCase() === email && item.account_status === 'active');

    // 1. Authenticate with Firebase Authentication
    try {
      const fbUser = await signInWithFirebaseAuth({ email, password });
      if (fbUser && fbUser.uid) {
        authenticated = true;
        if (!user) {
          // If user was created in Firebase Auth but not yet in local cache
          const { fullName, username } = parseDisplayName(fbUser.displayName);
          user = {
            id: nextId(db),
            firebase_uid: fbUser.uid,
            full_name: fullName || 'Staff Member',
            username: username || email.split('@')[0],
            email,
            password_hash: hashPassword(password),
            department: 'Not set',
            profile_picture: null,
            theme: 'system',
            totp_secret: null,
            totp_enabled: false,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            account_status: 'active',
          };
          db.users.push(user);
        } else {
          user.firebase_uid = fbUser.uid;
        }
      }
    } catch (fbErr) {
      console.warn('[Firebase Auth] Login attempt notice:', fbErr.message);
      // Fallback: check local user password hash (e.g. admin user or offline accounts)
      if (user && verifyPassword(password, user.password_hash)) {
        authenticated = true;
      } else {
        throw error(401, 'Invalid email or password.');
      }
    }

    if (!authenticated || !user) {
      throw error(401, 'Invalid email or password.');
    }

    if (user.totp_enabled) {
      const code = sanitizeText(req.body.code || '', 10);
      if (!code) {
        return res.json({ needs2fa: true });
      }
      if (!verifyTotp(user.totp_secret, code)) {
        throw error(401, 'Invalid authenticator code.');
      }
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.sessions[token] = user.id;
    res.cookie(authCookieName, token, { httpOnly: true, sameSite: 'lax', secure: false });
    user.last_login = new Date().toISOString();
    await saveDatabase(db);
    res.json({ ok: true, redirect: 'dashboard.html', token, user: publicUser(user) });
  } catch (err) { next(err); }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${authCookieName}=`));
  if (token) {
    const sid = token.split('=')[1];
    delete state.sessions[sid];
    if (state.pending2fa[sid]) delete state.pending2fa[sid];
  }
  res.clearCookie(authCookieName);
  res.json({ ok: true });
});

app.get('/api/users/search', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const query = sanitizeText(req.query.q || '', 50).toLowerCase();
    const projectId = Number(req.query.projectId || 0);
    if (query.length < 2) return res.json({ users: [] });
    const users = db.users
      .filter((user) => user.account_status === 'active' && user.id !== userId && [user.username, user.email, user.full_name].some((value) => String(value).toLowerCase().includes(query)))
      .slice(0, 10)
      .map((user) => ({
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        email: user.email,
        department: user.department,
        is_member: db.members.some((member) => member.project_id === projectId && member.user_id === user.id),
      }));
    res.json({ users });
  } catch (err) { next(err); }
});

app.get('/api/auth/me', async (req, res, next) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) throw error(401, 'Not authenticated.');
    const db = await loadDatabase();
    const user = getUserById(db, userId);
    if (!user || user.account_status !== 'active') throw error(401, 'Not authenticated.');
    res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

/* ---------- Dashboard Endpoints ---------- */
app.get('/api/dashboard', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const today = new Date().toISOString().slice(0, 10);
    const schedules = db.schedules
      .filter((entry) => entry.user_id === userId && entry.status !== 'Completed' && entry.end_date >= today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .slice(0, 10)
      .map((entry) => ({
        ...entry,
        project_name: entry.project_id ? (db.projects.find((project) => project.id === entry.project_id)?.name || null) : null,
      }));
    res.json({ projects: listProjects(db, userId), schedules });
  } catch (err) { next(err); }
});

/* ---------- Projects Endpoints ---------- */
app.get('/api/projects', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    res.json({ projects: listProjects(db, userId) });
  } catch (err) { next(err); }
});

app.post('/api/projects', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const name = sanitizeText(req.body.name, 150);
    const description = sanitizeText(req.body.description, 5000);
    const startDate = req.body.startDate || null;
    const endDate = req.body.endDate || null;
    if (!name) throw error(400, 'Project name is required.');
    if (!description) throw error(400, 'Project description is required.');
    if (startDate && !isValidDate(startDate)) throw error(400, 'Invalid date.');
    if (endDate && !isValidDate(endDate)) throw error(400, 'Invalid date.');
    if (startDate && endDate && endDate < startDate) throw error(400, 'End date cannot be before start date.');

    const project = {
      id: nextId(db),
      name,
      description,
      created_by: userId,
      start_date: startDate,
      end_date: endDate,
      status: 'Active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.projects.push(project);
    db.members.push({ id: nextId(db), project_id: project.id, user_id: userId, added_by: userId, added_at: new Date().toISOString() });
    await saveDatabase(db);
    res.json(success('Project created successfully.', { id: project.id }));
  } catch (err) { next(err); }
});

app.get('/api/projects/:id', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (!db.members.some((member) => member.project_id === projectId && member.user_id === userId)) throw error(403, 'You do not have permission to access this project.');
    const members = db.members
      .filter((member) => member.project_id === projectId)
      .map((member) => {
        const user = getUserById(db, member.user_id);
        return { id: user.id, full_name: user.full_name, username: user.username, email: user.email, department: user.department, added_at: member.added_at, is_owner: user.id === project.created_by };
      });
    res.json({ project: { ...project, owner_name: userNameLookup(db, project.created_by) }, members, files: db.files.filter((file) => file.project_id === projectId), isOwner: project.created_by === userId, currentUserId: userId });
  } catch (err) { next(err); }
});

app.put('/api/projects/:id', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (project.created_by !== userId) throw error(403, 'Only the project creator can edit this project.');

    const name = sanitizeText(req.body.name, 150);
    const description = sanitizeText(req.body.description, 5000);
    const startDate = req.body.startDate || null;
    const endDate = req.body.endDate || null;
    const status = req.body.status || project.status;

    if (!name) throw error(400, 'Project name is required.');
    if (startDate && !isValidDate(startDate)) throw error(400, 'Invalid date.');
    if (endDate && !isValidDate(endDate)) throw error(400, 'Invalid date.');
    if (startDate && endDate && endDate < startDate) throw error(400, 'End date cannot be before start date.');
    if (!['Active', 'Completed', 'Archived'].includes(status)) throw error(400, 'Invalid status.');

    project.name = name;
    project.description = description;
    project.start_date = startDate;
    project.end_date = endDate;
    project.status = status;
    project.updated_at = new Date().toISOString();

    await saveDatabase(db);
    res.json(success('Project updated successfully.'));
  } catch (err) { next(err); }
});

app.delete('/api/projects/:id', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (project.created_by !== userId) throw error(403, 'Only the project creator can delete this project.');

    db.projects = db.projects.filter((p) => p.id !== projectId);
    db.members = db.members.filter((m) => m.project_id !== projectId);
    db.files = db.files.filter((f) => f.project_id !== projectId);
    db.schedules.forEach((s) => {
      if (s.project_id === projectId) s.project_id = null;
    });

    await saveDatabase(db);
    res.json(success('Project deleted successfully.'));
  } catch (err) { next(err); }
});

app.get('/api/projects/:id/members', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (!db.members.some((member) => member.project_id === projectId && member.user_id === userId)) throw error(403, 'You do not have permission to access this project.');
    const members = db.members
      .filter((member) => member.project_id === projectId)
      .map((member) => {
        const user = getUserById(db, member.user_id);
        if (!user) return null;
        return { id: user.id, full_name: user.full_name, username: user.username, email: user.email, department: user.department, added_at: member.added_at, is_owner: user.id === project.created_by };
      })
      .filter(Boolean);
    res.json({ members });
  } catch (err) { next(err); }
});

app.post('/api/projects/:id/members', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (project.created_by !== userId) throw error(403, 'Only the project creator can add members.');
    const targetUserId = Number(req.body.userId);
    const targetUser = getUserById(db, targetUserId);
    if (!targetUser || targetUser.account_status !== 'active') throw error(404, 'User does not exist.');
    if (db.members.some((member) => member.project_id === projectId && member.user_id === targetUserId)) throw error(409, 'User is already a member of this project.');
    db.members.push({ id: nextId(db), project_id: projectId, user_id: targetUserId, added_by: userId, added_at: new Date().toISOString() });
    await saveDatabase(db);
    const members = db.members.filter((member) => member.project_id === projectId).map((member) => {
      const user = getUserById(db, member.user_id);
      return { id: user.id, full_name: user.full_name, username: user.username, email: user.email, department: user.department, added_at: member.added_at, is_owner: user.id === project.created_by };
    });
    res.json({ message: `${targetUser.full_name} was added to the project.`, members });
  } catch (err) { next(err); }
});

app.delete('/api/projects/:id/members/:memberId', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const memberId = Number(req.params.memberId);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (project.created_by !== userId) throw error(403, 'Only the project creator can remove members.');
    if (memberId === project.created_by) throw error(400, 'The project creator cannot be removed.');
    const member = db.members.find((entry) => entry.project_id === projectId && entry.user_id === memberId);
    if (!member) throw error(404, 'Member not found.');
    db.members = db.members.filter((entry) => !(entry.project_id === projectId && entry.user_id === memberId));
    await saveDatabase(db);
    const members = db.members.filter((entry) => entry.project_id === projectId).map((entry) => {
      const user = getUserById(db, entry.user_id);
      return { id: user.id, full_name: user.full_name, username: user.username, email: user.email, department: user.department, added_at: entry.added_at, is_owner: user.id === project.created_by };
    });
    res.json({ message: 'Member removed.', members });
  } catch (err) { next(err); }
});

app.get('/api/projects/:id/files', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (!db.members.some((member) => member.project_id === projectId && member.user_id === userId)) throw error(403, 'You do not have permission to access this project.');
    const files = db.files.filter((file) => file.project_id === projectId).sort((a, b) => b.id - a.id);
    res.json({ files });
  } catch (err) { next(err); }
});

app.post('/api/projects/:id/files', upload.array('files', 10), async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    if (!db.members.some((member) => member.project_id === projectId && member.user_id === userId)) throw error(403, 'You do not have permission to access this project.');
    const uploaded = req.files || [];
    if (!uploaded.length) throw error(400, 'No files selected.');
    for (const file of uploaded) {
      const id = nextId(db);
      state.fileData[id] = file.buffer;
      db.files.push({
        id,
        project_id: projectId,
        uploaded_by: userId,
        original_filename: file.originalname,
        stored_filename: `memory:${id}`,
        file_path: `memory/${id}`,
        file_size: file.size,
        mime_type: file.mimetype || 'application/octet-stream',
        uploaded_at: new Date().toISOString(),
      });
    }
    await saveDatabase(db);
    const files = db.files.filter((file) => file.project_id === projectId).sort((a, b) => b.id - a.id);
    res.json({ message: uploaded.length > 1 ? 'Files uploaded successfully.' : 'File uploaded successfully.', files });
  } catch (err) { next(err); }
});

app.delete('/api/projects/:id/files/:fileId', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw error(404, 'Project not found.');
    const fileRecord = db.files.find((file) => file.id === fileId && file.project_id === projectId);
    if (!fileRecord) throw error(404, 'File not found.');
    if (project.created_by !== userId && fileRecord.uploaded_by !== userId) throw error(403, 'You do not have permission to remove this file.');
    db.files = db.files.filter((file) => !(file.id === fileId && file.project_id === projectId));
    delete state.fileData[fileId];
    await saveDatabase(db);
    res.json({ message: 'File removed successfully.', files: db.files.filter((file) => file.project_id === projectId) });
  } catch (err) { next(err); }
});

app.get('/api/projects/:id/files/:fileId/download', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!db.members.some((m) => m.project_id === projectId && m.user_id === userId)) {
      throw error(403, 'You do not have permission to access this project.');
    }
    const fileRecord = db.files.find((f) => f.id === fileId && f.project_id === projectId);
    if (!fileRecord) throw error(404, 'File not found.');
    const buf = state.fileData ? state.fileData[fileId] : null;
    if (!buf) {
      return res.status(404).send('File content not available in server memory.');
    }
    res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.original_filename)}"`);
    res.send(buf);
  } catch (err) { next(err); }
});

/* ---------- Schedules Endpoints ---------- */
app.get('/api/schedules', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    let schedules = db.schedules.filter((entry) => entry.user_id === userId);
    if (req.query.from && req.query.to) {
      schedules = schedules.filter((s) => s.start_date <= req.query.to && s.end_date >= req.query.from);
    }
    schedules.sort((a, b) => a.start_date.localeCompare(b.start_date));
    res.json({ schedules: schedules.map((entry) => ({ ...entry, project_name: entry.project_id ? (db.projects.find((project) => project.id === entry.project_id)?.name || null) : null })) });
  } catch (err) { next(err); }
});

app.post('/api/schedules', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const name = sanitizeText(req.body.name, 150);
    const description = sanitizeText(req.body.description, 5000);
    const priority = req.body.priority || 'Medium';
    const status = req.body.status || 'Pending';
    const startDate = req.body.startDate;
    const endDate = req.body.endDate;
    if (!name) throw error(400, 'Schedule name is required.');
    if (!isValidDate(startDate) || !isValidDate(endDate)) throw error(400, 'Valid start and end dates are required.');
    if (endDate < startDate) throw error(400, 'End date cannot be before start date.');
    if (!['Low', 'Medium', 'High', 'Urgent'].includes(priority)) throw error(400, 'Invalid priority.');
    if (!['Pending', 'In Progress', 'Completed'].includes(status)) throw error(400, 'Invalid status.');

    let projectId = null;
    if (req.body.projectId) {
      projectId = Number(req.body.projectId);
      if (!db.members.some((m) => m.project_id === projectId && m.user_id === userId)) {
        throw error(400, 'You do not have permission to use that project.');
      }
    }

    const schedule = {
      id: nextId(db),
      user_id: userId,
      name,
      description,
      start_date: startDate,
      end_date: endDate,
      project_id: projectId,
      priority,
      status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.schedules.push(schedule);
    await saveDatabase(db);
    res.json(success('Schedule created successfully.', { id: schedule.id }));
  } catch (err) { next(err); }
});

app.get('/api/schedules/:id', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const schedId = Number(req.params.id);
    const schedule = db.schedules.find((s) => s.id === schedId && s.user_id === userId);
    if (!schedule) throw error(404, 'Schedule not found.');
    res.json({
      schedule: {
        ...schedule,
        project_name: schedule.project_id ? (db.projects.find((p) => p.id === schedule.project_id)?.name || null) : null,
      },
    });
  } catch (err) { next(err); }
});

app.put('/api/schedules/:id', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const schedId = Number(req.params.id);
    const schedule = db.schedules.find((s) => s.id === schedId && s.user_id === userId);
    if (!schedule) throw error(404, 'Schedule not found.');

    const name = sanitizeText(req.body.name, 150);
    const description = sanitizeText(req.body.description, 5000);
    const priority = req.body.priority || 'Medium';
    const status = req.body.status || 'Pending';
    const startDate = req.body.startDate;
    const endDate = req.body.endDate;

    if (!name) throw error(400, 'Schedule name is required.');
    if (!isValidDate(startDate) || !isValidDate(endDate)) throw error(400, 'Valid start and end dates are required.');
    if (endDate < startDate) throw error(400, 'End date cannot be before start date.');
    if (!['Low', 'Medium', 'High', 'Urgent'].includes(priority)) throw error(400, 'Invalid priority.');
    if (!['Pending', 'In Progress', 'Completed'].includes(status)) throw error(400, 'Invalid status.');

    let projectId = null;
    if (req.body.projectId) {
      projectId = Number(req.body.projectId);
      if (!db.members.some((m) => m.project_id === projectId && m.user_id === userId)) {
        throw error(400, 'You do not have permission to use that project.');
      }
    }

    schedule.name = name;
    schedule.description = description;
    schedule.start_date = startDate;
    schedule.end_date = endDate;
    schedule.project_id = projectId;
    schedule.priority = priority;
    schedule.status = status;
    schedule.updated_at = new Date().toISOString();

    await saveDatabase(db);
    res.json(success('Schedule updated successfully.'));
  } catch (err) { next(err); }
});

app.delete('/api/schedules/:id', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const schedId = Number(req.params.id);
    const schedule = db.schedules.find((s) => s.id === schedId && s.user_id === userId);
    if (!schedule) throw error(404, 'Schedule not found.');

    db.schedules = db.schedules.filter((s) => s.id !== schedId);
    await saveDatabase(db);
    res.json(success('Schedule deleted successfully.'));
  } catch (err) { next(err); }
});

/* ---------- Support Endpoints ---------- */
app.post('/api/support/question', async (req, res, next) => {
  try {
    const question = sanitizeText(req.body.question || '', 1000).toLowerCase();
    if (!question) throw error(400, 'Please enter your question.');
    const answers = [
      { keys: ['create project', 'new project', 'start project'], solution: '1. Open the Projects section.\n2. Click “+ Start New Project”.\n3. Add the name, description, and dates.\n4. Save the project and invite team members.' },
      { keys: ['login', 'sign in', 'password'], solution: '1. Go to the login page.\n2. Use your registered email and password.\n3. If 2FA is enabled, enter the 6-digit code from your authenticator app.' },
      { keys: ['schedule', 'calendar', 'event'], solution: '1. Open Schedule.\n2. Click “Add Schedule”.\n3. Set date range, project, priority, and status.\n4. Save the item to update your calendar.' },
      { keys: ['support', 'ticket', 'bug', 'issue'], solution: '1. Use the Support page.\n2. Describe the problem in detail.\n3. Submit the ticket and a staff member will follow up.' },
      { keys: ['profile', 'account', 'settings'], solution: '1. Open Settings.\n2. Update your name, email, and department.\n3. Save changes and review your two-factor authentication settings.' },
      { keys: ['member', 'team', 'invite'], solution: '1. Open a project.\n2. Click “Add Members”.\n3. Search by name or email and confirm the invite.' },
    ];
    const found = answers.find((entry) => entry.keys.some((key) => key.split(' ').every((word) => question.includes(word))));
    if (!found) {
      return res.json({ found: false, message: 'Please try a project, login, schedule, member, or account question.' });
    }
    res.json({ found: true, solution: found.solution });
  } catch (err) { next(err); }
});

app.get('/api/support/tickets', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    res.json({ tickets: db.tickets.filter((ticket) => ticket.user_id === userId).sort((a, b) => b.id - a.id) });
  } catch (err) { next(err); }
});

app.post('/api/support/tickets', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const subject = sanitizeText(req.body.subject, 200);
    const description = sanitizeText(req.body.description, 5000);
    const priority = req.body.priority || 'Medium';
    if (!subject) throw error(400, 'Subject is required.');
    if (!description) throw error(400, 'Description is required.');
    const ticket = { id: nextId(db), user_id: userId, subject, description, priority, status: 'Open', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    db.tickets.push(ticket);
    await saveDatabase(db);
    res.json(success('Support request submitted.', { id: ticket.id }));
  } catch (err) { next(err); }
});

/* ---------- Settings Endpoints ---------- */
app.put('/api/settings/password', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const user = getUserById(db, userId);
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    if (!currentPassword || !newPassword || !confirmPassword) throw error(400, 'All fields are required.');
    if (newPassword.length < 8) throw error(400, 'New password is too short (minimum 8 characters).');
    if (newPassword !== confirmPassword) throw error(400, 'Passwords do not match.');
    if (!verifyPassword(currentPassword, user.password_hash)) throw error(400, 'Current password is incorrect.');
    user.password_hash = hashPassword(newPassword);
    await saveDatabase(db);
    res.json({ message: 'Password changed successfully.' });
  } catch (err) { next(err); }
});

app.post('/api/settings/2fa/setup', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const user = getUserById(db, userId);
    if (user.totp_enabled) throw error(400, 'Two-factor authentication is already enabled.');
    const secret = base32Encode(crypto.randomBytes(20));
    state.pending2fa[userId] = secret;
    res.json({ secret, otpauth: `otpauth://totp/Olajide%20Staff%20Portal:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Olajide%20Staff%20Portal` });
  } catch (err) { next(err); }
});

app.post('/api/settings/2fa/enable', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const user = getUserById(db, userId);
    const secret = state.pending2fa[userId];
    const code = sanitizeText(req.body.code || '', 10);
    if (!secret) throw error(400, 'Start setup first.');
    if (!verifyTotp(secret, code)) throw error(400, 'Invalid verification code.');
    user.totp_secret = secret;
    user.totp_enabled = true;
    delete state.pending2fa[userId];
    await saveDatabase(db);
    res.json({ message: 'Two-factor authentication enabled.' });
  } catch (err) { next(err); }
});

app.post('/api/settings/2fa/disable', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const user = getUserById(db, userId);
    if (!user.totp_enabled) throw error(400, 'Two-factor authentication is not enabled.');
    const password = String(req.body.password || '');
    const code = sanitizeText(req.body.code || '', 10);
    if (!verifyPassword(password, user.password_hash)) throw error(400, 'Password is incorrect.');
    if (!verifyTotp(user.totp_secret, code)) throw error(400, 'Invalid verification code.');
    user.totp_secret = null;
    user.totp_enabled = false;
    await saveDatabase(db);
    res.json({ message: 'Two-factor authentication disabled.' });
  } catch (err) { next(err); }
});

app.post('/api/settings/profile-picture', upload.single('avatar'), async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const user = getUserById(db, userId);
    const file = req.file;
    if (!file) throw error(400, 'No image selected.');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) throw error(400, 'Only PNG, JPG or WEBP images are allowed.');
    if (file.size > 2 * 1024 * 1024) throw error(400, 'File is too large.');
    user.profile_picture = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    await saveDatabase(db);
    res.json({ message: 'Profile picture updated.', avatarUrl: user.profile_picture });
  } catch (err) { next(err); }
});

app.put('/api/settings/theme', async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const theme = req.body.theme || 'system';
    const user = getUserById(db, userId);
    user.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    await saveDatabase(db);
    res.json({ message: 'Theme saved.', theme: user.theme });
  } catch (err) { next(err); }
});

const updateAccountHandler = async (req, res, next) => {
  try {
    const db = await loadDatabase();
    const userId = withSession(req, res, (uid) => uid);
    const user = getUserById(db, userId);
    const fullName = sanitizeText(req.body.fullName, 100);
    const username = sanitizeText(req.body.username, 30);
    const email = sanitizeText(req.body.email, 150).toLowerCase();
    const department = sanitizeText(req.body.department, 100) || 'Not set';
    if (!fullName || fullName.length < 2) throw error(400, 'Full name is required.');
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw error(400, 'Username must be 3-30 characters (letters, numbers, . _ -).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw error(400, 'Invalid email address.');
    if (db.users.some((item) => item.id !== userId && item.username.toLowerCase() === username.toLowerCase())) throw error(409, 'Username already exists.');
    if (db.users.some((item) => item.id !== userId && item.email.toLowerCase() === email)) throw error(409, 'Email already exists.');
    user.full_name = fullName;
    user.username = username;
    user.email = email;
    user.department = department;
    await saveDatabase(db);
    res.json({ message: 'Account updated successfully.', user: publicUser(user) });
  } catch (err) { next(err); }
};

app.put('/api/settings/account', updateAccountHandler);
app.put('/api/users/profile', updateAccountHandler);

/* ---------- Static Fallback & Error Handling Middleware ---------- */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'API route not found.' });
  }
  const cleanPath = req.path.replace(/^\//, '');
  const candidate = path.join(projectRoot, cleanPath);
  if (cleanPath && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return res.sendFile(candidate);
  }
  res.sendFile(path.join(projectRoot, 'index.html'));
});

// Centralized Express error handler (always last)
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = err.message || 'Something went wrong.';
  if (status !== 401 && status !== 404) console.error('[API Error]', err.message);
  res.status(status).json({ message });
});

/* ---------- Server Startup ---------- */
(async () => {
  try {
    await ensureDefaultUser();
  } catch (err) {
    console.warn('Initial setup warning:', err.message);
  }
  app.listen(PORT, () => {
    console.log(`Staff portal backend listening on http://localhost:${PORT}`);
  });
})().catch((err) => {
  console.error('Fatal initialization error:', err.message);
});

module.exports = app;
