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

const TOKENS_FILE = '/tmp/fcm_tokens.json';
const FLEET_FILE = '/tmp/fleet_devices.json';

// ═══════════════════════════════════════════════════════════════════════
//  APK BUILDER  —  per-controller signed APK generation
// ═══════════════════════════════════════════════════════════════════════
const TEMPLATE_APK = path.join(__dirname, 'template.apk');
const APK_SIGNER_JAR = path.join(__dirname, 'uber-apk-signer.jar');
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

// Simple lock so two simultaneous builds don't OOM the box
let buildInProgress = false;

// Keystore lives in env var (base64) — decoded to /tmp at boot
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

// ── 3. Full build pipeline (patch → sign → cache) ────────────────────
async function buildApkForMaster(masterId) {
  // Return cached build if still fresh
  const cached = apkCache.get(masterId);
  if (cached && (Date.now() - cached.builtAt) < CACHE_TTL_MS && fs.existsSync(cached.path)) {
    return cached;
  }

  if (buildInProgress) {
    throw new Error('Another build is in progress — try again in a few seconds');
  }
  buildInProgress = true;

  const buildId = crypto.randomBytes(6).toString('hex');
  const patchedPath = path.join(BUILD_DIR, `patched-${buildId}.apk`);
  const signOutDir = path.join(BUILD_DIR, `signed-${buildId}`);
  fs.mkdirSync(signOutDir, { recursive: true });

  try {
    // 1. Patch
    await patchApk(TEMPLATE_APK, patchedPath, masterId);

    // 2. Sign
    await signApk(patchedPath, signOutDir);

    // 3. Find the signed output. uber-apk-signer v1.3.0 writes
    //    "<basename>-aligned-signed.apk" into --out. But if --out is
    //    ignored by some versions, it writes next to the input. We look
    //    in both places, and prefer -signed.apk.
    const searchDirs = [signOutDir, BUILD_DIR];
    let signedPath = null;
    const patchedBase = path.basename(patchedPath);

    for (const d of searchDirs) {
      let entries = [];
      try { entries = fs.readdirSync(d); } catch (_) {}
      console.log(`🔍 scanning ${d} → [${entries.join(', ')}]`);

      // Prefer explicitly-signed output
      const signedMatch = entries.find(f =>
        f.endsWith('-signed.apk') && f !== patchedBase
      );
      if (signedMatch) {
        signedPath = path.join(d, signedMatch);
        break;
      }
      // Fallback: any APK that isn't our own intermediate file
      const anyApk = entries.find(f =>
        f.endsWith('.apk') && f !== patchedBase
      );
      if (anyApk) {
        signedPath = path.join(d, anyApk);
        break;
      }
    }

    if (!signedPath) {
      const outEntries = (() => {
        try { return fs.readdirSync(signOutDir); } catch (_) { return []; }
      })();
      const buildEntries = (() => {
        try { return fs.readdirSync(BUILD_DIR); } catch (_) { return []; }
      })();
      throw new Error(
        'Signer produced no .apk output. ' +
        `outDir=[${outEntries.join(',')}] buildDir=[${buildEntries.join(',')}]`
      );
    }

    const size = fs.statSync(signedPath).size;
    console.log(`✅ signed APK: ${signedPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);

    // 4. Cache
    const rec = { path: signedPath, size, builtAt: Date.now() };
    apkCache.set(masterId, rec);
    return rec;
  } finally {
    // Always remove the intermediate patched file
    try { fs.unlinkSync(patchedPath); } catch (_) {}
    buildInProgress = false;
  }
}

// load tokens from file on startup!!
let fcmTokens = {};
try {
  if (fs.existsSync(TOKENS_FILE)) {
    fcmTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    console.log('Loaded FCM tokens:', Object.keys(fcmTokens).length);
  }
} catch(e) {
  console.log('No saved tokens found!!');
  fcmTokens = {};
}
function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(fcmTokens), 'utf8');
  } catch(e) {
    console.log('Failed to save tokens:', e.message);
  }
}
// load fleet from file on startup!!
let fleetDevices = {};
try {
  if (fs.existsSync(FLEET_FILE)) {
    fleetDevices = JSON.parse(fs.readFileSync(FLEET_FILE, 'utf8'));
    console.log('Loaded Fleet Devices:', Object.keys(fleetDevices).length);
  }
} catch(e) {
  console.log('No saved fleet found!!');
  fleetDevices = {};
}
function saveFleet() {
  try {
    fs.writeFileSync(FLEET_FILE, JSON.stringify(fleetDevices), 'utf8');
  } catch(e) {
    console.log('Failed to save fleet:', e.message);
  }
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
          'Content-Type': 'application/octet-stream',
          'Content-Length': totalSize,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
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
      // Remove it from the list!!
      fleetDevices[masterId] = fleetDevices[masterId].filter(d => d.id !== deviceId);
      saveFleet(); // Persist changes to disk!!
      console.log(`🗑 Permanently deleted device ${deviceId} from fleet ${masterId}`);
      
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
const SEEN_FILE = '/tmp/last_seen.json';
let lastSeen = {};
let seenDirty = false;
try {
  if (fs.existsSync(SEEN_FILE)) lastSeen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
} catch (e) {
  lastSeen = {};
}
function touchSeen(deviceId) {
  lastSeen[deviceId] = Date.now();
  seenDirty = true;
}
// write to disk at most every 30s (not on every pong)
setInterval(() => {
  if (!seenDirty) return;
  seenDirty = false;
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(lastSeen), 'utf8');
  } catch (e) {
    console.log('Failed to save lastSeen:', e.message);
  }
}, 30000);
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
      
      // ============================================================
      // EDIT 4a: Update last seen on host join
      // ============================================================
      if (currentRole === 'host') touchSeen(currentRoom);
      
      console.log(`${currentRole} joined room ${currentRoom}`);
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
      saveTokens(); // persist to file!!
    }
    else if (data.type === 'register-host') {
      const mid = data.masterId;
      if (!fleetDevices[mid]) fleetDevices[mid] = [];
      
      // Prevent duplicates, but update the name if it changed
      const exists = fleetDevices[mid].find(d => d.id === data.deviceId);
      if (!exists) {
        fleetDevices[mid].push({ id: data.deviceId, name: data.name, addedAt: Date.now() });
        saveFleet();
        console.log(`🆕 Host ${data.name} auto-registered to Fleet ${mid}`);
      } else if (exists.name !== data.name) {
        exists.name = data.name;
        saveFleet();
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
