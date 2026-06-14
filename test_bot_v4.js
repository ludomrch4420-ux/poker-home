/**
 * Bot de test PokerHome — Teste le flux complet du jeu
 * v4: Tests approfondis avec détection de bugs, parties complètes,
 *     tests de reconnexion, all-in, showdown multiples, etc.
 */

const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, signInAnonymously } = require('firebase/auth');
const { getDatabase, ref, onValue, off, get, set, remove } = require('firebase/database');
const { getFunctions, httpsCallable } = require('firebase/functions');

const BASE_CONFIG = {
  apiKey: "AIzaSy...CRdw",
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
let bugsFound = [];

function assert(condition, testName, bugId = null) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${testName}`);
    testsFailed++;
    if (bugId) bugsFound.push({ id: bugId, desc: testName });
  }
}

function bug(bugId, desc, details = '') {
  console.log(`  🐛 BUG #${bugId}: ${desc}${details ? ' → ' + details : ''}`);
  bugsFound.push({ id: bugId, desc, details });
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
    this.actionLog = [];
  }

  async connect() {
    const cred = await retry(() => signInAnonymously(this.auth));
    this.uid = cred.user.uid;
    logPlayer(this.name, `Connecté (${this.uid.substring(0, 12)}...)`);
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
        maxPlayers: settings.maxPlayers || 6,
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

  async joinRoom(roomCode, playerId = null) {
    const joinRoomFn = httpsCallable(this.functions, 'joinRoom');
    const data = { name: this.name, roomCode };
    if (playerId) data.playerId = playerId;
    const result = await retry(() => joinRoomFn(data));
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
    if (this.listener && this.roomCode) {
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
    this.actionLog.push({ type, amount });
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
    const players = this.roomData.players;
    if (this.roomData.currentPlayerIndex < 0 || this.roomData.currentPlayerIndex >= players.length) return false;
    const current = players[this.roomData.currentPlayerIndex];
    return current && current.id === this.playerId;
  }
}

async function getRoom(roomCode) {
  const app = createApp('reader_' + Date.now() + '_' + ++appCounter);
  const readerAuth = getAuth(app);
  try {
    await signInAnonymously(readerAuth);
    await delay(1000);
    const snap = await get(ref(getDatabase(app), `rooms/${roomCode}`));
    return snap.val();
  } finally {
    try { await deleteApp(app); } catch (e) {}
  }
}

async function cleanupRoom(roomCode) {
  try {
    const app = createApp('cleanup_' + Date.now());
    const a = getAuth(app);
    await signInAnonymously(a);
    await delay(500);
    const database = getDatabase(app);
    await remove(ref(database, `rooms/${roomCode}`));
    try { await deleteApp(app); } catch (e) {}
  } catch (e) {}
}

// ══════════════════════════════════════════
//  TEST 1: Création et connexion
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

  await host.createRoom();
  assert(host.roomCode?.length === 6, 'Room code 6 caractères');
  assert(host.isHost === true, 'Host est host');

  await delay(2000);
  await p2.joinRoom(host.roomCode);
  assert(p2.roomCode === host.roomCode, 'Alice dans la même room');
  assert(p2.isHost === false, 'Alice pas host');

  await delay(2000);
  await p3.joinRoom(host.roomCode);
  assert(p3.roomCode === host.roomCode, 'Bob dans la même room');

  await delay(2000);
  const room = await getRoom(host.roomCode);
  assert(room !== null, 'Room existe dans la DB');
  assert(room.players.length === 3, `3 joueurs (actuel: ${room.players.length})`);
  assert(room.phase === 'waiting', `Phase: ${room.phase}`);

  for (const p of room.players) {
    assert(p.stack === 500, `${p.name}: ${p.stack} jetons`);
    assert(!p.folded, `${p.name}: pas fold`);
  }

  log('TEST 1 TERMINE');
  return { host, p2, p3 };
}

// ══════════════════════════════════════════
//  TEST 2: Démarrage de partie
// ══════════════════════════════════════════
async function test2_startGame(bots) {
  log('\n═══ TEST 2: Démarrage de partie ═══');
  const { host } = bots;

  await host.startGame();
  await delay(4000);

  const room = await getRoom(host.roomCode);
  assert(room.phase === 'preflop', `Phase: ${room.phase}`);
  assert(room.pot === 15, `Pot: ${room.pot} (attendu: 15 = 5 SB + 10 BB)`);

  for (const p of room.players) {
    assert(p.cards?.length === 2, `${p.name}: ${p.cards?.length} cartes`);
  }

  const dealers = room.players.filter(p => p.isDealer);
  assert(dealers.length === 1, `1 dealer (actuel: ${dealers.length})`);

  const sb = room.players.find(p => p.bet === 5);
  const bb = room.players.find(p => p.bet === 10);
  assert(sb !== undefined, `SB placée`);
  assert(bb !== undefined, `BB placée`);
  assert(sb.name !== bb.name, 'SB et BB sont des joueurs différents');

  assert(room.currentPlayerIndex >= 0, `Tour du joueur index ${room.currentPlayerIndex}`);
  assert(room.turnDeadline !== null, 'Turn deadline définie');

  log('TEST 2 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 3: Partie complète — actions jusqu'au showdown
// ══════════════════════════════════════════
async function test3_fullHand(bots) {
  log('\n═══ TEST 3: Partie complète (main 1) ═══');
  const { host, p2, p3 } = bots;
  const allBots = [host, p2, p3];

  let actionsDone = 0;
  const maxActions = 50;
  let lastPhase = 'preflop';
  let phaseChanges = [];

  while (actionsDone < maxActions) {
    await delay(2000);
    const room = await getRoom(host.roomCode);

    if (!room) { assert(false, 'Room existe'); break; }
    if (room.phase === 'waiting') { log('Partie terminée (waiting)'); break; }
    if (room.phase === 'showdown') {
      log('🏁 Showdown!');
      phaseChanges.push('showdown');
      break;
    }

    if (room.phase !== lastPhase) {
      phaseChanges.push(room.phase);
      lastPhase = room.phase;
      log(`  📊 Phase: ${room.phase}, Pot: ${room.pot}, Cartes: ${room.communityCards?.length || 0}`);
    }

    const current = room.players[room.currentPlayerIndex];
    if (!current) { log('Pas de joueur courant'); break; }

    const bot = allBots.find(b => b.playerId === current.id);
    if (!bot) { log(`Bot non trouvé pour ${current.name}`); break; }

    const toCall = room.currentBet - (current.bet || 0);
    let action, amount = 0;
    const r = Math.random();

    if (toCall === 0) {
      action = r < 0.5 ? 'check' : 'raise';
      if (action === 'raise') {
        const minRaise = room.currentBet + (room.settings?.bigBlind || 10);
        amount = minRaise;
      }
    } else {
      if (r < 0.1) action = 'fold';
      else if (r < 0.8) action = 'call';
      else {
        action = 'raise';
        amount = room.currentBet + (room.settings?.bigBlind || 10) * 2;
      }
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
  assert(phaseChanges.length >= 1, `Phases traversées: ${phaseChanges.join(' → ')}`);

  // Vérifier le showdown
  const room = await getRoom(host.roomCode);
  if (room.phase === 'showdown') {
    assert(room.handComplete === true, 'handComplete = true');

    // Vérifier que les cartes sont révélées
    const nonFolded = room.players.filter(p => !p.folded && p.cards?.length === 2);
    for (const p of nonFolded) {
      assert(p.cards[0].rank !== '?', `${p.name}: cartes révélées au showdown`);
    }

    // Vérifier que le pot est distribué (pot = 0 après showdown)
    assert(room.pot === 0, `Pot après showdown: ${room.pot} (attendu: 0)`);

    // Vérifier que les stacks ont changé (quelqu'un a gagné)
    const totalStack = room.players.reduce((sum, p) => sum + p.stack, 0);
    assert(totalStack === 1500, `Total stack conservé: ${totalStack} (attendu: 1500)`);
  }

  log('TEST 3 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 4: Main suivante (nextHand)
// ══════════════════════════════════════════
async function test4_nextHand(bots) {
  log('\n═══ TEST 4: Main suivante ═══');
  const { host, p2, p3 } = bots;

  await delay(2000);
  let room = await getRoom(host.roomCode);

  if (room.phase !== 'showdown') {
    log(`Phase actuelle: ${room.phase}, on joue jusqu'au showdown...`);
    const allBots = [host, p2, p3];
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

  // Lancer la main suivante
  await delay(2000);
  await host.nextHand();
  await delay(4000);

  room = await getRoom(host.roomCode);
  assert(room.phase === 'preflop', `Nouvelle main: ${room.phase}`);
  assert(room.pot === 15, `Nouveau pot: ${room.pot} (attendu: 15)`);
  assert(room.handComplete === false, 'handComplete = false');

  for (const p of room.players) {
    assert(p.cards?.length === 2, `${p.name}: nouvelles cartes`);
    assert(!p.folded, `${p.name}: pas fold`);
    assert(!p.allIn, `${p.name}: pas all-in`);
    assert(p.bet === 0 || p.bet === 5 || p.bet === 10, `${p.name}: bet reset (actuel: ${p.bet})`);
  }

  // Vérifier que le dealer a bougé
  const dealers = room.players.filter(p => p.isDealer);
  assert(dealers.length === 1, `1 dealer après nextHand (actuel: ${dealers.length})`);

  log('TEST 4 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 5: Partie avec tous les joueurs qui foldent (sauf un)
// ══════════════════════════════════════════
async function test5_allFold() {
  log('\n═══ TEST 5: Tous fold sauf un ═══');

  const host = new PokerBot('HostFold');
  const p2 = new PokerBot('FoldAlice');
  const p3 = new PokerBot('FoldBob');

  await host.connect(); await delay(1500);
  await p2.connect(); await delay(1500);
  await p3.connect(); await delay(1500);

  await host.createRoom();
  await delay(2000);
  await p2.joinRoom(host.roomCode);
  await delay(2000);
  await p3.joinRoom(host.roomCode);
  await delay(2000);

  await host.startGame();
  await delay(4000);

  // Tous fold sauf le premier joueur
  const room = await getRoom(host.roomCode);
  const current = room.players[room.currentPlayerIndex];
  const foldBots = [host, p2, p3].filter(b => b.playerId === current.id);

  // Le premier joueur fold
  if (foldBots[0]) {
    await foldBots[0].action('fold');
    await delay(2000);
  }

  // Le deuxième joueur fold
  const room2 = await getRoom(host.roomCode);
  if (room2.phase !== 'showdown') {
    const current2 = room2.players[room2.currentPlayerIndex];
    const nextBot = [host, p2, p3].find(b => b.playerId === current2.id);
    if (nextBot) {
      await nextBot.action('fold');
      await delay(2000);
    }
  }

  // Vérifier le résultat
  const finalRoom = await getRoom(host.roomCode);
  assert(finalRoom.phase === 'showdown', `Showdown après tous fold: ${finalRoom.phase}`);
  assert(finalRoom.pot === 0, `Pot distribué: ${finalRoom.pot}`);

  // Le joueur non-foldé doit avoir gagné le pot
  const winner = finalRoom.players.find(p => !p.folded);
  if (winner) {
    assert(winner.stack > 500, `Gagnant a plus que son stack initial: ${winner.stack}`);
  }

  // Vérifier conservation des jetons
  const total = finalRoom.players.reduce((s, p) => s + p.stack, 0);
  assert(total === 1500, `Conservation: ${total} (attendu: 1500)`);

  for (const b of [host, p2, p3]) { await b.leave(); await delay(500); }
  log('TEST 5 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 6: All-in et showdown
// ══════════════════════════════════════════
async function test6_allInShowdown() {
  log('\n═══ TEST 6: All-in et showdown ═══');

  const host = new PokerBot('HostAllin');
  const p2 = new PokerBot('AllinAlice');

  await host.connect(); await delay(1500);
  await p2.connect(); await delay(1500);

  await host.createRoom({ startingStack: 100, smallBlind: 5, bigBlind: 10 });
  await delay(2000);
  await p2.joinRoom(host.roomCode);
  await delay(2000);

  await host.startGame();
  await delay(4000);

  // Joueur 1 fait all-in
  const room = await getRoom(host.roomCode);
  const current = room.players[room.currentPlayerIndex];
  const bot = [host, p2].find(b => b.playerId === current.id);
  if (bot) {
    await bot.action('raise', 100); // All-in avec stack de 100 (moins les blinds déjà placées)
    await delay(2000);
  }

  // L'autre call
  const room2 = await getRoom(host.roomCode);
  if (room2.phase !== 'showdown') {
    const current2 = room2.players[room2.currentPlayerIndex];
    const bot2 = [host, p2].find(b => b.playerId === current2.id);
    if (bot2) {
      await bot2.action('call');
      await delay(2000);
    }
  }

  // Jouer jusqu'au showdown
  for (let i = 0; i < 20; i++) {
    await delay(2000);
    const r = await getRoom(host.roomCode);
    if (r.phase === 'showdown' || r.phase === 'waiting') break;
    const c = r.players[r.currentPlayerIndex];
    if (!c) break;
    const b = [host, p2].find(x => x.playerId === c.id);
    if (!b) break;
    try {
      const toCall = r.currentBet - (c.bet || 0);
      if (toCall === 0) await b.action('check');
      else await b.action('call');
    } catch (e) { await delay(2000); }
  }

  const finalRoom = await getRoom(host.roomCode);
  assert(finalRoom.phase === 'showdown', `Showdown après all-in: ${finalRoom.phase}`);
  assert(finalRoom.pot === 0, `Pot distribué: ${finalRoom.pot}`);

  // Vérifier conservation
  const total = finalRoom.players.reduce((s, p) => s + p.stack, 0);
  assert(total === 200, `Conservation: ${total} (attendu: 200)`);

  for (const b of [host, p2]) { await b.leave(); await delay(500); }
  log('TEST 6 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 7: Reconnexion (même playerId)
// ══════════════════════════════════════════
async function test7_reconnect() {
  log('\n═══ TEST 7: Reconnexion avec même playerId ═══');

  const host = new PokerBot('HostReconn');
  const p2 = new PokerBot('ReconnAlice');

  await host.connect(); await delay(1500);
  await p2.connect(); await delay(1500);

  await host.createRoom();
  await delay(2000);
  await p2.joinRoom(host.roomCode);
  await delay(2000);

  const p2Id = p2.playerId;
  const roomCode = host.roomCode;

  // P2 quitte
  await p2.leave();
  await delay(2000);

  // Vérifier que P2 est marqué déconnecté
  let room = await getRoom(roomCode);
  const p2Data = room.players.find(p => p.name === 'ReconnAlice');
  assert(p2Data && p2Data.isConnected === false, 'P2 marqué déconnecté');

  // P2 se reconnecte avec le même playerId
  const p2New = new PokerBot('ReconnAlice');
  await p2New.connect();
  await delay(1500);
  await p2New.joinRoom(roomCode, p2Id);
  await delay(2000);

  room = await getRoom(roomCode);
  const p2Reconn = room.players.find(p => p.name === 'ReconnAlice');
  assert(p2Reconn && p2Reconn.isConnected === true, 'P2 reconnecté avec même playerId');
  assert(p2Reconn.id === p2Id, 'PlayerId conservé après reconnexion');

  await host.leave();
  await p2New.leave();
  log('TEST 7 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 8: Cas limites
// ══════════════════════════════════════════
async function test8_edgeCases() {
  log('\n═══ TEST 8: Cas limites ═══');

  const bot = new PokerBot('EdgeBot');
  await bot.connect();

  // Room inexistante
  try {
    await bot.joinRoom('XXXXXX');
    assert(false, 'Room inexistante rejetée');
  } catch (err) {
    assert(true, `Room inexistante rejetée`);
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
    assert(true, `Room pleine rejetée`);
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
        assert(true, `Action hors tour rejetée`);
      }
    }
  }

  // Check quand il faut suivre
  const current = room.players[currentIdx];
  const toCall = room.currentBet - (current.bet || 0);
  if (toCall > 0) {
    const currentBot = [host, ...extras].find(b => b.playerId === current.id);
    if (currentBot) {
      try {
        await currentBot.action('check');
        assert(false, 'Check avec mise à suivre rejeté');
      } catch (err) {
        assert(true, `Check avec mise à suivre rejeté`);
      }
    }
  }

  for (const b of extras) { await b.leave(); await delay(500); }
  await host.leave();
  await extra.leave();
  await bot.leave();
  log('TEST 8 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 9: Déconnexion en pleine partie
// ══════════════════════════════════════════
async function test9_disconnectInGame() {
  log('\n═══ TEST 9: Déconnexion en pleine partie ═══');

  const dHost = new PokerBot('HostDisc');
  const dP2 = new PokerBot('PlayerDisc');
  await dHost.connect(); await delay(1500);
  await dP2.connect(); await delay(1500);
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
  }

  // La partie doit continuer ou se terminer proprement
  assert(room.phase === 'showdown' || room.phase === 'preflop' || room.phase === 'flop' || room.phase === 'turn' || room.phase === 'river',
    `Partie continue après déco: ${room.phase}`);

  await dHost.leave();
  log('TEST 9 TERMINE');
}

// ══════════════════════════════════════════
//  TEST 10: Parties multiples (stress test)
// ══════════════════════════════════════════
async function test10_multipleHands() {
  log('\n═══ TEST 10: 3 mains consécutives ═══');

  const host = new PokerBot('HostMulti');
  const p2 = new PokerBot('MultiAlice');
  const p3 = new PokerBot('MultiBob');

  await host.connect(); await delay(1500);
  await p2.connect(); await delay(1500);
  await p3.connect(); await delay(1500);

  await host.createRoom({ startingStack: 1000 });
  await delay(2000);
  await p2.joinRoom(host.roomCode);
  await delay(2000);
  await p3.joinRoom(host.roomCode);
  await delay(2000);

  for (let hand = 1; hand <= 3; hand++) {
    log(`\n  --- Main ${hand} ---`);
    await host.startGame();
    await delay(4000);

    // Jouer jusqu'au showdown
    for (let i = 0; i < 50; i++) {
      await delay(2000);
      const room = await getRoom(host.roomCode);
      if (!room || room.phase === 'showdown' || room.phase === 'waiting') break;

      const current = room.players[room.currentPlayerIndex];
      if (!current) break;
      const bot = [host, p2, p3].find(b => b.playerId === current.id);
      if (!bot) break;

      try {
        const toCall = room.currentBet - (current.bet || 0);
        const r = Math.random();
        if (toCall === 0) {
          await bot.action(r < 0.6 ? 'check' : 'raise', r >= 0.6 ? room.currentBet + (room.settings?.bigBlind || 10) : 0);
        } else {
          if (r < 0.15) await bot.action('fold');
          else if (r < 0.85) await bot.action('call');
          else await bot.action('raise', room.currentBet + (room.settings?.bigBlind || 10) * 2);
        }
      } catch (e) { await delay(2000); }
    }

    const room = await getRoom(host.roomCode);
    assert(room.phase === 'showdown', `Main ${hand}: showdown atteint (${room.phase})`);
    assert(room.pot === 0, `Main ${hand}: pot distribué (${room.pot})`);

    // Conservation des jetons
    const total = room.players.reduce((s, p) => s + p.stack, 0);
    assert(total === 3000, `Main ${hand}: conservation ${total} (attendu: 3000)`);

    if (hand < 3) {
      await delay(2000);
      await host.nextHand();
      await delay(4000);
    }
  }

  for (const b of [host, p2, p3]) { await b.leave(); await delay(500); }
  log('TEST 10 TERMINE');
}

// ══════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   PokerHome — Tests automatisés (bots) v4      ║');
  console.log('║   Tests approfondis + détection de bugs         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  try {
    const bots = await test1_createAndJoinRoom();
    await test2_startGame(bots);
    await test3_fullHand(bots);
    await test4_nextHand(bots);
    await test5_allFold();
    await test6_allInShowdown();
    await test7_reconnect();
    await test8_edgeCases();
    await test9_disconnectInGame();
    await test10_multipleHands();

    await bots.host.leave();
    await bots.p2.leave();
    await bots.p3.leave();

  } catch (err) {
    console.error('\n❌ ERREUR FATALE:', err.message);
    console.error(err.stack);
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  RÉSULTATS: ✅ ${testsPassed} passed  ❌ ${testsFailed} failed            ║`);
  if (bugsFound.length > 0) {
    console.log(`║  🐛 ${bugsFound.length} bug(s) détecté(s)                          ║`);
    for (const b of bugsFound) {
      console.log(`║    #${b.id}: ${b.desc.substring(0, 45)}`);
    }
  }
  console.log('╚══════════════════════════════════════════════════╝');

  process.exit(testsFailed > 0 ? 1 : 0);
}

main();
