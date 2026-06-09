import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4173);
const ROOM_TTL_MS = 10 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/signal" });
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: 0
}));

app.use("/vendor/jszip.min.js", express.static(path.join(__dirname, "node_modules", "jszip", "dist", "jszip.min.js"), {
  maxAge: 0
}));

app.get("/api/rooms", (req, res) => {
  const roomId = createRoom();
  const origin = getPublicOrigin(req);
  const pairUrl = `${origin}/receive/${encodeURIComponent(roomId)}`;

  QRCode.toDataURL(pairUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280
  }).then((qr) => {
    res.json({
      roomId,
      pairUrl,
      qr,
      expiresAt: rooms.get(roomId).expiresAt
    });
  }).catch((error) => {
    res.status(500).json({ error: error.message });
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get("/receive/:roomId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

wss.on("connection", (socket) => {
  let currentRoomId = null;
  let currentPeerId = null;

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "error", message: "Invalid signaling message." });
      return;
    }

    if (message.type === "join") {
      const room = rooms.get(message.roomId);
      if (!room || room.expiresAt < Date.now()) {
        rooms.delete(message.roomId);
        send(socket, { type: "error", message: "Pairing session expired. Start a new transfer." });
        socket.close();
        return;
      }

      if (room.peers.size >= 2 && !room.peers.has(message.peerId)) {
        send(socket, { type: "error", message: "Pairing session is already full." });
        socket.close();
        return;
      }

      currentRoomId = message.roomId;
      currentPeerId = message.peerId || crypto.randomUUID();
      room.peers.set(currentPeerId, socket);
      room.expiresAt = Date.now() + ROOM_TTL_MS;

      send(socket, {
        type: "joined",
        roomId: currentRoomId,
        peerId: currentPeerId,
        peerCount: room.peers.size,
        expiresAt: room.expiresAt
      });
      broadcast(room, currentPeerId, { type: "peer-joined", peerId: currentPeerId, peerCount: room.peers.size });
      return;
    }

    if (!currentRoomId || !currentPeerId) {
      send(socket, { type: "error", message: "Join a room before sending signaling data." });
      return;
    }

    const room = rooms.get(currentRoomId);
    if (!room) {
      send(socket, { type: "error", message: "Pairing session no longer exists." });
      return;
    }

    if (message.type === "signal") {
      const target = room.peers.get(message.to);
      if (!target) {
        send(socket, { type: "error", message: "The other device disconnected." });
        return;
      }
      send(target, {
        type: "signal",
        from: currentPeerId,
        data: message.data
      });
    }
  });

  socket.on("close", () => {
    if (!currentRoomId || !currentPeerId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.peers.delete(currentPeerId);
    broadcast(room, currentPeerId, { type: "peer-left", peerId: currentPeerId, peerCount: room.peers.size });
    if (room.peers.size === 0) {
      rooms.delete(currentRoomId);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.expiresAt < now && room.peers.size === 0) rooms.delete(roomId);
  }
}, 60_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  const urls = getLocalUrls(PORT);
  console.log(`Seamless File Transfer is running on http://localhost:${PORT}`);
  for (const url of urls) console.log(`LAN URL: ${url}`);
});

function createRoom() {
  const roomId = crypto.randomBytes(4).toString("hex").toUpperCase();
  rooms.set(roomId, {
    expiresAt: Date.now() + ROOM_TTL_MS,
    peers: new Map()
  });
  return roomId;
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(room, excludePeerId, message) {
  for (const [peerId, peerSocket] of room.peers.entries()) {
    if (peerId !== excludePeerId) send(peerSocket, message);
  }
}

function getPublicOrigin(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = proto || req.protocol || "http";
  const host = req.get("host");
  const [hostname, port] = host.split(":");

  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    const lanAddress = getPreferredLanAddress();
    if (lanAddress) {
      return `${protocol}://${lanAddress}${port ? `:${port}` : ""}`;
    }
  }

  return `${protocol}://${host}`;
}

function getLocalUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const values of Object.values(nets)) {
    for (const net of values || []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

function getPreferredLanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const [name, values] of Object.entries(nets)) {
    for (const net of values || []) {
      if (net.family === "IPv4" && !net.internal) {
        const score = /wi-?fi|wlan|ethernet/i.test(name) ? 0 : 1;
        candidates.push({ address: net.address, score });
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.address;
}
