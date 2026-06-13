/**
 * clients.js — Gestion des connexions Socket.IO côté serveur
 */

const { GameRoom } = require('./game/gameroom');

// Map des rooms actives : code → GameRoom
const rooms = new Map();

/**
 * Retourne ou crée une room
 */
function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, new GameRoom(code));
  }
  return rooms.get(code);
}

/**
 * Supprime une room vide
 */
function cleanupRoom(code) {
  const room = rooms.get(code);
  if (room && room.players.length === 0) {
    room._clearTimer();
    rooms.delete(code);
  }
}

/**
 * Initialise la gestion Socket.IO
 * @param {SocketIO.Server} io
 */
function initSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[Socket] Connecté : ${socket.id}`);

    let currentRoom = null;
    let currentPlayerId = socket.id;

    // ─── Créer une room ───────────────────────────────────
    socket.on('createRoom', ({ name }) => {
      if (!name || !name.trim()) {
        socket.emit('error', { message: 'Pseudo requis' });
        return;
      }

      // Génère un code aléatoire de 6 caractères
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const room = getOrCreateRoom(code);

      const result = room.addPlayer(currentPlayerId, name.trim());
      if (result.error) {
        socket.emit('error', { message: result.error });
        return;
      }

      currentRoom = room;
      socket.join(code);

      socket.emit('roomJoined', {
        code,
        playerId: currentPlayerId,
        roomData: room.getData(currentPlayerId),
      });

      console.log(`[Room ${code}] ${name} a créé la room`);
    });

    // ─── Rejoindre une room ───────────────────────────────
    socket.on('joinRoom', ({ name, room: roomCode }) => {
      if (!name || !name.trim()) {
        socket.emit('error', { message: 'Pseudo requis' });
        return;
      }
      if (!roomCode || !roomCode.trim()) {
        socket.emit('error', { message: 'Code de salle requis' });
        return;
      }

      const code = roomCode.trim().toUpperCase();
      const room = getOrCreateRoom(code);

      const result = room.addPlayer(currentPlayerId, name.trim());
      if (result.error) {
        socket.emit('error', { message: result.error });
        return;
      }

      currentRoom = room;
      socket.join(code);

      socket.emit('roomJoined', {
        code,
        playerId: currentPlayerId,
        roomData: room.getData(currentPlayerId),
      });

      // Notifier les autres joueurs
      socket.to(code).emit('roomJoined', {
        code,
        playerId: null,
        roomData: room.getData(),
      });

      console.log(`[Room ${code}] ${name} a rejoint la room`);
    });

    // ─── Démarrer la partie ───────────────────────────────
    socket.on('startGame', () => {
      if (!currentRoom) {
        socket.emit('error', { message: 'Tu n\'es dans aucune room' });
        return;
      }

      const result = currentRoom.startGame();
      if (result.error) {
        socket.emit('error', { message: result.error });
        return;
      }

      // Envoyer l'état à tous les joueurs
      for (const player of currentRoom.players) {
        io.to(player.id).emit('gameState', currentRoom.getData(player.id));
      }

      // Notifier le joueur dont c'est le tour
      const currentPlayer = currentRoom.players[currentRoom.currentPlayerIndex];
      if (currentPlayer) {
        io.to(currentPlayer.id).emit('yourTurn', {
          currentBet: currentRoom.currentBet,
          minRaise: currentRoom.currentBet + currentRoom.minRaise,
        });
      }

      console.log(`[Room ${currentRoom.code}] Partie démarrée`);
    });

    // ─── Action du joueur ─────────────────────────────────
    socket.on('playerAction', ({ type, amount }) => {
      if (!currentRoom) {
        socket.emit('error', { message: 'Tu n\'es dans aucune room' });
        return;
      }

      let result;
      switch (type) {
        case 'fold':
          result = currentRoom.fold(currentPlayerId);
          break;
        case 'check':
          result = currentRoom.check(currentPlayerId);
          break;
        case 'call':
          result = currentRoom.call(currentPlayerId);
          break;
        case 'raise':
          result = currentRoom.raise(currentPlayerId, amount);
          break;
        default:
          socket.emit('error', { message: 'Action inconnue' });
          return;
      }

      if (result.error) {
        socket.emit('error', { message: result.error });
        return;
      }

      // Notifier tout le monde de l'action
      io.to(currentRoom.code).emit('actionLog', {
        player: result.player,
        action: result.action,
        amount: result.amount || 0,
      });

      // Envoyer le nouvel état à tous les joueurs
      for (const player of currentRoom.players) {
        io.to(player.id).emit('gameState', currentRoom.getData(player.id));
      }

      // Si la partie est en showdown, proposer de relancer
      if (currentRoom.phase === 'showdown') {
        io.to(currentRoom.code).emit('showdown', {
          roomData: currentRoom.getData(),
        });
        return;
      }

      // Notifier le joueur dont c'est le tour
      const nextPlayer = currentRoom.players[currentRoom.currentPlayerIndex];
      if (nextPlayer) {
        io.to(nextPlayer.id).emit('yourTurn', {
          currentBet: currentRoom.currentBet,
          minRaise: currentRoom.currentBet + currentRoom.minRaise,
        });
      }
    });

    // ─── Nouvelle main (après showdown) ───────────────────
    socket.on('nextHand', () => {
      if (!currentRoom) return;

      const result = currentRoom.nextHand();
      if (result.error) {
        socket.emit('error', { message: result.error });
        return;
      }

      for (const player of currentRoom.players) {
        io.to(player.id).emit('gameState', currentRoom.getData(player.id));
      }

      if (currentRoom.phase !== 'waiting') {
        const currentPlayer = currentRoom.players[currentRoom.currentPlayerIndex];
        if (currentPlayer) {
          io.to(currentPlayer.id).emit('yourTurn', {
            currentBet: currentRoom.currentBet,
            minRaise: currentRoom.currentBet + currentRoom.minRaise,
          });
        }
      }
    });

    // ─── Quitter la room ──────────────────────────────────
    socket.on('leaveRoom', () => {
      if (!currentRoom) return;

      const code = currentRoom.code;
      currentRoom.removePlayer(currentPlayerId);
      socket.leave(code);

      // Notifier les autres
      socket.to(code).emit('gameState', currentRoom.getData());

      cleanupRoom(code);
      currentRoom = null;

      console.log(`[Socket] ${socket.id} a quitté la room ${code}`);
    });

    // ─── Déconnexion ──────────────────────────────────────
    socket.on('disconnect', () => {
      if (currentRoom) {
        const code = currentRoom.code;
        currentRoom.removePlayer(currentPlayerId);

        socket.to(code).emit('gameState', currentRoom.getData());
        cleanupRoom(code);

        console.log(`[Room ${code}] ${socket.id} déconnecté`);
      }
    });
  });
}

module.exports = { initSocketHandlers };
