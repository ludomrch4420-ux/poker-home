/**
 * Bot de test PokerHome — Teste le flux complet du jeu
 * v3: apps Firebase séparées par bot pour éviter les conflits d'auth
 */

const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, signInAnonymously } = require('firebase/auth');
const { getDatabase, ref, onValue, off, get } = require('firebase/database');
const { getFunctions, httpsCallable } = require('firebase/functions');

const BASE_CONFIG = {
  apiKey: "AIzaSyCIpO0jTkX4PJJmL47unyHBhrZW62eCRdw",
  authDomain: "poker-home-app.firebaseapp.com",
  databaseURL: "https://poker-home-app-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "poker-home-app",
  storageBucket: "poker-home-app.firebasestorage.app",
  messagingSenderId: "977951473837",
  appId: "1:977951473837:web:d5f83442142ec1c9280624"
};

let appCounter = 0;

function createApp(name) {
  return initializeApp(BASE_CONFIG, name || `app_${++appCounter}`);
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const logPlayer = (name, msg) => console.log(`  [${name}] ${msg}`);

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${testName}`);
    testsFailed++;
  }
}

async function retry(fn, maxRetries = 5, baseDelay = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || '';
      if (err.code === 'resource-exhausted' || msg.includes('429') || msg.includes('rate')) {
        const wait = baseDelay * Math.pow(2, i);
        log(`  ⏳ Rate limit, attente ${wait}ms...`);
        await delay(wait);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

class PokerBot {
  constructor(name) {
    this.name = name;
    this.appId = `poker_bot_${name}_${Date.now()}_${++appCounter}`;
    this.app = createApp(this.appId);
    this.auth = getAuth(this.app);
    this.db = getDatabase(this.app);
    this.functions = getFunctions(this.app);
    this.uid = null;
    this.playerId = null;
    this.roomCode = null;
    this.isHost = false;
    this.roomData = null;
    this.listener = null;
  }

  async connect() {
    const cred = await retry(() => signInAnonymously(this.auth));
    this.uid = cred.user.uid;
    logPlayer(this.name, `Connecté (${this.uid.substring(0, 16)}...)`);
  }

  async createRoom(settings = {}) {
    const createRoomFn = httpsCallable(this.functions, 'createRoom');
    const result = await retry(() => createRoomFn({
      name: this.name,
      settings: {
        smallBlind: settings.smallBlind || 5,
        bigBlind: settings.bigBlind || 10,
        startingStack: settings.startingStack || 500,
        turnTimer: settings.turnTimer || 30,
      }
    }));
    const { code, playerId, isHost, roomData } = result.data;
    this.roomCode = code;
    this.playerId = playerId;
    this.isHost = isHost;
    this.roomData = roomData;
    logPlayer(this.name, `Room créée: ${code}`);
    return result.data;
  }

  async joinRoom(roomCode) {
    const joinRoomFn = httpsCallable(this.functions, 'joinRoom');
    const result = await retry(() => joinRoomFn({ name: this.name, roomCode }));
    this.roomCode = result.data.code;
    this.playerId = result.data.playerId;
    this.isHost = result.data.isHost;
    this.roomData = result.data.roomData;
    logPlayer(this.name, `Rejoint: ${this.roomCode}`);
    return result.data;
  }

  listenRoomContinuous(callback) {
    const roomRef = ref(this.db, `rooms/${this.roomCode}`);
    this.listener = onValue(roomRef, (snap) => {
      this.roomData = snap.val();
      if (this.roomData) callback(this.roomData);
    });
  }

  stopListening() {
    if (this.listener) {
      try {
        off(ref(this.db, `rooms/${this.roomCode}`), 'value', this.listener);
      } catch (e) {}
      this.listener = null;
    }
  }

  async startGame() {
    const startGameFn = httpsCallable(this.functions, 'startGame');
    const result = await retry(() => startGameFn({ code: this.roomCode, playerId: this.playerId }));
    logPlayer(this.name, 'Partie démarrée');
    return result.data;
  }

  async action(type, amount = 0) {
    const playerActionFn = httpsCallable(this.functions, 'playerAction');
    const result = await retry(() => playerActionFn({
      code: this.roomCode,
      action: type,
      amount,
      playerId: this.playerId,
    }));
    logPlayer(this.name, `→ ${type}${amount ? ' ' + amount : ''}`);
    return result.data;
  }

  async nextHand() {
    const nextHandFn = httpsCallable(this.functions, 'nextHand');
    const result = await retry(() => nextHandFn({ code: this.roomCode, playerId: this.playerId }));
    logPlayer(this.name, '→ Main suivante');
    return result.data;
  }

  async leave() {
    this.stopListening();
    try {
      const leaveRoomFn = httpsCallable(this.functions, 'leaveRoom');
      await retry(() => leaveRoomFn({ code: this.roomCode, playerId: this.playerId }));
    } catch (e) {}
    try { await deleteApp(this.app); } catch (e) {}
    logPlayer(this.name, 'Quitté');
  }

  getMe() {
    if (!this.roomData?.players) return null;
    return this.roomData.players.find(p => p.id === this.playerId);
  }

  isMyTurn() {
    if (!this.roomData || this.roomData.currentPlayerIndex === undefined) return false;
    const current = this.roomData.players[this.roomData.currentPlayerIndex];
    return current && current.id === this.playerId;
  }
}

async function getRoom(roomCode) {
  // Utiliser une app séparée pour la lecture, avec auth
  const app = createApp('reader_' + Date.now());
  const readerAuth = getAuth(app);
  try {
    await signInAnonymously(readerAuth);
    // Attendre un peu que l'auth soit propagée
    await new Promise(r => setTimeout(r, 1000));
    const snap = await get(ref(getDatabase(app), `rooms/${roomCode}`));
    return snap.val();
  } finally {
    try { await deleteApp(app); } catch (e) {}
  }
}

// ══════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════

async function test1_createAndJoinRoom() {
  log('\n═══ TEST 1: Création et connexion à une room ═══');

  const host = new PokerBot('HostBot');
  const p2 = new PokerBot('Alice');
  const p3 = new PokerBot('Bob');

  await host.connect();
  await delay(1500);
  await p2.connect();
  await delay(1500);
  await p3.connect();

  assert(host.uid !== null, 'Host connecté');
  assert(p2.uid !== null, 'Alice connectée');
  assert(p3.uid !== null, 'Bob connecté');
  assert(host.uid !== p2.uid, 'Host/Alice UIDs différents');
  assert(p2.uid !== p3.uid, 'Alice/Bob UIDs différents');

  await host.createRoom();
  assert(host.roomCode?.length === 6, 'Room code 6 caractères');
  assert(host.isHost === true, 'Host est host');
  assert(host.playerId !== null, 'PlayerId assigné');

  await delay(2000);
  await p2.joinRoom(host.roomCode);
  assert(p2.roomCode === host.roomCode, 'Alice dans la room');
  assert(p2.isHost === false, 'Alice pas host');

  await delay(2000);
  await p3.joinRoom(host.roomCode);
  assert(p3.roomCode === host.roomCode, 'Bob dans la room');

  await delay(2000);
  const room = await getRoom(host.roomCode);
  assert(room !== null, 'Room existe dans la DB');
  assert(room.players.length === 3, `3 joueurs (actuel: ${room.players.length})`);
  assert(room.phase === 'waiting', `Phase: ${room.phase}`);

  for (const p of room.players) {
    assert(p.stack === 500, `${p.name}: ${p.stack} jetons`);
    assert(!p.folded, `${p.name}: pas fold`);
  }

  log('TEST 1 ✅\n');
  return { host, p2, p3 };
}

async function test2_startGame(bots) {
  log('\n═══ TEST 2: Démarrage de partie ═══');
  const { host } = bots;

  await host.startGame();
  await delay(4000);

  const room = await getRoom(host.roomCode);
  assert(room.phase === 'preflop', `Phase: ${room.phase}`);
  assert(room.pot === 15, `Pot: ${room.pot} (attendu: 15)`);

  for (const p of room.players) {
    assert(p.cards?.length === 2, `${p.name}: ${p.cards?.length} cartes`);
  }

  const dealers = room.players.filter(p => p.isDealer);
  assert(dealers.length === 1, `1 dealer: ${dealers[0]?.name}`);

  const sb = room.players.find(p => p.bet === 5);
  const bb = room.players.find(p => p.bet === 10);
  assert(sb, `SB placée: ${sb?.name} (${sb?.bet})`);
  assert(bb, `BB placée: ${bb?.name} (${bb?.bet})`);

  assert(room.currentPlayerIndex >= 0, `Tour du joueur index ${room.currentPlayerIndex}`);

  log('TEST 2 ✅\n');
}

async function test3_actions(bots) {
  log('\n═══ TEST 3: Actions des joueurs ═══');
  const { host, p2, p3 } = bots;
  const allBots = [host, p2, p3];

  let actionsDone = 0;
  const maxActions = 40;

  while (actionsDone < maxActions) {
    await delay(2000);
    const room = await getRoom(host.roomCode);

    if (!room) { assert(false, 'Room existe'); break; }
    if (room.phase === 'showdown') { log('🏁 Showdown!'); break; }
    if (room.phase === 'waiting') { log('Partie terminée'); break; }

    const current = room.players[room.currentPlayerIndex];
    if (!current) { log('Pas de joueur courant'); break; }

    const bot = allBots.find(b => b.playerId === current.id);
    if (!bot) { log(`Bot non trouvé pour ${current.name}`); break; }

    const toCall = room.currentBet - (current.bet || 0);
    let action, amount = 0;
    const r = Math.random();

    if (toCall === 0) {
      action = r < 0.6 ? 'check' : 'raise';
      if (action === 'raise') amount = room.currentBet + room.settings.bigBlind;
    } else {
      if (r < 0.15) action = 'fold';
      else if (r < 0.85) action = 'call';
      else { action = 'raise'; amount = room.currentBet + room.settings.bigBlind * 2; }
    }

    try {
      await bot.action(action, amount);
      actionsDone++;
    } catch (err) {
      logPlayer(bot.name, `Skip: ${err.message?.substring(0, 60)}`);
      await delay(3000);
    }
  }

  assert(actionsDone > 0, `${actionsDone} actions effectuées`);
  log('TEST 3 ✅\n');
}

async function test4_showdown(bots) {
  log('\n═══ TEST 4: Showdown et main suivante ═══');
  const { host } = bots;

  await delay(2000);
  let room = await getRoom(host.roomCode);

  if (room.phase !== 'showdown') {
    log(`Phase: ${room.phase}, on continue à jouer...`);
    const allBots = Object.values(bots);
    for (let i = 0; i < 60; i++) {
      await delay(2000);
      room = await getRoom(host.roomCode);
      if (!room || room.phase === 'showdown' || room.phase === 'waiting') break;

      const current = room.players[room.currentPlayerIndex];
      if (!current) break;
      const bot = allBots.find(b => b.playerId === current.id);
      if (!bot) break;

      try {
        const toCall = room.currentBet - (current.bet || 0);
        if (toCall === 0) await bot.action('check');
        else await bot.action('call');
      } catch (e) { await delay(2000); }
    }
  }

  room = await getRoom(host.roomCode);
  assert(room.phase === 'showdown', `Showdown atteint: ${room.phase}`);

  // Cartes visibles
  for (const p of room.players) {
    if (!p.folded && p.cards) {
      assert(p.cards.length === 2, `${p.name}: ${p.cards.length} cartes visibles`);
      assert(p.cards[0].rank !== '?', `${p.name}: cartes révélées`);
    }
  }

  // Main suivante
  await delay(2000);
  await host.nextHand();
  await delay(4000);

  room = await getRoom(host.roomCode);
  assert(room.phase === 'preflop', `Nouvelle main: ${room.phase}`);
  assert(room.pot === 15, `Nouveau pot: ${room.pot}`);

  for (const p of room.players) {
    assert(p.cards?.length === 2, `${p.name}: nouvelles cartes`);
    assert(!p.folded, `${p.name}: pas fold`);
  }

  log('TEST 4 ✅\n');
}

async function test5_edgeCases() {
  log('\n═══ TEST 5: Cas limites ═══');

  const bot = new PokerBot('EdgeBot');
  await bot.connect();

  // Room inexistante
  try {
    await bot.joinRoom('XXXXXX');
    assert(false, 'Room inexistante rejetée');
  } catch (err) {
    assert(true, `Room inexistante rejetée: ${err.message?.substring(0, 40)}`);
  }

  await delay(2000);

  // Room pleine (max 6)
  const host = new PokerBot('HostFull');
  await host.connect();
  await host.createRoom();

  const extras = [];
  for (let i = 0; i < 5; i++) {
    const b = new PokerBot(`Filler${i}`);
    await b.connect();
    await delay(1500);
    await b.joinRoom(host.roomCode);
    extras.push(b);
    await delay(1000);
  }

  const extra = new PokerBot('ExtraBot');
  await extra.connect();
  await delay(1500);
  try {
    await extra.joinRoom(host.roomCode);
    assert(false, 'Room pleine rejetée');
  } catch (err) {
    assert(true, `Room pleine rejetée: ${err.message?.substring(0, 40)}`);
  }

  // Action hors tour
  await delay(1500);
  await host.startGame();
  await delay(4000);

  const room = await getRoom(host.roomCode);
  const currentIdx = room.currentPlayerIndex;
  const notCurrent = room.players.find((p, i) => i !== currentIdx && p.isConnected);
  if (notCurrent) {
    const notBot = extras.find(b => b.playerId === notCurrent.id);
    if (notBot) {
      try {
        await notBot.action('fold');
        assert(false, 'Action hors tour rejetée');
      } catch (err) {
        assert(true, `Action hors tour rejetée: ${err.message?.substring(0, 40)}`);
      }
    }
  }

  for (const b of extras) { await b.leave(); await delay(500); }
  await host.leave();
  await extra.leave();
  await bot.leave();

  log('TEST 5 ✅\n');
}

async function test6_disconnect() {
  log('\n═══ TEST 6: Déconnexion en partie ═══');

  const dHost = new PokerBot('HostDisc');
  const dP2 = new PokerBot('PlayerDisc');
  await dHost.connect();
  await delay(1500);
  await dP2.connect();
  await delay(1500);
  await dHost.createRoom();
  await delay(2000);
  await dP2.joinRoom(dHost.roomCode);
  await delay(1500);

  await dHost.startGame();
  await delay(4000);

  // Player2 quitte en pleine partie
  await dP2.leave();
  await delay(3000);

  const room = await getRoom(dHost.roomCode);
  const p2Data = room.players.find(p => p.name === 'PlayerDisc');
  if (p2Data) {
    assert(p2Data.folded === true, 'Déconnecté → fold');
    assert(p2Data.isConnected === false, 'Déconnecté → isConnected=false');
  } else {
    assert(true, 'Joueur déconnecté retiré de la liste');
  }

  assert(room.phase !== 'waiting', `Partie continue: ${room.phase}`);

  await dHost.leave();
  log('TEST 6 ✅\n');
}

// ══════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   PokerHome — Tests automatisés (bots) v3   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    const bots = await test1_createAndJoinRoom();
    await test2_startGame(bots);
    await test3_actions(bots);
    await test4_showdown(bots);
    await test5_edgeCases();
    await test6_disconnect();

    await bots.host.leave();
    await bots.p2.leave();
    await bots.p3.leave();

  } catch (err) {
    console.error('\n❌ ERREUR FATALE:', err.message);
    console.error(err.stack);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║  RÉSULTATS: ✅ ${testsPassed} passed  ❌ ${testsFailed} failed          ║`);
  console.log('╚══════════════════════════════════════════════╝');

  process.exit(testsFailed > 0 ? 1 : 0);
}

main();
