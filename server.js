/**
 * server.js — Serveur Express + Socket.IO pour PokerHome
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { initSocketHandlers } = require('./clients');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// ─── Fichiers statiques ───────────────────────────────────
app.use(express.static(path.join(__dirname)));

// Route principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Socket.IO ────────────────────────────────────────────
initSocketHandlers(io);

// ─── Démarrage ────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  🃏 PokerHome — Texas Hold\'em en ligne');
  console.log(`  🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log('');
});
