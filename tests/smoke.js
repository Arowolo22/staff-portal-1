const { spawn } = require('node:child_process');
const path = require('node:path');

const base = 'http://localhost:3000';
let sessionCookie = '';

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch (error) {
      // keep retrying until the server is ready
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Server never became ready on port 3000.');
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(options.headers || {}),
    },
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (error) { payload = { raw: text }; }
  if (!response.ok) {
    throw new Error(`${response.status} ${path} :: ${JSON.stringify(payload)}`);
  }
  return payload;
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'ignore',
  });

  try {
    await waitForServer();
    const health = await jsonFetch('/api/health');
    if (!health.ok) throw new Error('Health endpoint did not return ok=true');

    const login = await jsonFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@olajide.com', password: 'admin123' }),
    });
    if (!login.ok) throw new Error('Login did not succeed');

    const testEmail = `testuser_${Date.now()}@olajide.com`;
    const signup = await jsonFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Test User',
        username: `testuser${Date.now().toString().slice(-6)}`,
        email: testEmail,
        password: 'password123',
        confirmPassword: 'password123',
      }),
    });
    if (!signup.message) throw new Error('Signup did not return a message');

    const testLogin = await jsonFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: testEmail, password: 'password123' }),
    });
    if (!testLogin.ok) throw new Error('Login with new user did not succeed');

    const support = await jsonFetch('/api/support/question', {
      method: 'POST',
      body: JSON.stringify({ question: 'How do I create a project?' }),
    });
    if (!support.found) throw new Error('Support question endpoint did not return a valid answer');

    console.log('PASS');
    process.exitCode = 0;
  } catch (error) {
    console.error('FAIL');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
