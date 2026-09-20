const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const fs = require('fs');

const TOKENS_FILE = '/tmp/fcm_tokens.json';
const FLEET_FILE = '/tmp/fleet_devices.json';

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
