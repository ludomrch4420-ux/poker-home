/**
 * index.js — Cloudflare Worker : PokerHome Texas Hold'em
 * 
 * Tout-en-un : WebSocket + logique de jeu + fichiers statiques
 * Utilise le support WebSocket natif de Cloudflare Workers
 */

// ═══════════════════════════════════════════════════════════
//  DECK
// ═══════════════════════════════════════════════════════════

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function deal(deck, n) {
  return deck.splice(0, n);
}

function createShuffledDeck() {
  return shuffle(createDeck());
}

// ═══════════════════════════════════════════════════════════
//  HAND EVALUATION
// ═══════════════════════════════════════════════════════════

const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

function cardValue(card) {
  return RANK_VALUES[card.rank] || 0;
}

function countByValue(cards) {
  const counts = new Map();
  for (const c of cards) {
    const v = cardValue(c);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

function countBySuit(cards) {
  const counts = new Map();
  for (const c of cards) {
    counts.set(c.suit, (counts.get(c.suit) || 0) + 1);
  }
  return counts;
}

function isStraight(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length < 5) return { is: false };

  if (sorted.includes(14) && sorted.includes(2) && sorted.includes(3) && sorted.includes(4) && sorted.includes(5)) {
    return { is: true, high: 5 };
  }

  for (let i = sorted.length - 1; i >= 4; i--) {
    if (sorted[i] - sorted[i - 4] === 4) {
      let consecutive = true;
      for (let j = i - 4; j < i; j++) {
        if (sorted[j + 1] - sorted[j] !== 1) { consecutive = false; break; }
      }
      if (consecutive) return { is: true, high: sorted[i] };
    }
  }
  return { is: false };
}

function isFlush(cards) {
  const suitCounts = countBySuit(cards);
  for (const [suit, count] of suitCounts) {
    if (count >= 5) {
      return { is: true, suit, cards: cards.filter(c => c.suit === suit) };
    }
  }
  return { is: false };
}

function evaluateHand(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  const values = allCards.map(cardValue);
  const counts = countByValue(allCards);

  const byCount = new Map();
  for (const [val, cnt] of counts) {
    if (!byCount.has(cnt)) byCount.set(cnt, []);
    byCount.get(cnt).push(val);
  }
  for (const [cnt, vals] of byCount) {
    vals.sort((a, b) => b - a);
  }

  const flushResult = isFlush(allCards);
  const straightResult = isStraight(values);

  if (flushResult.is && straightResult.is) {
    const suitedValues = flushResult.cards.map(cardValue);
    const suitedStraight = isStraight(suitedValues);
    if (suitedStraight.is && suitedStraight.high === 14) {
      return { rank: 9, name: 'Quinte flush royale', values: [14] };
    }
    if (suitedStraight.is) {
      return { rank: 8, name: 'Quinte flush', values: [suitedStraight.high] };
    }
  }

  if (byCount.has(4)) {
    const quadVal = byCount.get(4)[0];
    const kicker = values.filter(v => v !== quadVal).sort((a, b) => b - a)[0];
    return { rank: 7, name: 'Carré', values: [quadVal, kicker] };
  }

  if (byCount.has(3) && byCount.has(2)) {
    return { rank: 6, name: 'Full', values: [byCount.get(3)[0], byCount.get(2)[0]] };
  }
  if (byCount.has(3) && byCount.get(3).length >= 2) {
    const trips = byCount.get(3).sort((a, b) => b - a);
    return { rank: 6, name: 'Full', values: [trips[0], trips[1]] };
  }

  if (flushResult.is) {
    const suitedValues = flushResult.cards.map(cardValue).sort((a, b) => b - a).slice(0, 5);
    return { rank: 5, name: 'Couleur', values: suitedValues };
  }

  if (straightResult.is) {
    return { rank: 4, name: 'Suite', values: [straightResult.high] };
  }

  if (byCount.has(3)) {
    const tripVal = byCount.get(3)[0];
    const kickers = values.filter(v => v !== tripVal).sort((a, b) => b - a).slice(0, 2);
    return { rank: 3, name: 'Brelan', values: [tripVal, ...kickers] };
  }

  if (byCount.has(2) && byCount.get(2).length >= 2) {
    const pairs = byCount.get(2).sort((a, b) => b - a).slice(0, 2);
    const kicker = values.filter(v => !pairs.includes(v)).sort((a, b) => b - a)[0];
    return { rank: 2, name: 'Double paire', values: [...pairs, kicker] };
  }

  if (byCount.has(2)) {
    const pairVal = byCount.get(2)[0];
    const kickers = values.filter(v => v !== pairVal).sort((a, b) => b - a).slice(0, 3);
    return { rank: 1, name: 'Paire', values: [pairVal, ...kickers] };
  }

  const sorted = [...values].sort((a, b) => b - a).slice(0, 5);
  return { rank: 0, name: 'Carte haute', values: sorted };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.values.length, b.values.length); i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

function findWinners(players, communityCards) {
  const activePlayers = players
    .map((p, i) => ({ ...p, index: i }))
    .filter(p => !p.folded && p.cards.length === 2);

  if (activePlayers.length === 0) return [];
  if (activePlayers.length === 1) return [activePlayers[0].index];

  const evaluated = activePlayers.map(p => ({
    index: p.index,
    hand: evaluateHand(p.cards, communityCards),
  }));

  evaluated.sort((a, b) => compareHands(b.hand, a.hand));
  const best = evaluated[0];
  const winners = evaluated.filter(e => compareHands(e.hand, best.hand) === 0);
  return winners.map(w => w.index);
}

// ═══════════════════════════════════════════════════════════
//  GAME ROOM
// ═══════════════════════════════════════════════════════════

const DEFAULTS = {
  smallBlind: 5,
  bigBlind: 10,
  startingStack: 1000,
  turnTimer: 20000,
  maxPlayers: 6,
};

function createPlayer(id, name, stack) {
  return {
    id, name,
    stack: stack || DEFAULTS.startingStack,
    cards: [], bet: 0, totalBet: 0,
    folded: false, allIn: false,
    isDealer: false, isConnected: true,
  };
}

class GameRoom {
  constructor(code, settings = {}) {
    this.code = code;
    this.settings = { ...DEFAULTS, ...settings };
    this.players = [];
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.phase = 'waiting';
    this.dealerIndex = -1;
    this.currentPlayerIndex = -1;
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.actionTimer = null;
    this.hostId = null;
  }

  getData(forPlayerId = null) {
    return {
      code: this.code,
      phase: this.phase,
      pot: this.pot,
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      startingStack: this.settings.startingStack,
      turnTimer: this.settings.turnTimer,
      communityCards: this.communityCards,
      currentBet: this.currentBet,
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      players: this.players.map(p => ({
        id: p.id, name: p.name, stack: p.stack, bet: p.bet,
        folded: p.folded, allIn: p.allIn, isDealer: p.isDealer,
        isMe: p.id === forPlayerId,
        cards: (p.id === forPlayerId || this.phase === 'showdown')
          ? p.cards
          : (p.cards.length > 0 ? [{ rank: '?', suit: '?' }, { rank: '?', suit: '?' }] : []),
      })),
    };
  }

  addPlayer(id, name) {
    if (this.players.length >= this.settings.maxPlayers) return { error: `Room pleine (max ${this.settings.maxPlayers})` };
    if (this.phase !== 'waiting') return { error: 'Partie déjà en cours' };
    if (this.players.find(p => p.id === id)) return { error: 'Déjà dans la room' };

    const player = createPlayer(id, name, this.settings.startingStack);
    this.players.push(player);

    if (this.players.length === 1) {
      player.isDealer = true;
      this.dealerIndex = 0;
      this.hostId = id;
    }

    return { player, roomData: this.getData() };
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return null;

    const player = this.players[idx];
    this.players.splice(idx, 1);

    if (this.phase === 'waiting') {
      if (this.players.length === 0) {
        this.dealerIndex = -1;
        this.hostId = null;
      } else if (idx === this.dealerIndex) {
        this.dealerIndex = 0;
        this.players[0].isDealer = true;
        this.hostId = this.players[0].id;
      } else if (this.dealerIndex >= this.players.length) {
        this.dealerIndex = 0;
        this.players[0].isDealer = true;
        this.hostId = this.players[0].id;
      }
    } else {
      player.folded = true;
      player.isConnected = false;
      if (this.currentPlayerIndex === idx) {
        this.nextPlayer();
      } else if (this.currentPlayerIndex > idx) {
        this.currentPlayerIndex--;
      }
    }

    return this.getData();
  }

  startGame() {
    if (this.players.length < 2) return { error: 'Il faut au moins 2 joueurs' };
    if (this.phase !== 'waiting') return { error: 'Partie déjà en cours' };
    this.dealCards();
    return { roomData: this.getData() };
  }

  dealCards() {
    this.deck = createShuffledDeck();
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;

    for (const p of this.players) {
      p.cards = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false;
    }

    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    this.players.forEach((p, i) => { p.isDealer = (i === this.dealerIndex); });

    for (const p of this.players) { p.cards = deal(this.deck, 2); }

    const sbIndex = (this.dealerIndex + 1) % this.players.length;
    const bbIndex = (this.dealerIndex + 2) % this.players.length;

    this._placeBet(this.players[sbIndex], this.settings.smallBlind);
    this._placeBet(this.players[bbIndex], this.settings.bigBlind);

    this.currentBet = this.settings.bigBlind;
    this.phase = 'preflop';
    this.currentPlayerIndex = (bbIndex + 1) % this.players.length;
    this._skipPlayersWhoCantAct();
    this._startTimer();
  }

  _placeBet(player, amount) {
    const actualBet = Math.min(amount, player.stack);
    player.stack -= actualBet;
    player.bet += actualBet;
    player.totalBet += actualBet;
    this.pot += actualBet;
    if (player.stack === 0) player.allIn = true;
  }

  _nextActivePlayer() {
    let idx = this.currentPlayerIndex;
    let looped = false;
    while (true) {
      idx = (idx + 1) % this.players.length;
      if (idx === this.currentPlayerIndex) { if (looped) return -1; looped = true; }
      const p = this.players[idx];
      if (!p.folded && !p.allIn) return idx;
    }
  }

  _skipPlayersWhoCantAct() {
    const p = this.players[this.currentPlayerIndex];
    if (p.folded || p.allIn) { this.currentPlayerIndex = this._nextActivePlayer(); }
  }

  nextPlayer() {
    this._clearTimer();
    const next = this._nextActivePlayer();
    const activePlayers = this.players.filter(p => !p.folded);
    const nonAllIn = activePlayers.filter(p => !p.allIn);
    const allMatched = nonAllIn.every(p => p.bet === this.currentBet);
    const allActed = nonAllIn.length <= 1;

    if (next === -1 || next === this.currentPlayerIndex || (allMatched && allActed)) {
      this._endPhase();
      return;
    }
    this.currentPlayerIndex = next;
    this._startTimer();
  }

  _endPhase() {
    for (const p of this.players) { p.bet = 0; p.totalBet = 0; }
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;

    const activePlayers = this.players.filter(p => !p.folded);
    if (activePlayers.length <= 1) { this._declareWinner(activePlayers); return; }

    const phases = ['preflop', 'flop', 'turn', 'river'];
    const currentIdx = phases.indexOf(this.phase);
    if (currentIdx === -1) { this._showdown(); return; }

    const nextPhase = phases[currentIdx + 1];
    if (nextPhase === 'flop') {
      this.communityCards = deal(this.deck, 3);
    } else {
      this.communityCards.push(...deal(this.deck, 1));
    }

    this.phase = nextPhase;
    this.currentPlayerIndex = this._firstAfterDealer();
    this._skipPlayersWhoCantAct();
    this._startTimer();
  }

  _firstAfterDealer() {
    if (this.players.length === 0) return -1;
    let idx = (this.dealerIndex + 1) % this.players.length;
    let looped = false;
    while (true) {
      if (!this.players[idx].folded && !this.players[idx].allIn) return idx;
      idx = (idx + 1) % this.players.length;
      if (idx === this.dealerIndex + 1) { if (looped) return this.dealerIndex; looped = true; }
    }
  }

  _showdown() {
    this.phase = 'showdown';
    this._clearTimer();
    const winners = findWinners(this.players, this.communityCards);
    if (winners.length === 1) {
      this.players[winners[0]].stack += this.pot;
    } else if (winners.length > 1) {
      const share = Math.floor(this.pot / winners.length);
      for (const idx of winners) { this.players[idx].stack += share; }
    }
    this.pot = 0;
  }

  _declareWinner(remaining) {
    this.phase = 'showdown';
    this._clearTimer();
    if (remaining.length === 1) { remaining[0].stack += this.pot; }
    this.pot = 0;
  }

  nextHand() {
    if (this.phase !== 'showdown') return { error: 'La partie n\'est pas terminée' };
    this.players = this.players.filter(p => p.stack > 0);
    if (this.players.length < 2) {
      this.phase = 'waiting';
      return { roomData: this.getData(), message: 'Pas assez de joueurs' };
    }
    this.dealCards();
    return { roomData: this.getData() };
  }

  fold(playerId) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };
    p.folded = true;
    this.nextPlayer();
    return { action: 'fold', player: p.name, roomData: this.getData() };
  }

  check(playerId) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };
    if (p.bet < this.currentBet) return { error: 'Tu ne peux pas checker' };
    this.nextPlayer();
    return { action: 'check', player: p.name, roomData: this.getData() };
  }

  call(playerId) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    this._placeBet(p, toCall);
    this.nextPlayer();
    return { action: 'call', player: p.name, amount: toCall, roomData: this.getData() };
  }

  raise(playerId, amount) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };
    const minAmount = this.currentBet + this.minRaise;
    if (amount < minAmount) return { error: `Relance minimum : ${minAmount}` };
    if (amount > p.stack + p.bet) return { error: 'Pas assez de jetons' };
    const toAdd = amount - p.bet;
    this.minRaise = amount - this.currentBet;
    this.currentBet = amount;
    this._placeBet(p, toAdd);
    this.nextPlayer();
    return { action: 'raise', player: p.name, amount, roomData: this.getData() };
  }

  _validateTurn(playerId) {
    if (this.currentPlayerIndex < 0 || this.currentPlayerIndex >= this.players.length) return null;
    const p = this.players[this.currentPlayerIndex];
    if (p.id !== playerId) return null;
    if (p.folded || p.allIn) return null;
    return p;
  }

  _startTimer() {
    this._clearTimer();
    this.actionTimer = setTimeout(() => {
      const p = this.players[this.currentPlayerIndex];
      if (p && p.id) { this.fold(p.id); }
    }, this.settings.turnTimer);
  }

  _clearTimer() {
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null; }
  }
}

// ═══════════════════════════════════════════════════════════
//  ROOMS REGISTRY
// ═══════════════════════════════════════════════════════════

const rooms = new Map();

function getOrCreateRoom(code, settings) {
  if (!rooms.has(code)) {
    rooms.set(code, new GameRoom(code, settings));
  }
  return rooms.get(code);
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (room && room.players.length === 0) {
    room._clearTimer();
    rooms.delete(code);
  }
}

// ═══════════════════════════════════════════════════════════
//  CONNECTIONS STORE
// ═══════════════════════════════════════════════════════════

const connections = new Map(); // playerId → WebSocket
const playerRooms = new Map(); // playerId → { room, code }

function send(ws, data) {
  try { ws.send(JSON.stringify(data)); } catch {}
}

function broadcastToRoom(code, data, excludeId = null) {
  const room = rooms.get(code);
  if (!room) return;
  for (const p of room.players) {
    if (p.id === excludeId) continue;
    const conn = connections.get(p.id);
    if (conn) send(conn, data);
  }
}

function notifyTurn(room) {
  const p = room.players[room.currentPlayerIndex];
  if (p) {
    const conn = connections.get(p.id);
    if (conn) send(conn, { type: 'yourTurn', currentBet: room.currentBet, minRaise: room.currentBet + room.minRaise });
  }
}

// ═══════════════════════════════════════════════════════════
//  WEBSOCKET HANDLER (Cloudflare Workers format)
// ═══════════════════════════════════════════════════════════

function handleWebSocket(webSocket, earlyDataHeader) {
  const playerId = crypto.randomUUID();
  let currentRoom = null;
  let currentCode = null;

  // Accept the WebSocket using Cloudflare's native API
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  
  // Register connection
  connections.set(playerId, server);

  server.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      const type = data.type;

      if (type === 'createRoom') {
        const { name, settings } = data;
        if (!name?.trim()) {
          send(server, { type: 'error', message: 'Pseudo requis' });
          return;
        }
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        const s = {
          smallBlind: parseInt(settings?.smallBlind) || 5,
          bigBlind: parseInt(settings?.bigBlind) || 10,
          startingStack: parseInt(settings?.startingStack) || 1000,
          turnTimer: (parseInt(settings?.turnTimer) || 20) * 1000,
        };
        const room = getOrCreateRoom(code, s);
        const result = room.addPlayer(playerId, name.trim());
        if (result.error) {
          send(server, { type: 'error', message: result.error });
          return;
        }
        currentRoom = room;
        currentCode = code;
        playerRooms.set(playerId, { room, code });
        send(server, { type: 'roomJoined', code, playerId, isHost: true, roomData: room.getData(playerId) });
        console.log(`[Room ${code}] ${name} a créé la room`);
      }

      else if (type === 'joinRoom') {
        const { name, room: roomCode } = data;
        if (!name?.trim()) { send(server, { type: 'error', message: 'Pseudo requis' }); return; }
        if (!roomCode?.trim()) { send(server, { type: 'error', message: 'Code requis' }); return; }
        const code = roomCode.trim().toUpperCase();
        const room = getOrCreateRoom(code);
        const result = room.addPlayer(playerId, name.trim());
        if (result.error) { send(server, { type: 'error', message: result.error }); return; }
        currentRoom = room;
        currentCode = code;
        playerRooms.set(playerId, { room, code });
        send(server, { type: 'roomJoined', code, playerId, isHost: false, roomData: room.getData(playerId) });
        broadcastToRoom(code, { type: 'gameState', roomData: room.getData() }, playerId);
        console.log(`[Room ${code}] ${name} a rejoint`);
      }

      else if (type === 'startGame') {
        if (!currentRoom) { send(server, { type: 'error', message: 'Pas dans une room' }); return; }
        const result = currentRoom.startGame();
        if (result.error) { send(server, { type: 'error', message: result.error }); return; }
        for (const p of currentRoom.players) {
          const conn = connections.get(p.id);
          if (conn) send(conn, { type: 'gameState', roomData: currentRoom.getData(p.id) });
        }
        notifyTurn(currentRoom);
        console.log(`[Room ${currentCode}] Partie démarrée`);
      }

      else if (type === 'playerAction') {
        if (!currentRoom) { send(server, { type: 'error', message: 'Pas dans une room' }); return; }
        const { action, amount } = data;
        let result;
        switch (action) {
          case 'fold': result = currentRoom.fold(playerId); break;
          case 'check': result = currentRoom.check(playerId); break;
          case 'call': result = currentRoom.call(playerId); break;
          case 'raise': result = currentRoom.raise(playerId, amount); break;
          default: send(server, { type: 'error', message: 'Action inconnue' }); return;
        }
        if (result.error) { send(server, { type: 'error', message: result.error }); return; }
        broadcastToRoom(currentCode, { type: 'actionLog', player: result.player, action: result.action, amount: result.amount || 0 });
        for (const p of currentRoom.players) {
          const conn = connections.get(p.id);
          if (conn) send(conn, { type: 'gameState', roomData: currentRoom.getData(p.id) });
        }
        if (currentRoom.phase === 'showdown') {
          broadcastToRoom(currentCode, { type: 'showdown', roomData: currentRoom.getData() });
        } else {
          notifyTurn(currentRoom);
        }
      }

      else if (type === 'nextHand') {
        if (!currentRoom) return;
        const result = currentRoom.nextHand();
        if (result.error) { send(server, { type: 'error', message: result.error }); return; }
        for (const p of currentRoom.players) {
          const conn = connections.get(p.id);
          if (conn) send(conn, { type: 'gameState', roomData: currentRoom.getData(p.id) });
        }
        if (currentRoom.phase !== 'waiting') { notifyTurn(currentRoom); }
      }

      else if (type === 'leaveRoom') {
        if (!currentRoom) return;
        currentRoom.removePlayer(playerId);
        broadcastToRoom(currentCode, { type: 'gameState', roomData: currentRoom.getData() });
        cleanupRoom(currentCode);
        currentRoom = null;
        currentCode = null;
      }

    } catch (err) {
      console.error('WebSocket error:', err);
      send(server, { type: 'error', message: 'Erreur serveur' });
    }
  });

  server.addEventListener('close', () => {
    connections.delete(playerId);
    if (currentRoom) {
      currentRoom.removePlayer(playerId);
      if (currentCode) {
        broadcastToRoom(currentCode, { type: 'gameState', roomData: currentRoom.getData() });
        cleanupRoom(currentCode);
      }
    }
    playerRooms.delete(playerId);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: earlyDataHeader ? { 'sec-websocket-protocol': earlyDataHeader } : {},
  });
}

// ═══════════════════════════════════════════════════════════
//  MAIN EXPORT
// ═══════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
      return handleWebSocket(null, earlyDataHeader);
    }

    // Static files via assets binding
    return env.ASSETS.fetch(request);
  },
};
