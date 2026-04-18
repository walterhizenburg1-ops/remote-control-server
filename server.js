const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://my-c2-ad3d8-default-rtdb.firebaseio.com'
});

const db = admin.database();

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'GET') {
    res.writeHead(200)
    res.end('Remote Control Server Running!!')
    return
  }

  if (req.method === 'POST' && req.url === '/register') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const { deviceId, fcmToken } = JSON.parse(body)
        // save to Firebase database - persists forever!!
        await db.ref(`devices/${deviceId}`).set({
          fcmToken,
          registeredAt: Date.now()
        })
        console.log(`Device registered: ${deviceId}`)
        res.writeHead(200)
        res.end('OK')
      } catch(e) {
        console.log('Register error:', e)
        res.writeHead(400)
        res.end('Error')
      }
    })
    return
  }

  if (req.method === 'POST' && req.url === '/wake') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const { deviceId } = JSON.parse(body)
        // get token from Firebase database!!
        const snapshot = await db.ref(`devices/${deviceId}`).once('value')
        const device = snapshot.val()

        if (!device) {
          console.log(`Device not found: ${deviceId}`)
          res.writeHead(404)
          res.end('Device not found')
          return
        }

        // send FCM wake!!
        await admin.messaging().send({
          token: device.fcmToken,
          data: { action: 'wake', deviceId },
          android: {
            priority: 'high',
            ttl: 30000
          }
        })

        console.log(`Wake sent to: ${deviceId}`)
        res.writeHead(200)
        res.end('Wake sent!!')
      } catch(e) {
        console.log('Wake error:', e)
        res.writeHead(500)
        res.end('Error: ' + e.message)
      }
    })
    return
  }

  if (req.method === 'POST' && req.url === '/devices') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const { deviceId } = JSON.parse(body)
        const snapshot = await db.ref(`devices/${deviceId}`).once('value')
        const device = snapshot.val()
        res.writeHead(200)
        res.end(JSON.stringify({ found: !!device }))
      } catch(e) {
        res.writeHead(400)
        res.end('Error')
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

const wss = new WebSocket.Server({ server, maxPayload: 10 * 1024 * 1024 })
const rooms = {}

wss.on('connection', (ws) => {
  let currentRoom = null
  let currentRole = null

  console.log('New connection!!')

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      if (currentRoom && rooms[currentRoom]?.controller) {
        try {
          rooms[currentRoom].controller.send(message, { binary: true })
        } catch(e) {
          console.log('Frame send error:', e)
        }
      }
      return
    }

    let data
    try {
      data = JSON.parse(message.toString())
    } catch(e) {
      console.log('Parse error:', e)
      return
    }

    console.log('Message:', data.type, 'from:', currentRole, 'room:', currentRoom)

    if (data.type === 'join') {
      currentRoom = data.room
      currentRole = data.role
      if (!rooms[currentRoom]) {
        rooms[currentRoom] = { host: null, controller: null }
      }
      rooms[currentRoom][currentRole] = ws
      console.log(`${currentRole} joined room ${currentRoom}`)
      const other = currentRole === 'host' ? 'controller' : 'host'
      if (rooms[currentRoom][other]) {
        console.log('Both peers here!! Notifying!!')
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-joined', role: currentRole }))
        ws.send(JSON.stringify({ type: 'peer-joined', role: other }))
      }
    }

    else if (data.type === 'offer') {
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data))
      }
    }

    else if (data.type === 'answer') {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data))
      }
    }

    else if (data.type === 'ice') {
      const other = currentRole === 'host' ? 'controller' : 'host'
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data))
      }
    }

    else if (data.type === 'dimensions') {
      if (rooms[currentRoom]?.controller) {
        rooms[currentRoom].controller.send(JSON.stringify(data))
      }
    }

    else if (data.type === 'mode') {
      const other = currentRole === 'host' ? 'controller' : 'host'
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify(data))
      }
    }

    else if (data.type === 'touch' || data.type === 'keyboard' ||
             data.type === 'system' || data.type === 'swipe' ||
             data.type === 'scroll' || data.type === 'longpress') {
      if (rooms[currentRoom]?.host) {
        rooms[currentRoom].host.send(JSON.stringify(data))
      }
    }
  })

  ws.on('close', () => {
    console.log(`${currentRole} left room ${currentRoom}`)
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom][currentRole]
      const other = currentRole === 'host' ? 'controller' : 'host'
      if (rooms[currentRoom]?.[other]) {
        rooms[currentRoom][other].send(JSON.stringify({ type: 'peer-left' }))
      }
    }
  })

  ws.on('error', (err) => {
    console.log('Error:', err)
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`Server running on port ${PORT}`))
