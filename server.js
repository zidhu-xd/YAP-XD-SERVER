const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://<user>:<pass>@cluster.mongodb.net/secretcalc';
const JWT_SECRET = process.env.JWT_SECRET || 'secretcalc_jwt_secret_change_in_prod';
const PORT = process.env.PORT || 3000;

// Voice upload dir
const VOICE_DIR = path.join(__dirname, 'uploads', 'voice');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: VOICE_DIR,
  filename: (_, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(err => console.error('MongoDB error:', err));

// Serve uploaded voice files
app.use('/uploads/voice', express.static(VOICE_DIR));

// ─── Schemas ───────────────────────────────────────────────────────────────────

const PairingCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  deviceId: { type: String, required: true },
  roomId: { type: String },
  paired: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

const RoomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  devices: [String],
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  senderId: { type: String, required: true },
  content: { type: String, required: true },
  type: { type: String, default: 'text' },      // 'text' | 'voice'
  voiceUrl: { type: String },
  voiceDuration: { type: Number, default: 0 },
  replyTo: {
    messageId: String,
    content: String,
    senderId: String
  },
  read: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});

const PairingCode = mongoose.model('PairingCode', PairingCodeSchema);
const Room = mongoose.model('Room', RoomSchema);
const Message = mongoose.model('Message', MessageSchema);

// ─── Auth middleware ───────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── REST Routes ──────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// Generate pairing code
app.post('/api/pairing/generate', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await PairingCode.deleteMany({ deviceId, paired: false });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const roomId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await new PairingCode({ code, deviceId, roomId, expiresAt }).save();
    res.json({ code, expiresAt, roomId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Enter pairing code
app.post('/api/pairing/enter', async (req, res) => {
  try {
    const { code, deviceId } = req.body;
    if (!code || !deviceId) return res.status(400).json({ error: 'code and deviceId required' });

    const pairing = await PairingCode.findOne({ code, paired: false });
    if (!pairing) return res.status(404).json({ error: 'Code not found or already used' });
    if (new Date() > pairing.expiresAt) {
      await PairingCode.deleteOne({ _id: pairing._id });
      return res.status(410).json({ error: 'Code expired' });
    }
    if (pairing.deviceId === deviceId) return res.status(400).json({ error: 'Cannot pair with yourself' });

    pairing.paired = true;
    await pairing.save();

    await new Room({ roomId: pairing.roomId, devices: [pairing.deviceId, deviceId] }).save();

    const token1 = jwt.sign({ deviceId: pairing.deviceId, roomId: pairing.roomId }, JWT_SECRET);
    const token2 = jwt.sign({ deviceId, roomId: pairing.roomId }, JWT_SECRET);

    io.to(pairing.deviceId).emit('paired', { roomId: pairing.roomId, token: token1 });
    res.json({ roomId: pairing.roomId, token: token2 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify token
app.post('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, roomId: req.user.roomId, deviceId: req.user.deviceId });
});

// Get messages
app.get('/api/messages/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    if (roomId !== req.user.roomId) return res.status(403).json({ error: 'Forbidden' });
    const messages = await Message.find({ roomId }).sort({ timestamp: 1 }).limit(500);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear messages
app.delete('/api/messages/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    if (roomId !== req.user.roomId) return res.status(403).json({ error: 'Forbidden' });
    await Message.deleteMany({ roomId });
    io.to(roomId).emit('chat_cleared');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload voice note
app.post('/api/voice/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `${process.env.BASE_URL || `https://yap-xd-server-production.up.railway.app`}/uploads/voice/${req.file.filename}`;
  res.json({ url });
});

// Unpair
app.post('/api/pairing/unpair', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.user;
    await Room.deleteOne({ roomId });
    await Message.deleteMany({ roomId });
    await PairingCode.deleteMany({ roomId });
    io.to(roomId).emit('unpaired');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

const socketRooms = new Map();

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('register_device', (deviceId) => {
    socket.join(deviceId);
  });

  socket.on('join_room', ({ roomId, token }) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (user.roomId !== roomId) return socket.emit('error', 'Invalid room');
      socket.join(roomId);
      socketRooms.set(socket.id, { deviceId: user.deviceId, roomId });
      socket.to(roomId).emit('peer_online', { deviceId: user.deviceId });
    } catch {
      socket.emit('error', 'Auth failed');
    }
  });

  socket.on('send_message', async ({ content, type = 'text', voiceUrl, voiceDuration, replyTo }, callback) => {
    const ctx = socketRooms.get(socket.id);
    if (!ctx) return;

    try {
      const msg = new Message({
        roomId: ctx.roomId,
        senderId: ctx.deviceId,
        content,
        type,
        voiceUrl: voiceUrl || undefined,
        voiceDuration: voiceDuration || 0,
        replyTo: replyTo || undefined
      });
      await msg.save();

      const payload = {
        _id: msg._id,
        roomId: msg.roomId,
        senderId: msg.senderId,
        content: msg.content,
        type: msg.type,
        voiceUrl: msg.voiceUrl,
        voiceDuration: msg.voiceDuration,
        replyTo: msg.replyTo,
        read: msg.read,
        timestamp: msg.timestamp
      };

      io.to(ctx.roomId).emit('new_message', payload);
      if (callback) callback({ success: true, messageId: msg._id });
    } catch (err) {
      console.error(err);
      if (callback) callback({ success: false });
    }
  });

  socket.on('message_read', async ({ messageId }) => {
    const ctx = socketRooms.get(socket.id);
    if (!ctx) return;
    await Message.updateOne({ _id: messageId }, { read: true });
    socket.to(ctx.roomId).emit('message_read', { messageId });
  });

  socket.on('disconnect', () => {
    const ctx = socketRooms.get(socket.id);
    if (ctx) {
      socket.to(ctx.roomId).emit('peer_offline', { deviceId: ctx.deviceId });
      socketRooms.delete(socket.id);
    }
  });
});

server.listen(PORT, () => console.log(`SecretCalc server running on port ${PORT}`));
