const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const fs = require('fs');

const TOKENS_FILE = '/tmp/fcm_tokens.json';

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
  res.writeHead(200);
  res.end('Remote Control Server Running!!');
});

const wss = new WebSocket.Server({ server, maxPayload: 10 * 1024 * 1024 });
const rooms = {};

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

  ws.on('pong', () => { ws.isAlive = true; });

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

    console.log('Message:', data.type, 'from:', currentRole, 'room:', currentRoom);

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

      rooms[currentRoom][currentRole] = ws;
      console.log(`${currentRole} joined room ${currentRoom}`);

      if (currentRole === 'host') {
        rooms[currentRoom].hostReady = true;
        if (rooms[currentRoom].controller) {
          rooms[currentRoom].controller.send(JSON.stringify({
            type: 'host-ready'
          }));
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

    else if (
      data.type === 'touch' || data.type === 'keyboard' ||
      data.type === 'system' || data.type === 'swipe' ||
      data.type === 'scroll' || data.type === 'longpress' ||
      data.type === 'overlay_start' || data.type === 'overlay_stop'
    ) {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }
  });

  ws.on('close', () => {
    console.log(`${currentRole} left room ${currentRoom}`);
    if (currentRoom && rooms[currentRoom]) {
      if (currentRole === 'host') {
        rooms[currentRoom].hostReady = false;
      }
      delete rooms[currentRoom][currentRole];
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(
          JSON.stringify({ type: 'peer-left' })
        );
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
