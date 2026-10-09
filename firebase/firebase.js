// Firebase configuration and Firebase Authentication integration
const firebaseConfig = {
  apiKey: "AIzaSyDV6o7Jcf5K03ssSOZDxNjlYKqG52pwNik",
  authDomain: "olajide-staff-portal.firebaseapp.com",
  databaseURL: "https://olajide-staff-portal-default-rtdb.firebaseio.com",
  projectId: "olajide-staff-portal",
  storageBucket: "olajide-staff-portal.firebasestorage.app",
  messagingSenderId: "892587824647",
  appId: "1:892587824647:web:159e618e8388850789fca2",
  measurementId: "G-DYX5FBL819"
};

const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1';

// Format display name for Firebase Authentication profile
function formatDisplayName(fullName, username) {
  if (fullName && username) return `${fullName} (@${username})`;
  return fullName || username || '';
}

// Extract full name and username from Firebase Auth displayName
function parseDisplayName(displayName) {
  if (!displayName) return { fullName: '', username: '' };
  const match = displayName.match(/^(.*?)\s*\(@(.*)\)$/);
  if (match) {
    return { fullName: match[1].trim(), username: match[2].trim() };
  }
  return { fullName: displayName.trim(), username: displayName.toLowerCase().replace(/[^a-z0-9_.-]/g, '') };
}

// 1. Create User in Firebase Authentication (Google Identity Toolkit REST API)
async function signUpWithFirebaseAuth({ email, password, displayName }) {
  const url = `${IDENTITY_TOOLKIT_URL}/accounts:signUp?key=${firebaseConfig.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName: displayName || '',
      returnSecureToken: true,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorMsg = data?.error?.message || 'Firebase Auth signup failed.';
    if (errorMsg.includes('EMAIL_EXISTS')) {
      throw new Error('An account with this email address already exists in Firebase Authentication.');
    }
    if (errorMsg.includes('WEAK_PASSWORD')) {
      throw new Error('Password should be at least 6 characters.');
    }
    if (errorMsg.includes('INVALID_EMAIL')) {
      throw new Error('Invalid email address format.');
    }
    throw new Error(`Firebase Authentication error: ${errorMsg}`);
  }

  // Explicitly update displayName in Firebase Auth profile to ensure username & full name persist
  if (displayName && data.idToken) {
    try {
      await updateFirebaseAuthProfile({ idToken: data.idToken, displayName });
      console.log(`[Firebase Auth] Display name (${displayName}) synced to Firebase Auth profile for ${email}`);
    } catch (profileErr) {
      console.warn(`[Firebase Auth] Display name sync warning:`, profileErr.message);
    }
  }

  console.log(`[Firebase Auth] New user registered successfully: ${email} (UID: ${data.localId})`);
  return {
    uid: data.localId,
    email: data.email,
    displayName: displayName || data.displayName || '',
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
  };
}

// 2. Sign In User with Firebase Authentication
async function signInWithFirebaseAuth({ email, password }) {
  const url = `${IDENTITY_TOOLKIT_URL}/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorMsg = data?.error?.message || 'Firebase Auth login failed.';
    if (errorMsg.includes('EMAIL_NOT_FOUND') || errorMsg.includes('INVALID_PASSWORD') || errorMsg.includes('INVALID_LOGIN_CREDENTIALS')) {
      throw new Error('Invalid email or password.');
    }
    if (errorMsg.includes('USER_DISABLED')) {
      throw new Error('This user account has been disabled.');
    }
    throw new Error(`Firebase Authentication error: ${errorMsg}`);
  }

  console.log(`[Firebase Auth] User authenticated successfully: ${email} (UID: ${data.localId})`);
  return {
    uid: data.localId,
    email: data.email,
    displayName: data.displayName || '',
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
  };
}

// 3. Update User Profile in Firebase Authentication (Display Name / Photo)
async function updateFirebaseAuthProfile({ idToken, displayName, photoUrl }) {
  const url = `${IDENTITY_TOOLKIT_URL}/accounts:update?key=${firebaseConfig.apiKey}`;
  const payload = { idToken, returnSecureToken: true };
  if (displayName !== undefined) payload.displayName = displayName;
  if (photoUrl !== undefined) payload.photoUrl = photoUrl;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Firebase Auth update error: ${data?.error?.message || res.status}`);
  }
  return data;
}

// 4. Look up User Data by ID Token
async function getFirebaseUserData(idToken) {
  const url = `${IDENTITY_TOOLKIT_URL}/accounts:lookup?key=${firebaseConfig.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return data.users && data.users[0] ? data.users[0] : null;
}

// Browser environment initialization
let app = null;
let auth = null;

if (typeof window !== 'undefined') {
  window.firebaseConfig = firebaseConfig;
  window.signUpWithFirebaseAuth = signUpWithFirebaseAuth;
  window.signInWithFirebaseAuth = signInWithFirebaseAuth;
  window.updateFirebaseAuthProfile = updateFirebaseAuthProfile;
  window.formatDisplayName = formatDisplayName;
  window.parseDisplayName = parseDisplayName;

  if (typeof firebase !== 'undefined') {
    try {
      app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
      if (firebase.auth) auth = firebase.auth();
      window.firebaseApp = app;
      window.firebaseAuth = auth;
      console.log('Firebase Authentication SDK initialized.');
    } catch (e) {
      console.warn('Firebase initialization notice:', e.message);
    }
  }
}

// Node.js CommonJS environment support
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    firebaseConfig,
    formatDisplayName,
    parseDisplayName,
    signUpWithFirebaseAuth,
    signInWithFirebaseAuth,
    updateFirebaseAuthProfile,
    getFirebaseUserData,
  };
}
