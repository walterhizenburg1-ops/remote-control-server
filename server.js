const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Remote Control Server Running!!');
});

const wss = new WebSocket.Server({ server, maxPayload: 10 * 1024 * 1024 });
const rooms = {};
const fcmTokens = {};
const FCM_SERVER_KEY = '7c192da0f83f64a80b0d476eaafd87083990c6c0';

// keep connections alive!!
const pingInterval = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.ping()
  })
}, 25000)

wss.on('close', () => clearInterval(pingInterval))

function wakeHostViaFCM(deviceId) {
  const token = fcmTokens[deviceId]
  if (!token) {
    console.log('No FCM token for device:', deviceId)
    return
  }

  console.log('Sending FCM wake to:', deviceId)

  const payload = JSON.stringify({
    to: token,
    data: { type: 'wake', deviceId: deviceId },
    priority: 'high',
    time_to_live: 60
  })

  const options = {
    hostname: 'fcm.googleapis.com',
    path: '/fcm/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `key=${FCM_SERVER_KEY}`
    }
  }

  const req = https.request(options, (res) => {
    console.log('FCM response:', res.statusCode)
  })
  req.on('error', (e) => console.log('FCM error:', e))
  req.write(payload)
  req.end()
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRole = null;

  console.log('New connection!!');

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      if (currentRoom && rooms[currentRoom]?.controller) {
        try {
          rooms[currentRoom].controller.send(message, { binary: true });
        } catch(e) {
          console.log('Frame send error:', e);
        }
      }
      return;
    }

    let data;
    try {
      data = JSON.parse(message.toString());
    } catch(e) {
      console.log('Parse error:', e);
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
        rooms[currentRoom].hostReady = true
        if (rooms[currentRoom].controller) {
          rooms[currentRoom].controller.send(JSON.stringify({
            type: 'host-ready'
          }))
        }
      }

      if (currentRole === 'controller') {
        if (rooms[currentRoom].hostReady && rooms[currentRoom].host) {
          rooms[currentRoom].host.send(JSON.stringify({
            type: 'peer-joined',
            role: 'controller'
          }))
          ws.send(JSON.stringify({ type: 'host-ready' }))
        } else {
          // host offline!! wake via FCM!!
          console.log('Host offline!! Waking via FCM!!')
          wakeHostViaFCM(currentRoom)
          ws.send(JSON.stringify({ type: 'waiting-for-host' }))
        }
      }
    }

    else if (data.type === 'register-fcm') {
      console.log('FCM token registered for:', data.deviceId)
      fcmTokens[data.deviceId] = data.token
    }

    else if (data.type === 'streaming-started') {
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data))
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

    else if (data.type === 'touch' || data.type === 'keyboard' ||
             data.type === 'system' || data.type === 'swipe' ||
             data.type === 'scroll' || data.type === 'longpress') {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }
  });

  ws.on('close', () => {
    console.log(`${currentRole} left room ${currentRoom}`);
    if (currentRoom && rooms[currentRoom]) {
      if (currentRole === 'host') {
        rooms[currentRoom].hostReady = false
      }
      delete rooms[currentRoom][currentRole];
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-left' }));
      }
    }
  });

  ws.on('error', (err) => {
    console.log('Error:', err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
