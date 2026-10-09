const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
require('dotenv').config();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('base64');
  return `${salt}:${hash}`;
}

function buildSeed() {
  const createdAt = '2026-10-08T00:00:00.000Z';
  return {
    users: [
      {
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
        created_at: createdAt,
        last_login: null,
        account_status: 'active',
      },
      {
        id: 2,
        full_name: 'Maya Johnson',
        username: 'maya.johnson',
        email: 'maya.johnson@olajide.com',
        password_hash: hashPassword('admin123'),
        department: 'Engineering',
        profile_picture: null,
        theme: 'light',
        totp_secret: null,
        totp_enabled: false,
        created_at: createdAt,
        last_login: null,
        account_status: 'active',
      },
      {
        id: 3,
        full_name: 'Samuel Okafor',
        username: 'samuel.okafor',
        email: 'samuel.okafor@olajide.com',
        department: 'Operations',
        password_hash: hashPassword('admin123'),
        profile_picture: null,
        theme: 'dark',
        totp_secret: null,
        totp_enabled: false,
        created_at: createdAt,
        last_login: null,
        account_status: 'active',
      },
    ],
    projects: [
      {
        id: 1,
        name: 'Staff Portal Redesign',
        description: 'Modernize the employee portal with a clean dashboard, scheduling, project management, and support workflows.',
        created_by: 1,
        start_date: '2026-09-01',
        end_date: '2026-11-30',
        status: 'Active',
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: 2,
        name: 'Operations Automation',
        description: 'Automate repetitive internal operations such as approvals, reminders, and department task tracking.',
        created_by: 2,
        start_date: '2026-10-01',
        end_date: '2026-12-20',
        status: 'Active',
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    members: [
      { id: 1, project_id: 1, user_id: 1, added_by: 1, added_at: createdAt },
      { id: 2, project_id: 1, user_id: 2, added_by: 1, added_at: createdAt },
      { id: 3, project_id: 1, user_id: 3, added_by: 1, added_at: createdAt },
      { id: 4, project_id: 2, user_id: 2, added_by: 2, added_at: createdAt },
      { id: 5, project_id: 2, user_id: 3, added_by: 2, added_at: createdAt },
    ],
    files: [
      {
        id: 1,
        project_id: 1,
        uploaded_by: 1,
        original_filename: 'portal_requirements.pdf',
        stored_filename: 'memory:1',
        file_path: 'memory/1',
        file_size: 240000,
        mime_type: 'application/pdf',
        uploaded_at: createdAt,
      },
    ],
    schedules: [
      {
        id: 1,
        user_id: 1,
        name: 'Sprint Review',
        description: 'Review current sprint status and unblock team dependencies.',
        start_date: '2026-10-08',
        end_date: '2026-10-08',
        project_id: 1,
        priority: 'High',
        status: 'In Progress',
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: 2,
        user_id: 2,
        name: 'Automation Planning',
        description: 'Define the process map and stakeholders for automation rollout.',
        start_date: '2026-10-12',
        end_date: '2026-10-14',
        project_id: 2,
        priority: 'Medium',
        status: 'Pending',
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    tickets: [
      {
        id: 1,
        user_id: 3,
        subject: 'Unable to access project files',
        description: 'I can open the project workspace but some uploaded documents are not visible to stakeholders.',
        priority: 'High',
        status: 'Open',
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    seq: 10,
  };
}

function initializeFirestore() {
  const serviceAccountFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (serviceAccountFile && fs.existsSync(serviceAccountFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(config),
        projectId: config.project_id || process.env.FIREBASE_PROJECT_ID,
      });
      return admin.firestore();
    } catch (e) {
      console.warn('Admin SDK init warning:', e.message);
    }
  }
  return null;
}

async function main() {
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(buildSeed(), null, 2));
    return;
  }

  const seed = buildSeed();

  // Save to local data cache
  try {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'osp-state.json'), JSON.stringify(seed, null, 2), 'utf8');
    console.log('Local snapshot saved at data/osp-state.json');
  } catch (_) {}

  const db = initializeFirestore();
  if (db) {
    try {
      await db.collection('osp').doc('state').set(seed);
      for (const u of seed.users) {
        await db.collection('users').doc(String(u.id)).set(u);
      }
      console.log('Firestore seeded successfully via Firebase Admin SDK!');
      console.log('Default admin credentials: admin@olajide.com / admin123');
      return;
    } catch (err) {
      console.warn('Firebase Admin seed failed, trying REST API:', err.message);
    }
  }

  // Seed via REST API
  try {
    const { saveToFirestoreViaRest } = require('./firebase/firebase.js');
    await saveToFirestoreViaRest('osp', 'state', seed);
    for (const u of seed.users) {
      await saveToFirestoreViaRest('users', String(u.id), u);
    }
    console.log('Firestore seeded successfully via Firebase REST API!');
    console.log('Default admin credentials: admin@olajide.com / admin123');
  } catch (err) {
    console.warn('Firestore REST seed warning:', err.message);
    console.log('Local seed data initialized. Ready to run staff portal.');
  }
}

main().catch((error) => {
  console.error('Seed process error:', error.message);
  process.exit(1);
});
