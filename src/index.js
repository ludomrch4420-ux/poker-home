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
function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function deal(d, n) { return d.splice(0, n); }
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
  const s = [...new Set(values)].sort((a,b) => a-b);
  if (s.length < 5) return { is: false };
  if (s.includes(14) && s.includes(2) && s.includes(3) && s.includes(4) && s.includes(5)) return { is: true, high: 5 };
  for (let i = s.length-1; i >= 4; i--) {
    if (s[i] - s[i-4] === 4) { let ok = true; for (let j = i-4; j < i; j++) { if (s[j+1]-s[j] !== 1) { ok = false; break; } } if (ok) return { is: true, high: s[i] }; }
  }
  return { is: false };
}
function isFlush(cards) {
  const sc = countBySuit(cards);
  for (const [suit, count] of sc) { if (count >= 5) return { is: true, suit, cards: cards.filter(c => c.suit === suit) }; }
  return { is: false };
}
function evaluateHand(hole, community) {
  const all = [...hole, ...community];
  const values = all.map(cv);
  const counts = countByValue(all);
  const byCount = new Map();
  for (const [val, cnt] of counts) { if (!byCount.has(cnt)) byCount.set(cnt, []); byCount.get(cnt).push(val); }
  for (const [cnt, vals] of byCount) vals.sort((a,b) => b-a);
  const fr = isFlush(all), sr = isStraight(values);
  if (fr.is && sr.is) { const sv = fr.cards.map(cv); const ss = isStraight(sv); if (ss.is && ss.high === 14) return { rank:9, name:'Quinte flush royale', values:[14] }; if (ss.is) return { rank:8, name:'Quinte flush', values:[ss.high] }; }
  if (byCount.has(4)) { const q = byCount.get(4)[0]; const k = values.filter(v=>v!==q).sort((a,b)=>b-a)[0]; return { rank:7, name:'Carré', values:[q, k] }; }
  if (byCount.has(3) && byCount.has(2)) return { rank:6, name:'Full', values:[byCount.get(3)[0], byCount.get(2)[0]] };
  if (byCount.has(3) && byCount.get(3).length >= 2) { const t = byCount.get(3).sort((a,b)=>b-a); return { rank:6, name:'Full', values:[t[0],t[1]] }; }
  if (fr.is) return { rank:5, name:'Couleur', values:fr.cards.map(cv).sort((a,b)=>b-a).slice(0,5) };
  if (sr.is) return { rank:4, name:'Suite', values:[sr.high] };
  if (byCount.has(3)) { const tv = byCount.get(3)[0]; return { rank:3, name:'Brelan', values:[tv, ...values.filter(v=>v!==tv).sort((a,b)=>b-a).slice(0,2)] }; }
  if (byCount.has(2) && byCount.get(2).length >= 2) { const p = byCount.get(2).sort((a,b)=>b-a).slice(0,2); return { rank:2, name:'Double paire', values:[...p, values.filter(v=>!p.includes(v)).sort((a,b)=>b-a)[0]] }; }
  if (byCount.has(2)) { const pv = byCount.get(2)[0]; return { rank:1, name:'Paire', values:[pv, ...values.filter(v=>v!==pv).sort((a,b)=>b-a).slice(0,3)] }; }
  return { rank:0, name:'Carte haute', values:[...values].sort((a,b)=>b-a).slice(0,5) };
}
function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.values.length, b.values.length); i++) { if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i]; }
  return 0;
}
function findWinners(players, community) {
  const active = players.map((p,i) => ({...p, index:i})).filter(p => !p.folded && p.cards.length === 2);
  if (active.length === 0) return [];
  if (active.length === 1) return [active[0].index];
  const ev = active.map(p => ({ index:p.index, hand:evaluateHand(p.cards, community) }));
  ev.sort((a,b) => compareHands(b.hand, a.hand));
  const best = ev[0];
  return ev.filter(e => compareHands(e.hand, best.hand) === 0).map(w => w.index);
}

// ═══════════════════════════════════════════════════════════
//  GAME ROOM
// ═══════════════════════════════════════════════════════════
const DEFAULTS = { smallBlind:5, bigBlind:10, startingStack:1000, turnTimer:20000, maxPlayers:6 };

function createPlayer(id, name, stack) {
  return { id, name, stack: stack||DEFAULTS.startingStack, cards:[], bet:0, totalBet:0, folded:false, allIn:false, isDealer:false, isConnected:true };
}

class GameRoom {
  constructor(code, settings={}) {
    this.code = code; this.settings = {...DEFAULTS, ...settings};
    this.players=[]; this.deck=[]; this.communityCards=[]; this.pot=0;
    this.phase='waiting'; this.dealerIndex=-1; this.currentPlayerIndex=-1;
    this.currentBet=0; this.minRaise=this.settings.bigBlind; this.actionTimer=null; this.hostId=null;
  }
  getData(forId=null) {
    return { code:this.code, phase:this.phase, pot:this.pot, smallBlind:this.settings.smallBlind, bigBlind:this.settings.bigBlind, startingStack:this.settings.startingStack, turnTimer:this.settings.turnTimer, communityCards:this.communityCards, currentBet:this.currentBet, dealerIndex:this.dealerIndex, currentPlayerIndex:this.currentPlayerIndex, players:this.players.map(p=>({id:p.id,name:p.name,stack:p.stack,bet:p.bet,folded:p.folded,allIn:p.allIn,isDealer:p.isDealer,isMe:p.id===forId,cards:(p.id===forId||this.phase==='showdown')?p.cards:(p.cards.length>0?[{rank:'?',suit:'?'},{rank:'?',suit:'?'}]:[])})) };
  }
  addPlayer(id, name) {
    if (this.players.length >= this.settings.maxPlayers) return {error:`Room pleine (max ${this.settings.maxPlayers})`};
    if (this.phase !== 'waiting') return {error:'Partie déjà en cours'};
    if (this.players.find(p=>p.id===id)) return {error:'Déjà dans la room'};
    const player = createPlayer(id, name, this.settings.startingStack);
    this.players.push(player);
    if (this.players.length===1) { player.isDealer=true; this.dealerIndex=0; this.hostId=id; }
    return {player, roomData:this.getData()};
  }
  removePlayer(id) {
    const idx=this.players.findIndex(p=>p.id===id); if (idx===-1) return null;
    this.players.splice(idx,1);
    if (this.phase==='waiting') {
      if (this.players.length===0) { this.dealerIndex=-1; this.hostId=null; }
      else if (idx===this.dealerIndex||this.dealerIndex>=this.players.length) { this.dealerIndex=0; this.players[0].isDealer=true; this.hostId=this.players[0].id; }
    } else { const player=this.players[idx]; player.folded=true; player.isConnected=false; if (this.currentPlayerIndex===idx) this.nextPlayer(); else if (this.currentPlayerIndex>idx) this.currentPlayerIndex--; }
    return this.getData();
  }
  startGame() {
    if (this.players.length<2) return {error:'Il faut au moins 2 joueurs'};
    if (this.phase!=='waiting') return {error:'Partie déjà en cours'};
    this.dealCards(); return {roomData:this.getData()};
  }
  dealCards() {
    this.deck=createShuffledDeck(); this.communityCards=[]; this.pot=0; this.currentBet=0; this.minRaise=this.settings.bigBlind;
    for (const p of this.players) { p.cards=[]; p.bet=0; p.totalBet=0; p.folded=false; p.allIn=false; }
    this.dealerIndex=(this.dealerIndex+1)%this.players.length;
    this.players.forEach((p,i)=>{p.isDealer=(i===this.dealerIndex)});
    for (const p of this.players) p.cards=deal(this.deck,2);
    const sb=(this.dealerIndex+1)%this.players.length, bb=(this.dealerIndex+2)%this.players.length;
    this._placeBet(this.players[sb],this.settings.smallBlind); this._placeBet(this.players[bb],this.settings.bigBlind);
    this.currentBet=this.settings.bigBlind; this.phase='preflop'; this.currentPlayerIndex=(bb+1)%this.players.length;
    this._skipPlayersWhoCantAct(); this._startTimer();
  }
  _placeBet(player, amount) { const a=Math.min(amount,player.stack); player.stack-=a; player.bet+=a; player.totalBet+=a; this.pot+=a; if (player.stack===0) player.allIn=true; }
  _nextActivePlayer() { let idx=this.currentPlayerIndex, looped=false; while(true) { idx=(idx+1)%this.players.length; if (idx===this.currentPlayerIndex) { if (looped) return -1; looped=true; } const p=this.players[idx]; if (!p.folded&&!p.allIn) return idx; } }
  _skipPlayersWhoCantAct() { const p=this.players[this.currentPlayerIndex]; if (p.folded||p.allIn) this.currentPlayerIndex=this._nextActivePlayer(); }
  nextPlayer() {
    this._clearTimer();
    const next = this._nextActivePlayer();
    const active = this.players.filter(p => !p.folded);
    const nai = active.filter(p => !p.allIn);
    const allMatched = nai.every(p => p.bet === this.currentBet);
    // Phase ends when all non-all-in players have matched the bet AND
    // we've gone around the table (next would be the first player again)
    const firstAfterDealer = this._firstAfterDealer();
    const roundComplete = allMatched && (next === firstAfterDealer || next === -1 || next === this.currentPlayerIndex);
    if (next === -1 || roundComplete) { this._endPhase(); return; }
    this.currentPlayerIndex = next;
    this._startTimer();
  }
  _endPhase() {
    for (const p of this.players) { p.bet=0; p.totalBet=0; } this.currentBet=0; this.minRaise=this.settings.bigBlind;
    const ap=this.players.filter(p=>!p.folded); if (ap.length<=1) { this._declareWinner(ap); return; }
    const phases=['preflop','flop','turn','river'], ci=phases.indexOf(this.phase);
    if (ci===-1) { this._showdown(); return; }
    const np=phases[ci+1];
    if (np==='flop') this.communityCards=deal(this.deck,3); else this.communityCards.push(...deal(this.deck,1));
    this.phase=np; this.currentPlayerIndex=this._firstAfterDealer(); this._skipPlayersWhoCantAct(); this._startTimer();
  }
  _firstAfterDealer() { if (this.players.length===0) return -1; let idx=(this.dealerIndex+1)%this.players.length, looped=false; while(true) { if (!this.players[idx].folded&&!this.players[idx].allIn) return idx; idx=(idx+1)%this.players.length; if (idx===(this.dealerIndex+1)) { if (looped) return this.dealerIndex; looped=true; } } }
  _showdown() { this.phase='showdown'; this._clearTimer(); const w=findWinners(this.players,this.communityCards); if (w.length===1) this.players[w[0]].stack+=this.pot; else if (w.length>1) { const s=Math.floor(this.pot/w.length); for (const i of w) this.players[i].stack+=s; } this.pot=0; }
  _declareWinner(r) { this.phase='showdown'; this._clearTimer(); if (r.length===1) r[0].stack+=this.pot; this.pot=0; }
  nextHand() {
    if (this.phase!=='showdown') return {error:'Pas terminée'};
    this.players=this.players.filter(p=>p.stack>0);
    if (this.players.length<2) { this.phase='waiting'; return {roomData:this.getData(),message:'Pas assez de joueurs'}; }
    this.dealCards(); return {roomData:this.getData()};
  }
  fold(id) { const p=this._validateTurn(id); if (!p) return {error:'Pas ton tour'}; p.folded=true; this.nextPlayer(); return {action:'fold',player:p.name,roomData:this.getData()}; }
  check(id) { const p=this._validateTurn(id); if (!p) return {error:'Pas ton tour'}; if (p.bet<this.currentBet) return {error:'Pas checker'}; this.nextPlayer(); return {action:'check',player:p.name,roomData:this.getData()}; }
  call(id) { const p=this._validateTurn(id); if (!p) return {error:'Pas ton tour'}; const tc=Math.min(this.currentBet-p.bet,p.stack); this._placeBet(p,tc); this.nextPlayer(); return {action:'call',player:p.name,amount:tc,roomData:this.getData()}; }
  raise(id, amount) { const p=this._validateTurn(id); if (!p) return {error:'Pas ton tour'}; const ma=this.currentBet+this.minRaise; if (amount<ma) return {error:`Min: ${ma}`}; if (amount>p.stack+p.bet) return {error:'Pas assez'}; const ta=amount-p.bet; this.minRaise=amount-this.currentBet; this.currentBet=amount; this._placeBet(p,ta); this.nextPlayer(); return {action:'raise',player:p.name,amount,roomData:this.getData()}; }
  _validateTurn(id) { if (this.currentPlayerIndex<0||this.currentPlayerIndex>=this.players.length) return null; const p=this.players[this.currentPlayerIndex]; if (p.id!==id||p.folded||p.allIn) return null; return p; }
  _startTimer() { this._clearTimer(); this.actionTimer=setTimeout(()=>{ const p=this.players[this.currentPlayerIndex]; if (p&&p.id) this.fold(p.id); }, this.settings.turnTimer); }
  _clearTimer() { if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer=null; } }
}

// ═══════════════════════════════════════════════════════════
//  ROOMS REGISTRY
// ═══════════════════════════════════════════════════════════
const rooms = new Map();
function getOrCreateRoom(code, settings) { if (!rooms.has(code)) rooms.set(code, new GameRoom(code, settings)); return rooms.get(code); }
function cleanupRoom(code) { const r=rooms.get(code); if (r&&r.players.length===0) { r._clearTimer(); rooms.delete(code); } }

// ═══════════════════════════════════════════════════════════
//  HTTP API HANDLER
// ═══════════════════════════════════════════════════════════
const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const error = (msg, status=400) => json({ error: msg }, status);

async function handleAPI(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS preflight
  if (method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type' } });

  try {
    const body = method === 'POST' ? await request.json() : {};
    const playerId = request.headers.get('x-player-id') || '';

    // ─── CREATE ROOM ──────────────────────────────────────
    if (path === '/api/room' && method === 'POST') {
      const { name, settings } = body;
      if (!name?.trim()) return error('Pseudo requis');
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const s = { smallBlind: parseInt(settings?.smallBlind)||5, bigBlind: parseInt(settings?.bigBlind)||10, startingStack: parseInt(settings?.startingStack)||1000, turnTimer: (parseInt(settings?.turnTimer)||20)*1000 };
      const room = getOrCreateRoom(code, s);
      const pid = crypto.randomUUID();
      const result = room.addPlayer(pid, name.trim());
      if (result.error) return error(result.error);
      return json({ type: 'roomJoined', code, playerId: pid, isHost: true, roomData: room.getData(pid) });
    }

    // ─── JOIN ROOM ────────────────────────────────────────
    if (path === '/api/room/join' && method === 'POST') {
      const { name, room: rc } = body;
      if (!name?.trim()) return error('Pseudo requis');
      if (!rc?.trim()) return error('Code requis');
      const code = rc.trim().toUpperCase();
      const room = getOrCreateRoom(code);
      const pid = crypto.randomUUID();
      const result = room.addPlayer(pid, name.trim());
      if (result.error) return error(result.error);
      return json({ type: 'roomJoined', code, playerId: pid, isHost: false, roomData: room.getData(pid) });
    }

    // ─── START GAME ───────────────────────────────────────
    if (path === '/api/game/start' && method === 'POST') {
      const { code, playerId: pid } = body;
      const room = rooms.get(code);
      if (!room) return error('Room introuvable');
      const result = room.startGame();
      if (result.error) return error(result.error);
      return json({ type: 'gameState', roomData: room.getData(pid) });
    }

    // ─── PLAYER ACTION ────────────────────────────────────
    if (path === '/api/game/action' && method === 'POST') {
      const { code, playerId: pid, action, amount } = body;
      const room = rooms.get(code);
      if (!room) return error('Room introuvable');
      let result;
      switch (action) {
        case 'fold': result = room.fold(pid); break;
        case 'check': result = room.check(pid); break;
        case 'call': result = room.call(pid); break;
        case 'raise': result = room.raise(pid, amount); break;
        default: return error('Action inconnue');
      }
      if (result.error) return error(result.error);
      return json({ type: 'actionLog', player: result.player, action: result.action, amount: result.amount||0, roomData: room.getData(pid) });
    }

    // ─── GET GAME STATE ───────────────────────────────────
    if (path === '/api/game/state' && method === 'GET') {
      const code = url.searchParams.get('code');
      const pid = url.searchParams.get('playerId') || '';
      const room = rooms.get(code);
      if (!room) return error('Room introuvable');
      return json({ type: 'gameState', roomData: room.getData(pid) });
    }

    // ─── NEXT HAND ────────────────────────────────────────
    if (path === '/api/game/next' && method === 'POST') {
      const { code } = body;
      const room = rooms.get(code);
      if (!room) return error('Room introuvable');
      const result = room.nextHand();
      if (result.error) return error(result.error);
      return json({ type: 'gameState', roomData: room.getData() });
    }

    // ─── LEAVE ROOM ───────────────────────────────────────
    if (path === '/api/room/leave' && method === 'POST') {
      const { code, playerId: pid } = body;
      const room = rooms.get(code);
      if (room) { room.removePlayer(pid); cleanupRoom(code); }
      return json({ ok: true });
    }

    return error('Route introuvable', 404);
  } catch (err) {
    console.error('API error:', err);
    return error('Erreur serveur', 500);
  }
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request);
    }
    return env.ASSETS.fetch(request);
  },
};
