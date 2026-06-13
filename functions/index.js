/**
 * Firebase Cloud Functions — Logique serveur PokerHome
 * 
 * Architecture :
 * - Realtime DB : synchronisation temps réel de l'état de jeu
 * - Firestore : persistance des rooms
 * - Cloud Functions : logique métier (actions, timer, showdown)
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.database();
const firestore = admin.firestore();

// ═══════════════════════════════════════════════════════════
//  DECK
// ═══════════════════════════════════════════════════════════
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return d;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function deal(deck, n) { return deck.splice(0, n); }

function createShuffledDeck() { return shuffle(createDeck()); }

// ═══════════════════════════════════════════════════════════
//  HAND EVALUATION
// ═══════════════════════════════════════════════════════════
const RV = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

function cv(c) { return RV[c.rank] || 0; }

function countByValue(cards) {
  const m = new Map();
  for (const c of cards) { const v = cv(c); m.set(v, (m.get(v) || 0) + 1); }
  return m;
}

function countBySuit(cards) {
  const m = new Map();
  for (const c of cards) { m.set(c.suit, (m.get(c.suit) || 0) + 1); }
  return m;
}

function isStraight(values) {
  const s = [...new Set(values)].sort((a, b) => a - b);
  if (s.length < 5) return { is: false };
  if (s.includes(14) && s.includes(2) && s.includes(3) && s.includes(4) && s.includes(5))
    return { is: true, high: 5 };
  for (let i = s.length - 1; i >= 4; i--) {
    if (s[i] - s[i - 4] === 4) {
      let ok = true;
      for (let j = i - 4; j < i; j++) { if (s[j + 1] - s[j] !== 1) { ok = false; break; } }
      if (ok) return { is: true, high: s[i] };
    }
  }
  return { is: false };
}

function isFlush(cards) {
  const sc = countBySuit(cards);
  for (const [suit, count] of sc) {
    if (count >= 5) return { is: true, suit, cards: cards.filter(c => c.suit === suit) };
  }
  return { is: false };
}

function evaluateHand(hole, community) {
  const all = [...hole, ...community];
  const values = all.map(cv);
  const counts = countByValue(all);
  const byCount = new Map();
  for (const [val, cnt] of counts) {
    if (!byCount.has(cnt)) byCount.set(cnt, []);
    byCount.get(cnt).push(val);
  }
  for (const [, vals] of byCount) vals.sort((a, b) => b - a);

  const fr = isFlush(all), sr = isStraight(values);

  if (fr.is && sr.is) {
    const sv = fr.cards.map(cv);
    const ss = isStraight(sv);
    if (ss.is && ss.high === 14) return { rank: 9, name: 'Quinte flush royale', values: [14] };
    if (ss.is) return { rank: 8, name: 'Quinte flush', values: [ss.high] };
  }

  if (byCount.has(4)) {
    const q = byCount.get(4)[0];
    const k = values.filter(v => v !== q).sort((a, b) => b - a)[0];
    return { rank: 7, name: 'Carré', values: [q, k] };
  }

  if (byCount.has(3) && byCount.has(2))
    return { rank: 6, name: 'Full', values: [byCount.get(3)[0], byCount.get(2)[0]] };
  if (byCount.has(3) && byCount.get(3).length >= 2) {
    const t = byCount.get(3).sort((a, b) => b - a);
    return { rank: 6, name: 'Full', values: [t[0], t[1]] };
  }

  if (fr.is)
    return { rank: 5, name: 'Couleur', values: fr.cards.map(cv).sort((a, b) => b - a).slice(0, 5) };

  if (sr.is) return { rank: 4, name: 'Suite', values: [sr.high] };

  if (byCount.has(3)) {
    const tv = byCount.get(3)[0];
    return { rank: 3, name: 'Brelan', values: [tv, ...values.filter(v => v !== tv).sort((a, b) => b - a).slice(0, 2)] };
  }

  if (byCount.has(2) && byCount.get(2).length >= 2) {
    const p = byCount.get(2).sort((a, b) => b - a).slice(0, 2);
    return { rank: 2, name: 'Double paire', values: [...p, values.filter(v => !p.includes(v)).sort((a, b) => b - a)[0]] };
  }

  if (byCount.has(2)) {
    const pv = byCount.get(2)[0];
    return { rank: 1, name: 'Paire', values: [pv, ...values.filter(v => v !== pv).sort((a, b) => b - a).slice(0, 3)] };
  }

  return { rank: 0, name: 'Carte haute', values: [...values].sort((a, b) => b - a).slice(0, 5) };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.values.length, b.values.length); i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

function findWinners(players, community) {
  const active = players.map((p, i) => ({ ...p, _idx: i })).filter(p => !p.folded && p.cards.length === 2);
  if (active.length === 0) return [];
  if (active.length === 1) return [active[0]._idx];
  const ev = active.map(p => ({ _idx: p._idx, hand: evaluateHand(p.cards, community) }));
  ev.sort((a, b) => compareHands(b.hand, a.hand));
  const best = ev[0];
  return ev.filter(e => compareHands(e.hand, best.hand) === 0).map(w => w._idx);
}

// ═══════════════════════════════════════════════════════════
//  GAME HELPERS
// ═══════════════════════════════════════════════════════════
const DEFAULTS = { smallBlind: 5, bigBlind: 10, startingStack: 1000, turnTimer: 20, maxPlayers: 6 };

async function getRoomState(code) {
  const snap = await db.ref(`rooms/${code}`).once('value');
  return snap.val();
}

async function setRoomState(code, state) {
  await db.ref(`rooms/${code}`).set(state);
}

async function notifyRoom(code, event, data) {
  await db.ref(`events/${code}`).push({
    event,
    data,
    timestamp: admin.database.ServerValue.TIMESTAMP,
  });
}

function nextConnectedIndex(room, fromIdx) {
  let idx = (fromIdx + 1) % room.players.length;
  let attempts = 0;
  while (attempts < room.players.length) {
    if (room.players[idx].isConnected && !room.players[idx].folded && !room.players[idx].allIn)
      return idx;
    idx = (idx + 1) % room.players.length;
    attempts++;
  }
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].isConnected && !room.players[i].folded && !room.players[i].allIn)
      return i;
  }
  return fromIdx;
}

function placeBet(room, player, amount) {
  const a = Math.min(amount, player.stack);
  player.stack -= a;
  player.bet += a;
  player.totalBet += a;
  room.pot += a;
  if (player.stack === 0) player.allIn = true;
}

function advanceToNextPlayer(room) {
  const next = nextConnectedIndex(room, room.currentPlayerIndex);
  const activeConnected = room.players.filter(p => p.isConnected && !p.folded);
  const nonAllIn = activeConnected.filter(p => !p.allIn);
  const allMatched = nonAllIn.every(p => p.bet === room.currentBet);
  const canProceed = nonAllIn.length <= 1 || allMatched;

  if (next === room.currentPlayerIndex || canProceed) {
    endPhase(room);
    return;
  }
  room.currentPlayerIndex = next;
}

function endPhase(room) {
  for (const p of room.players) { p.bet = 0; }
  room.currentBet = 0;
  room.minRaise = room.settings.bigBlind;

  const activePlayers = room.players.filter(p => p.isConnected && !p.folded);
  if (activePlayers.length <= 1) {
    declareWinner(room, activePlayers);
    return;
  }

  const nonAllIn = activePlayers.filter(p => !p.allIn);
  if (nonAllIn.length <= 1) {
    const phases = ['preflop', 'flop', 'turn', 'river'];
    const ci = phases.indexOf(room.phase);
    for (let i = ci + 1; i < phases.length; i++) {
      if (phases[i] === 'flop') room.communityCards = deal(room.deck, 3);
      else room.communityCards.push(...deal(room.deck, 1));
    }
    doShowdown(room);
    return;
  }

  const phases = ['preflop', 'flop', 'turn', 'river'];
  const ci = phases.indexOf(room.phase);
  if (ci === -1 || ci >= phases.length - 1) {
    doShowdown(room);
    return;
  }

  const np = phases[ci + 1];
  if (np === 'flop') room.communityCards = deal(room.deck, 3);
  else room.communityCards.push(...deal(room.deck, 1));

  room.phase = np;
  room.currentPlayerIndex = firstAfterDealer(room);
}

function firstAfterDealer(room) {
  let idx = (room.dealerIndex + 1) % room.players.length;
  let attempts = 0;
  while (attempts < room.players.length) {
    if (room.players[idx].isConnected && !room.players[idx].folded && !room.players[idx].allIn)
      return idx;
    idx = (idx + 1) % room.players.length;
    attempts++;
  }
  return room.dealerIndex;
}

function doShowdown(room) {
  room.phase = 'showdown';
  room.handComplete = true;

  const nonFolded = room.players.map((p, i) => ({ ...p, _realIdx: i }))
    .filter(p => !p.folded && p.cards.length === 2);

  if (nonFolded.length === 1) {
    room.players[nonFolded[0]._realIdx].stack += room.pot;
  } else if (nonFolded.length > 1) {
    const evaluated = nonFolded.map(p => ({
      realIdx: p._realIdx,
      hand: evaluateHand(p.cards, room.communityCards),
    }));
    evaluated.sort((a, b) => compareHands(b.hand, a.hand));
    const best = evaluated[0];
    const winners = evaluated.filter(e => compareHands(e.hand, best.hand) === 0);
    const share = Math.floor(room.pot / winners.length);
    for (const w of winners) room.players[w.realIdx].stack += share;
  }
  room.pot = 0;
}

function declareWinner(room, remaining) {
  room.phase = 'showdown';
  room.handComplete = true;
  if (remaining.length === 1) remaining[0].stack += room.pot;
  room.pot = 0;
}

function sanitizeRoomData(room, forPlayerId) {
  if (!room) return null;
  return {
    code: room.code,
    phase: room.phase,
    pot: room.pot,
    smallBlind: room.settings?.smallBlind || 5,
    bigBlind: room.settings?.bigBlind || 10,
    startingStack: room.settings?.startingStack || 1000,
    turnTimer: room.settings?.turnTimer || 20,
    communityCards: room.communityCards || [],
    currentBet: room.currentBet || 0,
    dealerIndex: room.dealerIndex,
    currentPlayerIndex: room.currentPlayerIndex,
    handComplete: room.handComplete || false,
    players: (room.players || []).map(p => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      bet: p.bet,
      totalBet: p.totalBet || 0,
      folded: p.folded,
      allIn: p.allIn,
      isDealer: p.isDealer,
      isConnected: p.isConnected,
      isMe: p.id === forPlayerId,
      cards: (p.id === forPlayerId || room.phase === 'showdown')
        ? (p.cards || [])
        : ((p.cards || []).length > 0 ? [{ rank: '?', suit: '?' }, { rank: '?', suit: '?' }] : []),
    })),
  };
}

// ═══════════════════════════════════════════════════════════
//  CLOUD FUNCTIONS
// ═══════════════════════════════════════════════════════════

exports.createRoom = functions.https.onCall(async (data, context) => {
  const name = (data.name || '').trim();
  if (!name) throw new functions.https.HttpsError('invalid-argument', 'Pseudo requis');

  const settings = {
    smallBlind: parseInt(data.settings?.smallBlind) || 5,
    bigBlind: parseInt(data.settings?.bigBlind) || 10,
    startingStack: parseInt(data.settings?.startingStack) || 1000,
    turnTimer: parseInt(data.settings?.turnTimer) || 20,
  };

  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const playerId = context.auth?.uid || `anon_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const roomState = {
    code,
    settings,
    phase: 'waiting',
    pot: 0,
    deck: [],
    communityCards: [],
    dealerIndex: 0,
    currentPlayerIndex: -1,
    currentBet: 0,
    minRaise: settings.bigBlind,
    handComplete: false,
    players: [{
      id: playerId,
      name,
      stack: settings.startingStack,
      cards: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      isDealer: true,
      isConnected: true,
      joinedAt: admin.database.ServerValue.TIMESTAMP,
    }],
    createdAt: admin.database.ServerValue.TIMESTAMP,
    lastAction: Date.now(),
  };

  await setRoomState(code, roomState);
  await firestore.collection('rooms').doc(code).set({
    code,
    phase: 'waiting',
    playerCount: 1,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    code,
    playerId,
    isHost: true,
    roomData: sanitizeRoomData(roomState, playerId),
  };
});

exports.joinRoom = functions.https.onCall(async (data, context) => {
  const name = (data.name || '').trim();
  const roomCode = (data.roomCode || '').trim().toUpperCase();
  if (!name) throw new functions.https.HttpsError('invalid-argument', 'Pseudo requis');
  if (!roomCode) throw new functions.https.HttpsError('invalid-argument', 'Code requis');

  const room = await getRoomState(roomCode);
  if (!room) throw new functions.https.HttpsError('not-found', 'Salle introuvable');
  if (room.phase !== 'waiting') throw new functions.https.HttpsError('failed-precondition', 'Partie déjà en cours');
  if (room.players.length >= room.settings.maxPlayers)
    throw new functions.https.HttpsError('resource-exhausted', `Room pleine (max ${room.settings.maxPlayers})`);

  const playerId = context.auth?.uid || `anon_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  if (room.players.find(p => p.id === playerId)) {
    return { code: roomCode, playerId, isHost: false, roomData: sanitizeRoomData(room, playerId) };
  }

  room.players.push({
    id: playerId,
    name,
    stack: room.settings.startingStack,
    cards: [],
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    isDealer: false,
    isConnected: true,
    joinedAt: admin.database.ServerValue.TIMESTAMP,
  });

  await setRoomState(roomCode, room);
  await firestore.collection('rooms').doc(roomCode).update({ playerCount: room.players.length });
  await notifyRoom(roomCode, 'playerJoined', { playerId, name, playerCount: room.players.length });

  return { code: roomCode, playerId, isHost: false, roomData: sanitizeRoomData(room, playerId) };
});

exports.startGame = functions.https.onCall(async (data, context) => {
  const code = (data.code || '').trim().toUpperCase();
  const playerId = context.auth?.uid || data.playerId;

  const room = await getRoomState(code);
  if (!room) throw new functions.https.HttpsError('not-found', 'Room introuvable');
  if (room.phase !== 'waiting') throw new functions.https.HttpsError('failed-precondition', 'Partie déjà en cours');

  const connectedPlayers = room.players.filter(p => p.isConnected);
  if (connectedPlayers.length < 2)
    throw new functions.https.HttpsError('failed-precondition', 'Il faut au moins 2 joueurs');

  const deck = createShuffledDeck();
  room.communityCards = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = room.settings.bigBlind;
  room.handComplete = false;

  for (const p of room.players) {
    p.cards = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false;
  }

  let attempts = 0;
  do {
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    attempts++;
  } while (!room.players[room.dealerIndex].isConnected && attempts < room.players.length);

  room.players.forEach((p, i) => { p.isDealer = (i === room.dealerIndex); });

  for (const p of room.players) { p.cards = deal(deck, 2); }
  room.deck = deck;

  const sbIdx = nextConnectedIndex(room, room.dealerIndex);
  const bbIdx = nextConnectedIndex(room, sbIdx);

  placeBet(room, room.players[sbIdx], room.settings.smallBlind);
  placeBet(room, room.players[bbIdx], room.settings.bigBlind);

  room.currentBet = room.settings.bigBlind;
  room.phase = 'preflop';
  room.currentPlayerIndex = nextConnectedIndex(room, bbIdx);
  room.lastAction = Date.now();

  await setRoomState(code, room);
  await notifyRoom(code, 'gameStarted', { roomData: sanitizeRoomData(room, null) });

  return { roomData: sanitizeRoomData(room, playerId) };
});

exports.playerAction = functions.https.onCall(async (data, context) => {
  const code = (data.code || '').trim().toUpperCase();
  const playerId = context.auth?.uid || data.playerId;
  const action = data.action;
  const amount = parseInt(data.amount) || 0;

  const room = await getRoomState(code);
  if (!room) throw new functions.https.HttpsError('not-found', 'Room introuvable');
  if (room.handComplete) throw new functions.https.HttpsError('failed-precondition', 'Main terminée');

  if (room.currentPlayerIndex < 0 || room.currentPlayerIndex >= room.players.length)
    throw new functions.https.HttpsError('failed-precondition', 'Pas de joueur actif');

  const currentPlayer = room.players[room.currentPlayerIndex];
  if (currentPlayer.id !== playerId)
    throw new functions.https.HttpsError('permission-denied', 'Ce n\'est pas ton tour');
  if (currentPlayer.folded || currentPlayer.allIn)
    throw new functions.https.HttpsError('failed-precondition', 'Tu ne peux pas agir');

  let result;
  switch (action) {
    case 'fold': {
      const p = room.players[room.currentPlayerIndex];
      p.folded = true;
      advanceToNextPlayer(room);
      result = { action: 'fold', player: p.name };
      break;
    }
    case 'check': {
      const p = room.players[room.currentPlayerIndex];
      if (p.bet < room.currentBet) throw new functions.https.HttpsError('failed-precondition', 'Tu ne peux pas checker');
      advanceToNextPlayer(room);
      result = { action: 'check', player: p.name };
      break;
    }
    case 'call': {
      const p = room.players[room.currentPlayerIndex];
      const toCall = Math.min(room.currentBet - p.bet, p.stack);
      placeBet(room, p, toCall);
      advanceToNextPlayer(room);
      result = { action: 'call', player: p.name, amount: toCall };
      break;
    }
    case 'raise': {
      const p = room.players[room.currentPlayerIndex];
      const minAmount = room.currentBet + room.minRaise;
      if (amount < minAmount) throw new functions.https.HttpsError('invalid-argument', `Min: ${minAmount}`);
      if (amount > p.stack + p.bet) throw new functions.https.HttpsError('invalid-argument', 'Pas assez');
      const toAdd = amount - p.bet;
      room.minRaise = amount - room.currentBet;
      room.currentBet = amount;
      placeBet(room, p, toAdd);
      advanceToNextPlayer(room);
      result = { action: 'raise', player: p.name, amount };
      break;
    }
    default:
      throw new functions.https.HttpsError('invalid-argument', 'Action inconnue');
  }

  room.lastAction = Date.now();
  await setRoomState(code, room);
  await notifyRoom(code, 'playerAction', {
    player: result.player,
    action: result.action,
    amount: result.amount || 0,
    roomData: sanitizeRoomData(room, null),
  });

  return {
    player: result.player,
    action: result.action,
    amount: result.amount || 0,
    roomData: sanitizeRoomData(room, playerId),
  };
});

exports.nextHand = functions.https.onCall(async (data, context) => {
  const code = (data.code || '').trim().toUpperCase();

  const room = await getRoomState(code);
  if (!room) throw new functions.https.HttpsError('not-found', 'Room introuvable');
  if (room.phase !== 'showdown')
    throw new functions.https.HttpsError('failed-precondition', 'La main n\'est pas terminée');

  room.players = room.players.filter(p => p.stack > 0 && p.isConnected);

  if (room.players.length < 2) {
    room.phase = 'waiting';
    room.dealerIndex = -1;
    room.currentPlayerIndex = -1;
    await setRoomState(code, room);
    return { roomData: sanitizeRoomData(room, null), message: 'Pas assez de joueurs' };
  }

  if (room.dealerIndex < 0 || room.dealerIndex >= room.players.length) {
    room.dealerIndex = 0;
  }

  const deck = createShuffledDeck();
  room.communityCards = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = room.settings.bigBlind;
  room.handComplete = false;

  for (const p of room.players) {
    p.cards = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false;
  }

  let attempts = 0;
  do {
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    attempts++;
  } while (!room.players[room.dealerIndex].isConnected && attempts < room.players.length);

  room.players.forEach((p, i) => { p.isDealer = (i === room.dealerIndex); });

  for (const p of room.players) { p.cards = deal(deck, 2); }
  room.deck = deck;

  const sbIdx = nextConnectedIndex(room, room.dealerIndex);
  const bbIdx = nextConnectedIndex(room, sbIdx);

  placeBet(room, room.players[sbIdx], room.settings.smallBlind);
  placeBet(room, room.players[bbIdx], room.settings.bigBlind);

  room.currentBet = room.settings.bigBlind;
  room.phase = 'preflop';
  room.currentPlayerIndex = nextConnectedIndex(room, bbIdx);
  room.lastAction = Date.now();

  await setRoomState(code, room);
  await notifyRoom(code, 'newHand', { roomData: sanitizeRoomData(room, null) });

  return { roomData: sanitizeRoomData(room, null) };
});

exports.leaveRoom = functions.https.onCall(async (data, context) => {
  const code = (data.code || '').trim().toUpperCase();
  const playerId = context.auth?.uid || data.playerId;

  const room = await getRoomState(code);
  if (!room) return { ok: true };

  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return { ok: true };

  if (room.phase === 'waiting') {
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      await db.ref(`rooms/${code}`).remove();
      await firestore.collection('rooms').doc(code).delete();
      return { ok: true };
    }
    if (idx === room.dealerIndex || room.dealerIndex >= room.players.length) {
      room.dealerIndex = 0;
    }
    room.players[room.dealerIndex].isDealer = true;
  } else {
    room.players[idx].folded = true;
    room.players[idx].isConnected = false;
    if (room.currentPlayerIndex === idx) {
      advanceToNextPlayer(room);
    }
  }

  await setRoomState(code, room);
  await notifyRoom(code, 'playerLeft', { playerId, playerCount: room.players.filter(p => p.isConnected).length });

  return { ok: true };
});

// Nettoyage des rooms inactives
exports.cleanupRooms = functions.pubsub.schedule('every 60 minutes').onRun(async () => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const snap = await db.ref('rooms').once('value');
  const rooms = snap.val();
  if (!rooms) return;

  for (const [code, room] of Object.entries(rooms)) {
    if (room.lastAction && room.lastAction < cutoff) {
      await db.ref(`rooms/${code}`).remove();
      await firestore.collection('rooms').doc(code).delete();
      console.log(`Room ${code} supprimée (inactivité)`);
    }
  }
});
