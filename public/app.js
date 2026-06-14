/**
 * PokerHome v2 — Client JavaScript
 * Firebase Realtime Database + Auth anonyme
 */

// ── CONFIG FIREBASE ──
const fb = firebase.initializeApp({
  apiKey: "AIzaSy...CRdw",
  authDomain: "poker-home-app.firebaseapp.com",
  databaseURL: "https://poker-home-app-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "poker-home-app",
  storageBucket: "poker-home-app.firebasestorage.app",
  messagingSenderId: "977951473837",
  appId: "1:977951473837:web:d5f83442142ec1c9280624"
});

const auth = fb.auth();
const db = fb.database();
const fn = fb.functions();

let currentUser = null;

// ── AUTH AUTOMATIQUE ──
auth.signInAnonymously().then(c => {
  currentUser = c.user;
  console.log('Auth OK:', currentUser.uid.substring(0,8));
}).catch(e => {
  console.error('Auth error:', e);
  showToast('Erreur de connexion');
});

// ── STATE ──
const S = {
  playerName: '', roomCode: '', playerId: '', isHost: false,
  phase: 'lobby', pot: 0, communityCards: [], players: [],
  myTurn: false, currentBet: 0, bigBlind: 10, turnDeadline: null,
  timerInt: null, roomListener: null, eventListener: null,
};

// ── UI HELPERS ──
function $(id) { return document.getElementById(id); }
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function setLoading(id, on) {
  const b = $(id); if (!b) return;
  if (on) { b.dataset.orig = b.innerHTML; b.innerHTML = '⏳'; b.disabled = true; }
  else { b.innerHTML = b.dataset.orig || b.innerHTML; b.disabled = false; }
}

function showLobbyError(msg) {
  const e = $('lobby-error');
  e.textContent = msg; e.style.display = msg ? 'block' : 'none';
}

// ── CONNECTION STATUS ──
db.ref('.info/connected').on('value', snap => {
  const el = $('conn-status');
  if (snap.val()) { el.textContent = '● Connecté'; el.className = 'conn-status connected'; }
  else { el.textContent = '● Déconnecté'; el.className = 'conn-status disconnected'; }
});

// ── LOBBY ──
async function createRoom() {
  const name = $('input-name').value.trim();
  if (!name) return showToast('Entre ton pseudo');
  if (!currentUser) return showToast('Attends la connexion...');
  S.playerName = name; showLobbyError(''); setLoading('btn-create', true);
  try {
    const createFn = fn.httpsCallable('createRoom');
    const res = await createFn({
      name, playerId: currentUser.uid,
      settings: {
        smallBlind: +$('input-sb').value,
        bigBlind: +$('input-bb').value,
        startingStack: +$('input-stack').value,
        turnTimer: +$('input-timer').value,
      }
    });
    const {code, playerId, isHost, roomData} = res.data;
    S.roomCode = code; S.playerId = playerId; S.isHost = isHost;
    setupRoom(code, playerId);
    showScreen('game');
    $('header-room-name').textContent = 'Salle ' + code;
    $('header-blinds').textContent = roomData.smallBlind + ' / ' + roomData.bigBlind;
    updateUI(roomData, playerId);
    if (isHost) $('btn-start').style.display = 'flex';
  } catch(e) { showLobbyError(e.message); }
  finally { setLoading('btn-create', false); }
}

async function joinRoom() {
  const name = $('input-name').value.trim();
  const room = $('input-room').value.trim().toUpperCase();
  if (!name) return showToast('Entre ton pseudo');
  if (!room) return showToast('Entre le code');
  if (!currentUser) return showToast('Attends la connexion...');
  S.playerName = name; showLobbyError(''); setLoading('btn-join', true);
  try {
    const joinFn = fn.httpsCallable('joinRoom');
    const res = await joinFn({name, roomCode: room, playerId: currentUser.uid});
    const {code, playerId, isHost, roomData} = res.data;
    S.roomCode = code; S.playerId = playerId; S.isHost = isHost;
    setupRoom(code, playerId);
    showScreen('game');
    $('header-room-name').textContent = 'Salle ' + code;
    $('header-blinds').textContent = roomData.smallBlind + ' / ' + roomData.bigBlind;
    updateUI(roomData, playerId);
  } catch(e) { showLobbyError(e.message); }
  finally { setLoading('btn-join', false); }
}

// ── ROOM SETUP ──
function setupRoom(code, pid) {
  detachListeners();
  // Écouter les changements de la room
  S.roomListener = db.ref('rooms/' + code).on('value', snap => {
    const data = snap.val();
    if (!data) { showToast('Room supprimée'); showScreen('lobby'); return; }
    updateUI(data, pid);
  });
  // Écouter les événements
  S.eventListener = db.ref('events/' + code).limitToLast(1).on('child_added', snap => {
    const ev = snap.val();
    if (!ev || !ev.ev) return;
    handleEvent(ev);
  });
}

function detachListeners() {
  if (S.roomListener) { try { db.ref('rooms/' + S.roomCode).off('value', S.roomListener); } catch(e){} S.roomListener = null; }
  if (S.eventListener) { try { db.ref('events/' + S.roomCode).off('child_added', S.eventListener); } catch(e){} S.eventListener = null; }
  stopTimer();
}

function handleEvent(ev) {
  if (ev.ev === 'playerAction' && ev.data) {
    const d = ev.data;
    addLog(d.player, d.action, d.amount || 0);
  } else if (ev.ev === 'turnExpired' && ev.data) {
    showToast('⏱ ' + (ev.data.player || 'Joueur') + ' fold (temps)');
  } else if (ev.ev === 'playerJoined' && ev.data) {
    showToast('👋 ' + (ev.data.name || 'Joueur') + ' a rejoint');
  } else if (ev.ev === 'playerLeft') {
    showToast('👋 Un joueur est parti');
  }
}

// ── GAME LOGIC ──
async function startGame() {
  if (!S.isHost) return;
  try {
    const startFn = fn.httpsCallable('startGame');
    await startFn({code: S.roomCode, playerId: S.playerId});
    $('btn-start').style.display = 'none';
  } catch(e) { showToast('Erreur: ' + e.message); }
}

async function playerAction(type) {
  if (!S.myTurn) return;
  stopTimer();
  const amount = +$('raise-amount').value || 0;
  S.myTurn = false;
  setButtons(false);
  try {
    const actionFn = fn.httpsCallable('playerAction');
    const res = await actionFn({code: S.roomCode, action: type, amount, playerId: S.playerId});
    if (res.data?.roomData) updateUI(res.data.roomData, S.playerId);
    addLog(S.playerName, type, amount);
  } catch(e) {
    showToast('Erreur: ' + e.message);
    S.myTurn = true;
    setButtons(true);
  }
}

async function requestNextHand() {
  stopTimer();
  const btn = $('btn-next-hand');
  if (btn) btn.remove();
  try {
    const nextFn = fn.httpsCallable('nextHand');
    const res = await nextFn({code: S.roomCode, playerId: S.playerId});
    if (res.data?.roomData) updateUI(res.data.roomData, S.playerId);
  } catch(e) { showToast('Erreur: ' + e.message); }
}

function leaveGame() {
  stopTimer();
  detachListeners();
  if (S.roomCode && S.playerId) {
    const leaveFn = fn.httpsCallable('leaveRoom');
    leaveFn({code: S.roomCode, playerId: S.playerId}).catch(() => {});
  }
  S.roomCode = ''; S.playerId = ''; S.isHost = false; S.myTurn = false;
  showScreen('lobby');
  $('btn-start').style.display = 'none';
}

// ── UPDATE UI ──
function updateUI(gs, pid) {
  if (!gs) return;
  const playerId = pid || S.playerId;

  S.pot = gs.pot || 0;
  S.communityCards = gs.communityCards || [];
  S.phase = gs.phase || 'waiting';
  S.players = gs.players || [];
  S.currentBet = gs.currentBet || 0;
  S.bigBlind = gs.bigBlind || 10;
  S.turnDeadline = gs.turnDeadline || null;

  // Timer
  if (S.turnDeadline && S.phase !== 'showdown' && S.phase !== 'waiting') {
    startTimer(S.turnDeadline);
  } else {
    stopTimer();
    $('timer-text').textContent = '--';
    $('timer-text').classList.remove('warning','danger');
  }

  // Header
  $('pot-display').textContent = S.pot;
  $('header-players').textContent = S.players.length + ' joueurs';
  $('header-phase').textContent = {waiting:'Attente',preflop:'Pré-flop',flop:'Flop',turn:'Turn',river:'River',showdown:'Showdown'}[S.phase] || S.phase;
  $('header-phase').className = 'phase-badge phase-' + S.phase;

  renderCommunityCards(S.communityCards);
  renderSeats(S.players, gs.currentPlayerIndex);

  // Ma main
  const me = S.players.find(p => p.isMe);
  const handEl = $('my-hand-cards');
  if (handEl && me && me.cards && me.cards.length === 2) {
    handEl.innerHTML = me.cards.map(c => {
      if (!c || c.rank === '?') return '<div class="card mini hidden"></div>';
      const col = (c.suit === '♥' || c.suit === '♦') ? 'red' : 'black';
      return `<div class="card mini ${col}"><span class="rank">${c.rank}</span><span class="suit">${c.suit}</span></div>`;
    }).join('');
  } else if (handEl) {
    handEl.innerHTML = '';
  }

  // Force du main
  const strengthEl = $('hand-strength');
  if (strengthEl) {
    strengthEl.textContent = (me && me.cards && me.cards.length === 2 && S.communityCards.length >= 3)
      ? evalStrength(me.cards, S.communityCards) : '—';
  }

  $('info-current-bet').textContent = S.currentBet;

  // Mon tour ?
  if (me && !me.folded && gs.currentPlayerIndex >= 0 && gs.players && gs.currentPlayerIndex < gs.players.length) {
    const curr = gs.players[gs.currentPlayerIndex];
    if (curr && curr.id === playerId && !S.myTurn && S.phase !== 'showdown' && S.phase !== 'waiting') {
      S.myTurn = true;
      const toCall = S.currentBet - (me.bet || 0);
      $('call-label').textContent = toCall > 0 ? 'Suivre ' + toCall : 'Suivre';
      $('btn-call').querySelector('.btn-icon').textContent = toCall > 0 ? '💰' : '✅';
      $('raise-amount').value = S.currentBet + (gs.bigBlind || 10);
      setButtons(true);
    }
  }

  // Showdown → bouton main suivante
  if (S.phase === 'showdown' && !$('btn-next-hand')) {
    const btn = document.createElement('button');
    btn.id = 'btn-next-hand';
    btn.className = 'btn-action raise';
    btn.textContent = '🔄 Main suivante';
    btn.onclick = requestNextHand;
    $('action-buttons').appendChild(btn);
  }

  // Bouton démarrer
  if (S.phase === 'waiting' && S.isHost) $('btn-start').style.display = 'flex';
}

// ── CARDS ──
const SUIT_COLOR = {'♥':'red','♦':'red','♠':'black','♣':'black'};

function renderCard(el, rank, suit) {
  if (!el) return;
  el.className = 'card ' + (SUIT_COLOR[suit] || 'black');
  el.innerHTML = '<span class="rank">'+rank+'</span><span class="suit">'+suit+'</span>';
}

function renderCommunityCards(cards) {
  for (let i = 0; i < 5; i++) {
    const el = $('cc-' + i);
    if (cards && cards[i]) renderCard(el, cards[i].rank, cards[i].suit);
    else if (el) { el.className = 'card empty'; el.innerHTML = ''; }
  }
}

// ── SEATS ──
const SEATS = ['bottom','top-left','right','left','top-right','top'];

function renderSeats(players, currIdx) {
  const container = $('seats-container');
  container.innerHTML = '';
  players.forEach((p, i) => {
    const pos = SEATS[i] || 'bottom';
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.dataset.pos = pos;

    const initials = p.name.substring(0, 2).toUpperCase();
    const isCurrent = (currIdx === i);
    const avCls = ['avatar'];
    if (p.folded) avCls.push('folded');
    if (p.isDealer) avCls.push('dealer');
    if (isCurrent && !p.folded && p.isConnected) avCls.push('is-turn');

    const cardsHTML = p.isMe
      ? ((p.cards||[]).map(c => (!c||c.rank==='?') ? '<div class="card mini hidden"></div>' : '<div class="card mini '+(SUIT_COLOR[c.suit]||'black')+'"><span class="rank">'+c.rank+'</span><span class="suit">'+c.suit+'</span></div>').join(''))
      : ((p.cards||[]).length > 0 ? '<div class="card mini hidden"></div><div class="card mini hidden"></div>' : '');

    seat.innerHTML =
      (p.isMe && cardsHTML ? '<div class="seat-cards">'+cardsHTML+'</div>' : '') +
      '<div class="'+avCls.join(' ')+'">' + initials + (p.isDealer?'<div class="dealer-chip">D</div>':'') + '</div>' +
      '<div class="seat-name">'+p.name+(p.isMe?' <span class="you-badge">toi</span>':'')+'</div>' +
      '<div class="seat-stack">🪙 '+p.stack+'</div>' +
      (p.bet > 0 ? '<div class="seat-bet">'+p.bet+'</div>' : '') +
      (!p.isConnected ? '<div class="seat-disc">déconnecté</div>' : '') +
      (!p.isMe && cardsHTML ? '<div class="seat-cards">'+cardsHTML+'</div>' : '');

    container.appendChild(seat);
  });
}

// ── TIMER ──
function startTimer(deadline) {
  stopTimer();
  const el = $('timer-text');
  if (!el) return;
  S.timerInt = setInterval(() => {
    const rem = Math.max(0, deadline - Date.now());
    const secs = Math.ceil(rem / 1000);
    el.textContent = secs;
    el.classList.remove('warning','danger');
    if (secs <= 3) el.classList.add('danger');
    else if (secs <= 7) el.classList.add('warning');
    if (rem <= 0) {
      stopTimer();
      if (S.myTurn && S.roomCode) {
        S.myTurn = false;
        setButtons(false);
        showToast('⏱ Temps écoulé!');
        const checkFn = fn.httpsCallable('checkTimer');
        checkFn({code: S.roomCode}).catch(() => {});
      }
    }
  }, 200);
}

function stopTimer() {
  if (S.timerInt) { clearInterval(S.timerInt); S.timerInt = null; }
}

// ── BUTTONS ──
function setButtons(on) {
  document.querySelectorAll('.btn-action').forEach(b => {
    b.style.opacity = on ? '1' : '0.35';
    b.disabled = !on;
  });
  S.myTurn = on;
}

// ── QUICK BET ──
function setQuickBet(type) {
  const input = $('raise-amount'); if (!input) return;
  const me = S.players.find(p => p.isMe); if (!me) return;
  const pot = S.pot || 0;
  let amount = 0;
  switch(type) {
    case 'third': amount = Math.round(pot/3); break;
    case 'half': amount = Math.round(pot/2); break;
    case 'twothird': amount = Math.round(pot*2/3); break;
    case 'pot': amount = pot; break;
    case 'allin': amount = me.stack + (me.bet||0); break;
  }
  const minR = S.currentBet + (S.bigBlind||10);
  if (type !== 'allin' && amount < minR) amount = minR;
  input.value = amount;
  input.focus();
}
window.setQuickBet = setQuickBet;

// ── LOG ──
function addLog(player, action, amount) {
  const log = $('log');
  const line = document.createElement('div');
  line.className = 'log-line';
  const icons = {fold:'🏳️',check:'✋',call:'💰',raise:'🚀'};
  const text = {fold:'se couche',check:'checke',call:'suit '+(amount||0),raise:'relance à '+(amount||0)};
  line.innerHTML = '<span class="log-icon">'+(icons[action]||'•')+'</span><span class="log-player">'+player+'</span> '+(text[action]||action);
  log.prepend(line);
  if (log.children.length > 15) log.lastChild.remove();
}

// ── HAND STRENGTH (client) ──
function evalStrength(hole, community) {
  const all = [...hole,...community];
  const RV = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
  const counts = {};
  for(const c of all){const v=RV[c.rank]||0;counts[v]=(counts[v]||0)+1;}
  const pairs=Object.values(counts).filter(c=>c===2).length;
  const trips=Object.values(counts).filter(c=>c===3).length;
  const quads=Object.values(counts).filter(c=>c===4).length;
  if(quads) return 'Carré';
  if(trips&&pairs) return 'Full';
  if(trips) return 'Brelan';
  if(pairs===2) return 'Double paire';
  if(pairs===1) return 'Paire';
  return 'Carte haute';
}
