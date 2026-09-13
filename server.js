const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieSession = require('cookie-session');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

// Data directory is a Docker volume mount point by default, so writes
// land on the host machine's disk, not inside the ephemeral container.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');

// Google Sign-In config (from environment variables). No insecure default -
// fail fast at startup rather than silently running unprotected.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
// Accepts comma- or semicolon-separated emails. Semicolons matter for the
// Cloud Run deploy: gcloud's --update-env-vars flag itself splits on commas
// between KEY=VALUE pairs, so a comma-separated value here gets silently
// mangled into extra bogus env vars when set that way.
const AUTHORIZED_EMAILS = (process.env.AUTHORIZED_EMAILS || '')
  .split(/[,;]/)
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET;
// Cookies default to Secure (HTTPS-only); set COOKIE_SECURE=false for local
// http://localhost testing.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';

// Optional friendly names for the user switcher, e.g. "a@x.com=Alice;b@y.com=Bob".
// Semicolon-delimited for the same reason AUTHORIZED_EMAILS is (see above).
const DISPLAY_NAMES = {};
(process.env.DISPLAY_NAMES || '').split(';').forEach((pair) => {
  const idx = pair.indexOf('=');
  if (idx === -1) return;
  const email = pair.slice(0, idx).trim().toLowerCase();
  const name = pair.slice(idx + 1).trim();
  if (email && name) DISPLAY_NAMES[email] = name;
});

function displayName(email) {
  if (DISPLAY_NAMES[email]) return DISPLAY_NAMES[email];
  const local = email.split('@')[0] || email;
  return local
    .split(/[._+]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

if (!GOOGLE_CLIENT_ID || !SESSION_SECRET || AUTHORIZED_EMAILS.length === 0) {
  console.error(
    'Missing required auth config. Set GOOGLE_CLIENT_ID, SESSION_SECRET, ' +
    'and AUTHORIZED_EMAILS (comma-separated) environment variables.'
  );
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));

// Cloud Run terminates TLS at its proxy and forwards plain HTTP, so Express
// needs to trust the X-Forwarded-Proto header for secure cookies to work.
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieSession({
  name: 'session',
  keys: [SESSION_SECRET],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: COOKIE_SECURE
}));

// --- Public auth routes (must be reachable while logged out) ---

app.get('/api/auth/config', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: req.body && req.body.credential,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = (payload.email || '').toLowerCase();

    if (!payload.email_verified || !AUTHORIZED_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'not authorized' });
    }

    req.session.email = email;
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- Auth gate: everything below requires a valid session ---

function requireAuth(req, res, next) {
  const email = req.session && req.session.email;
  if (email && AUTHORIZED_EMAILS.includes(email)) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.redirect('/login.html');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// Simple mutex so concurrent requests can't interleave read-modify-write
// cycles and clobber each other's changes to the JSON file.
let writeLock = Promise.resolve();
function withLock(fn) {
  const result = writeLock.then(fn);
  writeLock = result.catch(() => {});
  return result;
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeStore(store) {
  // Write to a temp file then rename, so a crash mid-write can't corrupt
  // the main data file.
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function readUserStore(email) {
  const store = readStore();
  return store[email] || {};
}

function writeUserStore(email, userStore) {
  const store = readStore();
  store[email] = userStore;
  writeStore(store);
}

// GET a single key - reads the caller's own data, or another authorized
// user's via ?user= (read-only browsing; writes below always stay self-scoped).
app.get('/api/storage/:key', (req, res) => {
  const targetUser = req.query.user || req.session.email;
  if (!AUTHORIZED_EMAILS.includes(targetUser)) {
    return res.status(400).json({ error: 'unknown user' });
  }
  const store = readUserStore(targetUser);
  const key = req.params.key;
  if (!(key in store)) return res.status(404).json({ error: 'not found' });
  res.json({ key, value: store[key] });
});

// SET a single key - always writes to the caller's own data.
app.put('/api/storage/:key', (req, res) => {
  withLock(() => {
    const store = readUserStore(req.session.email);
    const key = req.params.key;
    const value = req.body ? req.body.value : undefined;
    store[key] = value;
    writeUserStore(req.session.email, store);
    res.json({ key, value });
  }).catch((e) => {
    res.status(500).json({ error: 'write failed', detail: String(e) });
  });
});

// DELETE a single key - always deletes from the caller's own data.
app.delete('/api/storage/:key', (req, res) => {
  withLock(() => {
    const store = readUserStore(req.session.email);
    const key = req.params.key;
    delete store[key];
    writeUserStore(req.session.email, store);
    res.json({ key, deleted: true });
  }).catch((e) => {
    res.status(500).json({ error: 'delete failed', detail: String(e) });
  });
});

// LIST keys, optionally filtered by prefix, for the caller or ?user=.
app.get('/api/storage', (req, res) => {
  const targetUser = req.query.user || req.session.email;
  if (!AUTHORIZED_EMAILS.includes(targetUser)) {
    return res.status(400).json({ error: 'unknown user' });
  }
  const store = readUserStore(targetUser);
  const prefix = req.query.prefix || '';
  const keys = Object.keys(store).filter((k) => k.startsWith(prefix));
  res.json({ keys });
});

app.get('/api/auth/me', (req, res) => {
  const email = req.session.email;
  res.json({ email, name: displayName(email) });
});

app.get('/api/users', (req, res) => {
  res.json({
    users: AUTHORIZED_EMAILS.map((email) => ({ email, name: displayName(email) }))
  });
});

app.listen(PORT, () => {
  console.log(`Lift Tracker running at http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Google Sign-In enabled - authorized emails: ${AUTHORIZED_EMAILS.join(', ')}`);
});
