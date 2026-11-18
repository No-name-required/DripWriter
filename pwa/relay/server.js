/* DripWriter mobile companion relay.
   Serves the PWA and relays DW_* messages between the phone and the
   browser extension bridge. Run: node relay/server.js  (PORT=8787) */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const PWA_ROOT = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  const file = path.join(PWA_ROOT, pathname);
  if (!file.startsWith(PWA_ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map();

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code, { pwa: new Set(), bridge: new Set() });
  return rooms.get(code);
}

function presence(room) {
  return {
    type: "DW_PRESENCE",
    bridge: room.bridge.size > 0,
    pwa: room.pwa.size > 0
  };
}

function broadcast(room, role, message) {
  const targets = role === "bridge" ? room.bridge : room.pwa;
  const raw = JSON.stringify(message);
  for (const client of targets) {
    if (client.readyState === 1) client.send(raw);
  }
}

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("code") || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
  const role = url.searchParams.get("role") === "bridge" ? "bridge" : "pwa";
  if (!code) {
    socket.close(1008, "missing code");
    return;
  }

  const room = roomFor(code);
  room[role].add(socket);
  socket.send(JSON.stringify({ type: "DW_WELCOME", role, code, ...presence(room) }));
  broadcast(room, role === "bridge" ? "pwa" : "bridge", presence(room));

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== "string") return;
    // Echo only to the opposite role; the sender already knows what it sent.
    broadcast(room, role === "bridge" ? "pwa" : "bridge", message);
  });

  socket.on("close", () => {
    room[role].delete(socket);
    broadcast(room, role === "bridge" ? "pwa" : "bridge", presence(room));
    if (!room.bridge.size && !room.pwa.size) rooms.delete(code);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DripWriter relay + PWA listening on http://0.0.0.0:${PORT}`);
  console.log("Phone: open http://<this-computer-LAN-IP>:8787");
  console.log("Laptop: open chrome-extension://<id>/bridge.html and connect with the same code");
});
