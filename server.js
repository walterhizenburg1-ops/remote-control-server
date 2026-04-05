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

  ws.on('message', (message) => {
    // binary = screenshot frame!!
    if (message instanceof Buffer) {
      if (currentRoom && rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(message);
      }
      return;
    }

    const data = JSON.parse(message);

    if (data.type === 'join') {
      currentRoom = data.room;
      currentRole = data.role;
      if (!rooms[currentRoom]) rooms[currentRoom] = { host: null, controller: null };
      rooms[currentRoom][currentRole] = ws;
      console.log(`${currentRole} joined room ${currentRoom}`);

      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom][other]) {
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-joined', role: currentRole }));
        ws.send(JSON.stringify({ type: 'peer-joined', role: other }));
      }
    }

    else if (data.type === 'touch' || data.type === 'keyboard') {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data));
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom][currentRole];
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-left' }));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running!!`));
