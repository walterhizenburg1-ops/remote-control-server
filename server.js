const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Remote Control Server Running!!');
});

const wss = new WebSocket.Server({ server });
const rooms = {};

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRole = null;

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    if (data.type === 'join') {
      currentRoom = data.room;
      currentRole = data.role;
      if (!rooms[currentRoom]) {
        rooms[currentRoom] = {
          host: null,
          controller: null,
          hostCandidates: [],
          controllerCandidates: []
        };
      }
      rooms[currentRoom][currentRole] = ws;
      console.log(`${currentRole} joined room ${currentRoom}`);

      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom][other]) {
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-joined', role: currentRole }));
        ws.send(JSON.stringify({ type: 'peer-joined', role: other }));

        // flush buffered candidates!!
        const myBuffer = currentRole === 'host' ? 'controllerCandidates' : 'hostCandidates';
        rooms[currentRoom][myBuffer].forEach(c => ws.send(JSON.stringify(c)));
        rooms[currentRoom][myBuffer] = [];
      }
    }

    else if (data.type === 'offer' || data.type === 'answer') {
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data));
      }
    }

    else if (data.type === 'ice') {
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data));
      } else {
        // buffer it until other side connects!!
        const buffer = currentRole === 'host' ? 'hostCandidates' : 'controllerCandidates';
        rooms[currentRoom][buffer].push(data);
      }
    }

    else if (data.type === 'touch' || data.type === 'keyboard') {
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data));
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom][currentRole];
      const other = currentRole === 'host' ? 'controller' : 'host';
      if (rooms[currentRoom][other]) {
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-left' }));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
