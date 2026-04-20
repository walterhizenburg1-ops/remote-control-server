const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Remote Control Server Running!!');
});

const wss = new WebSocket.Server({ server, maxPayload: 10 * 1024 * 1024 });
const rooms = {};

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
        rooms[currentRoom] = { host: null, controller: null };
      }
      rooms[currentRoom][currentRole] = ws;
      console.log(`${currentRole} joined room ${currentRoom}`);
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom][other]) {
        console.log('Both peers here!! Notifying!!');
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-joined', role: currentRole }));
        ws.send(JSON.stringify({ type: 'peer-joined', role: other }));
      }
    }

    else if (data.type === 'offer') {
      console.log('Relaying offer to controller!!');
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data));
      }
    }

    else if (data.type === 'answer') {
      console.log('Relaying answer to host!!');
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }

    else if (data.type === 'ice') {
      console.log('Relaying ICE from:', currentRole);
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data));
      }
    }

    else if (data.type === 'dimensions') {
      console.log('Relaying dimensions!!');
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data));
      }
    }

    else if (data.type === 'mode') {
      console.log('Relaying mode switch:', data.value);
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data));
      }
    }

    else if (
      data.type === 'touch' || data.type === 'keyboard' ||
      data.type === 'system' || data.type === 'swipe' ||
      data.type === 'scroll' || data.type === 'longpress' ||
      data.type === 'overlay'
    ) {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }
  });

  ws.on('close', () => {
    console.log(`${currentRole} left room ${currentRoom}`);
    if (currentRoom && rooms[currentRoom]) {
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
