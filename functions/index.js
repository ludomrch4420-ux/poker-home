/**
 * PokerHome v2 — Cloud Functions (Firebase Realtime Database)
 * Texas Hold'em multiplayer
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const rtdb = admin.database();
const fs = admin.firestore();

// ── CONSTANTES ──────────────────────────────────────────
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
const PHASES = ['preflop','flop','turn','river','showdown'];
const RV = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const DFLT = { smallBlind:5, bigBlind:10, startingStack:1000, turnTimer:20, maxPlayers:6 };

// ── OUTILS CARTES ───────────────────────────────────────
function createDeck() { return SUITS.flatMap(s => RANKS.map(r => ({rank:r,suit:s}))); }
function shuffle(d) { for(let i=d.length-1;i>0;i++){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];} return d; }
function deal(d,n) { return d.splice(0,n); }
const cv = c => RV[c.rank]||0;

// ── EVALUATION DE MAIN ──────────────────────────────────
function evaluateHand(hole, community) {
  const all = [...hole,...community];
  const vals = all.map(cv);
  const sc = {}; all.forEach(c=>{ sc[c.suit]=(sc[c.suit]||0)+1; });
  const vc = {}; vals.forEach(v=>{ vc[v]=(vc[v]||0)+1; });
  
  let flushSuit = null;
  for(const [s,c] of Object.entries(sc)) if(c>=5){ flushSuit=s; break; }
  
  function isStr(v) {
    const u=[...new Set(v)].sort((a,b)=>a-b);
    if(u.length<5) return {is:false};
    if(u.includes(14)&&u.includes(2)&&u.includes(3)&&u.includes(4)&&u.includes(5)) return {is:true,high:5};
    for(let i=u.length-1;i>=4;i--){
      if(u[i]-u[i-4]===4){let ok=true;for(let j=i-4;j<i;j++)if(u[j+1]-u[j]!==1){ok=false;break;}if(ok)return {is:true,high:u[i]};}
    }
    return {is:false};
  }
  
  const str = isStr(vals);
  
  // Quinte flush
  if(flushSuit&&str.is){
    const fc=all.filter(c=>c.suit===flushSuit).map(cv);
    const fs=isStr(fc);
    if(fs.is) return fs.high===14?{rank:9,n:'QFR',v:[14]}:{rank:8,n:'QF',v:[fs.high]};
  }
  
  // Groupes par count
  const g={1:[],2:[],3:[],4:[]};
  for(const[val,cnt]of Object.entries(vc)) if(g[cnt]) g[cnt].push(+val);
  for(const c of Object.keys(g)) g[c].sort((a,b)=>b-a);
  
  if(g[4].length) return {rank:7,n:'Carre',v:[g[4][0],vals.filter(v=>v!==g[4][0]).sort((a,b)=>b-a)[0]]};
  if(g[3].length>=2) return {rank:6,n:'Full',v:[g[3][0],g[3][1]]};
  if(g[3].length&&g[2].length) return {rank:6,n:'Full',v:[g[3][0],g[2][0]]};
  if(flushSuit){const fc=all.filter(c=>c.suit===flushSuit).map(cv).sort((a,b)=>b-a);return{rank:5,n:'Couleur',v:fc.slice(0,5)};}
  if(str.is) return {rank:4,n:'Suite',v:[str.high]};
  if(g[3].length){const t=g[3][0];return{rank:3,n:'Brelan',v:[t,...vals.filter(v=>v!==t).sort((a,b)=>b-a).slice(0,2)]};}
  if(g[2].length>=2){const p=g[2].slice(0,2);return{rank:2,n:'2Paire',v:[...p,vals.filter(v=>!p.includes(v)).sort((a,b)=>b-a)[0]]};}
  if(g[2].length){const p=g[2][0];return{rank:1,n:'Paire',v:[p,...vals.filter(v=>v!==p).sort((a,b)=>b-a).slice(0,3)]};}
  return {rank:0,n:'Haute',v:vals.sort((a,b)=>b-a).slice(0,5)};
}

function cmpHands(a,b) {
  if(a.rank!==b.rank) return a.rank-b.rank;
  for(let i=0;i<Math.min(a.v.length,b.v.length);i++) if(a.v[i]!==b.v[i]) return a.v[i]-b.v[i];
  return 0;
}

// ── HELPERS JEU ─────────────────────────────────────────
async function getRoom(code) { return (await rtdb.ref(`rooms/${code}`).once('value')).val(); }
async function saveRoom(code,state) { await rtdb.ref(`rooms/${code}`).set(state); }
async function notify(code,ev,data) { await rtdb.ref(`events/${code}`).push({ev,data,ts:admin.database.ServerValue.TIMESTAMP}); }

function findNext(room, from) {
  let i=(from+1)%room.players.length, a=0;
  while(a<room.players.length){
    if(room.players[i].isConnected&&!room.players[i].folded&&!room.players[i].allIn) return i;
    i=(i+1)%room.players.length; a++;
  }
  return -1;
}

function placeBet(room,p,amt) {
  const a=Math.min(amt,p.stack);
  p.stack-=a; p.bet+=a; p.totalBet+=a; room.pot+=a;
  if(p.stack===0) p.allIn=true;
  return a;
}

function firstAfterDealer(room) {
  let i=(room.dealerIndex+1)%room.players.length;
  for(let a=0;a<room.players.length;a++){
    if(room.players[i].isConnected&&!room.players[i].folded&&!room.players[i].allIn) return i;
    i=(i+1)%room.players.length;
  }
  for(let a=0;a<room.players.length;a++) if(room.players[a].isConnected&&!room.players[a].folded) return a;
  return room.dealerIndex;
}

function countActive(room) { return room.players.filter(p=>p.isConnected&&!p.folded).length; }
function countCanAct(room) { return room.players.filter(p=>p.isConnected&&!p.folded&&!p.allIn).length; }

function advanceTurn(room) {
  if(countActive(room)<=1){endPhase(room);return;}
  if(countCanAct(room)===0){dealRest(room);doShowdown(room);return;}
  const nai=room.players.filter(p=>p.isConnected&&!p.folded&&!p.allIn);
  const allMatch=nai.every(p=>p.bet===room.currentBet);
  const next=findNext(room,room.currentPlayerIndex);
  if(next===-1||next===room.currentPlayerIndex||allMatch){endPhase(room);return;}
  room.currentPlayerIndex=next;
}

function dealRest(room) {
  const ci=PHASES.indexOf(room.phase);
  for(let i=ci+1;i<PHASES.length-1;i++){
    if(PHASES[i]==='flop') room.communityCards=deal(room.deck,3);
    else room.communityCards.push(...deal(room.deck,1));
  }
}

function endPhase(room) {
  for(const p of room.players) p.bet=0;
  room.currentBet=0; room.minRaise=room.settings.bigBlind;
  if(countActive(room)<=1){doShowdown(room);return;}
  if(countCanAct(room)<=1){dealRest(room);doShowdown(room);return;}
  const ci=PHASES.indexOf(room.phase);
  if(ci>=PHASES.length-2){doShowdown(room);return;}
  const np=PHASES[ci+1];
  if(np==='flop') room.communityCards=deal(room.deck,3);
  else room.communityCards.push(...deal(room.deck,1));
  room.phase=np; room.currentPlayerIndex=firstAfterDealer(room);
}

function doShowdown(room) {
  room.phase='showdown'; room.handComplete=true;
  const cont=room.players.map((p,i)=>({...p,_i:i})).filter(p=>!p.folded&&p.cards.length===2);
  
  if(cont.length===0){
    const con=room.players.map((p,i)=>({p,i})).filter(({p})=>p.isConnected);
    if(con.length>0){const s=Math.floor(room.pot/con.length);for(const{i}of con)room.players[i].stack+=s;}
  } else if(cont.length===1){
    room.players[cont[0]._i].stack+=room.pot;
  } else {
    const ev=cont.map(c=>({i:c._i,h:evaluateHand(c.cards,room.communityCards)}));
    ev.sort((a,b)=>cmpHands(b.h,a.h));
    const best=ev[0];
    const winners=ev.filter(e=>cmpHands(e.h,best.h)===0);
    const share=Math.floor(room.pot/winners.length);
    const rem=room.pot%winners.length;
    for(const w of winners) room.players[w.i].stack+=share;
    if(rem>0&&winners.length>0) room.players[winners[0].i].stack+=rem;
  }
  room.pot=0;
}

async function expireTimer(code) {
  const room=await getRoom(code);
  if(!room||room.phase==='waiting'||room.phase==='showdown'||!room.turnDeadline) return null;
  if(Date.now()<room.turnDeadline) return null;
  if(room.currentPlayerIndex<0||room.currentPlayerIndex>=room.players.length) return null;
  const p=room.players[room.currentPlayerIndex];
  if(!p||p.folded||p.allIn) return null;
  p.folded=true;
  advanceTurn(room);
  if(room.phase!=='showdown'&&room.phase!=='waiting') room.turnDeadline=Date.now()+(room.settings.turnTimer*1000);
  else room.turnDeadline=null;
  room.lastAction=Date.now();
  await saveRoom(code,room);
  await notify(code,'turnExpired',{player:p.name});
  return {expired:true,player:p.name};
}

function sanitize(room, pid) {
  if(!room) return null;
  return {
    code:room.code, phase:room.phase, pot:room.pot||0,
    smallBlind:room.settings?.smallBlind??DFLT.smallBlind,
    bigBlind:room.settings?.bigBlind??DFLT.bigBlind,
    startingStack:room.settings?.startingStack??DFLT.startingStack,
    turnTimer:room.settings?.turnTimer??DFLT.turnTimer,
    maxPlayers:room.settings?.maxPlayers??DFLT.maxPlayers,
    communityCards:room.communityCards||[], currentBet:room.currentBet||0,
    dealerIndex:room.dealerIndex, currentPlayerIndex:room.currentPlayerIndex,
    handComplete:room.handComplete||false, turnDeadline:room.turnDeadline||null,
    players:(room.players||[]).map(p=>({
      id:p.id, name:p.name, stack:p.stack, bet:p.bet, totalBet:p.totalBet||0,
      folded:p.folded, allIn:p.allIn, isDealer:p.isDealer, isConnected:p.isConnected,
      isMe:p.id===pid,
      cards:(p.id===pid||room.phase==='showdown')?(p.cards||[]):((p.cards||[]).length>0?[{rank:'?',suit:'?'},{rank:'?',suit:'?'}]:[]),
    })),
  };
}

// ── FONCTIONS HTTP ──────────────────────────────────────

exports.createRoom = functions.https.onCall(async(data,ctx)=>{
  const name=(data.name||'').trim();
  if(!name) throw new functions.https.HttpsError('invalid-argument','Pseudo requis');
  const settings={
    smallBlind:+data.settings?.smallBlind||DFLT.smallBlind,
    bigBlind:+data.settings?.bigBlind||DFLT.bigBlind,
    startingStack:+data.settings?.startingStack||DFLT.startingStack,
    turnTimer:+data.settings?.turnTimer||DFLT.turnTimer,
    maxPlayers:+data.settings?.maxPlayers||DFLT.maxPlayers,
  };
  let code; let attempts=0;
  do{code=Math.random().toString(36).substring(2,8).toUpperCase();attempts++;}
  while(await getRoom(code)&&attempts<20);
  if(attempts>=20) throw new functions.https.HttpsError('internal','Code generation failed');
  const pid=ctx.auth?.uid||`anon_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
  const state={
    code, settings, phase:'waiting', pot:0, deck:[], communityCards:[],
    dealerIndex:0, currentPlayerIndex:-1, currentBet:0, minRaise:settings.bigBlind,
    handComplete:false, turnDeadline:null, lastAction:Date.now(),
    createdAt:admin.database.ServerValue.TIMESTAMP,
    players:[{id:pid,name,stack:settings.startingStack,cards:[],bet:0,totalBet:0,folded:false,allIn:false,isDealer:true,isConnected:true}],
  };
  await saveRoom(code,state);
  return {code,playerId:pid,isHost:true,roomData:sanitize(state,pid)};
});

exports.joinRoom = functions.https.onCall(async(data,ctx)=>{
  const name=(data.name||'').trim();
  const roomCode=(data.roomCode||'').trim().toUpperCase();
  if(!name) throw new functions.https.HttpsError('invalid-argument','Pseudo requis');
  if(!roomCode) throw new functions.https.HttpsError('invalid-argument','Code requis');
  const room=await getRoom(roomCode);
  if(!room) throw new functions.https.HttpsError('not-found','Salle introuvable');
  if(room.phase!=='waiting') throw new functions.https.HttpsError('failed-precondition','Partie en cours');
  if(room.players.length>=(room.settings.maxPlayers||DFLT.maxPlayers)) throw new functions.https.HttpsError('resource-exhausted','Room pleine');
  const pid=data.playerId||ctx.auth?.uid||`anon_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
  const existing=room.players.find(p=>p.id===pid);
  if(existing){existing.isConnected=true;await saveRoom(roomCode,room);return{code:roomCode,playerId:pid,isHost:false,roomData:sanitize(room,pid)};}
  room.players.push({id:pid,name,stack:room.settings.startingStack,cards:[],bet:0,totalBet:0,folded:false,allIn:false,isDealer:false,isConnected:true});
  await saveRoom(roomCode,room);
  return {code:roomCode,playerId:pid,isHost:false,roomData:sanitize(room,pid)};
});

exports.startGame = functions.https.onCall(async(data,ctx)=>{
  const code=(data.code||'').trim().toUpperCase();
  const pid=ctx.auth?.uid||data.playerId;
  const room=await getRoom(code);
  if(!room) throw new functions.https.HttpsError('not-found','Room introuvable');
  if(room.phase!=='waiting') throw new functions.https.HttpsError('failed-precondition','Partie en cours');
  if(room.players.filter(p=>p.isConnected).length<2) throw new functions.https.HttpsError('failed-precondition','Il faut 2 joueurs');
  if(room.players.filter(p=>p.isConnected)[0].id!==pid) throw new functions.https.HttpsError('permission-denied','Seul le host peut démarrer');
  
  const deck=shuffle(createDeck());
  room.communityCards=[]; room.pot=0; room.currentBet=0; room.minRaise=room.settings.bigBlind; room.handComplete=false;
  for(const p of room.players){p.cards=[];p.bet=0;p.totalBet=0;p.folded=false;p.allIn=false;}
  
  let att=0; do{room.dealerIndex=(room.dealerIndex+1)%room.players.length;att++;}
  while(!room.players[room.dealerIndex].isConnected&&att<room.players.length);
  room.players.forEach((p,i)=>{p.isDealer=(i===room.dealerIndex);});
  for(const p of room.players) p.cards=deal(deck,2);
  room.deck=deck;
  
  const sb=findNext(room,room.dealerIndex);
  const bb=findNext(room,sb);
  placeBet(room,room.players[sb],room.settings.smallBlind);
  placeBet(room,room.players[bb],room.settings.bigBlind);
  room.currentBet=room.settings.bigBlind;
  room.phase='preflop';
  room.currentPlayerIndex=findNext(room,bb);
  room.lastAction=Date.now();
  room.turnDeadline=Date.now()+(room.settings.turnTimer*1000);
  
  await saveRoom(code,room);
  return {roomData:sanitize(room,pid)};
});

exports.playerAction = functions.https.onCall(async(data,ctx)=>{
  const code=(data.code||'').trim().toUpperCase();
  const pid=ctx.auth?.uid||data.playerId;
  if(!pid) throw new functions.https.HttpsError('unauthenticated','Non authentifié');
  const action=data.action, amount=+data.amount||0;
  const room=await getRoom(code);
  if(!room) throw new functions.https.HttpsError('not-found','Room introuvable');
  if(room.handComplete) throw new functions.https.HttpsError('failed-precondition','Main terminée');
  if(room.currentPlayerIndex<0||room.currentPlayerIndex>=room.players.length) throw new functions.https.HttpsError('failed-precondition','Pas de joueur actif');
  const cp=room.players[room.currentPlayerIndex];
  if(cp.id!==pid) throw new functions.https.HttpsError('permission-denied','Pas ton tour');
  if(cp.folded||cp.allIn) throw new functions.https.HttpsError('failed-precondition','Tu ne peux pas agir');
  if(room.turnDeadline&&Date.now()>room.turnDeadline) throw new functions.https.HttpsError('deadline-exceeded','Temps écoulé');
  
  let result;
  switch(action){
    case'fold': cp.folded=true; advanceTurn(room); result={action:'fold',player:cp.name}; break;
    case'check':
      if(cp.bet<room.currentBet) throw new functions.https.HttpsError('failed-precondition','Tu ne peux pas checker');
      advanceTurn(room); result={action:'check',player:cp.name}; break;
    case'call':
      const toCall=Math.min(room.currentBet-cp.bet,cp.stack);
      placeBet(room,cp,toCall); advanceTurn(room);
      result={action:'call',player:cp.name,amount:toCall}; break;
    case'raise':
      const minAmt=room.currentBet+room.minRaise;
      if(amount<minAmt) throw new functions.https.HttpsError('invalid-argument','Minimum: '+minAmt);
      if(amount>cp.stack+cp.bet) throw new functions.https.HttpsError('invalid-argument','Pas assez');
      const toAdd=amount-cp.bet;
      room.minRaise=amount-room.currentBet; room.currentBet=amount;
      placeBet(room,cp,toAdd); advanceTurn(room);
      result={action:'raise',player:cp.name,amount}; break;
    default: throw new functions.https.HttpsError('invalid-argument','Action inconnue');
  }
  
  if(room.phase!=='showdown'&&room.phase!=='waiting') room.turnDeadline=Date.now()+(room.settings.turnTimer*1000);
  else room.turnDeadline=null;
  room.lastAction=Date.now();
  await saveRoom(code,room);
  await notify(code,'playerAction',{player:result.player,action:result.action,amount:result.amount||0});
  return {player:result.player,action:result.action,amount:result.amount||0,roomData:sanitize(room,pid)};
});

exports.nextHand = functions.https.onCall(async(data,ctx)=>{
  const code=(data.code||'').trim().toUpperCase();
  const room=await getRoom(code);
  if(!room) throw new functions.https.HttpsError('not-found','Room introuvable');
  if(room.phase!=='showdown') throw new functions.https.HttpsError('failed-precondition','Main pas terminée');
  
  room.players=room.players.filter(p=>p.stack>0&&p.isConnected);
  if(room.players.length<2){room.phase='waiting';room.dealerIndex=room.players.length===1?0:-1;room.currentPlayerIndex=-1;room.turnDeadline=null;await saveRoom(code,room);return{roomData:sanitize(room,null),msg:'Pas assez de joueurs'};}
  
  if(room.dealerIndex<0||room.dealerIndex>=room.players.length) room.dealerIndex=0;
  const deck=shuffle(createDeck());
  room.communityCards=[]; room.pot=0; room.currentBet=0; room.minRaise=room.settings.bigBlind; room.handComplete=false; room.turnDeadline=null;
  for(const p of room.players){p.cards=[];p.bet=0;p.totalBet=0;p.folded=false;p.allIn=false;}
  
  let att=0; do{room.dealerIndex=(room.dealerIndex+1)%room.players.length;att++;}
  while(!room.players[room.dealerIndex].isConnected&&att<room.players.length);
  room.players.forEach((p,i)=>{p.isDealer=(i===room.dealerIndex);});
  for(const p of room.players) p.cards=deal(deck,2);
  room.deck=deck;
  
  const sb=findNext(room,room.dealerIndex);
  const bb=findNext(room,sb);
  if(sb!==-1&&bb!==-1){placeBet(room,room.players[sb],room.settings.smallBlind);placeBet(room,room.players[bb],room.settings.bigBlind);}
  room.currentBet=room.settings.bigBlind;
  room.phase='preflop';
  room.currentPlayerIndex=findNext(room,bb);
  room.lastAction=Date.now();
  room.turnDeadline=Date.now()+(room.settings.turnTimer*1000);
  
  await saveRoom(code,room);
  return {roomData:sanitize(room,null)};
});

exports.leaveRoom = functions.https.onCall(async(data,ctx)=>{
  const code=(data.code||'').trim().toUpperCase();
  const pid=ctx.auth?.uid||data.playerId;
  if(!pid) return{ok:true};
  const room=await getRoom(code);
  if(!room) return{ok:true};
  const idx=room.players.findIndex(p=>p.id===pid);
  if(idx===-1) return{ok:true};
  
  if(room.phase==='waiting'){
    room.players.splice(idx,1);
    if(room.players.length===0){await rtdb.ref(`rooms/${code}`).remove();return{ok:true};}
    if(room.dealerIndex>=room.players.length) room.dealerIndex=0;
    if(idx<room.dealerIndex) room.dealerIndex--;
    room.players.forEach((p,i)=>{p.isDealer=(i===room.dealerIndex);});
  } else {
    room.players[idx].folded=true; room.players[idx].isConnected=false;
    if(room.currentPlayerIndex===idx){
      advanceTurn(room);
      if(room.phase!=='showdown'&&room.phase!=='waiting') room.turnDeadline=Date.now()+(room.settings.turnTimer*1000);
      else room.turnDeadline=null;
    }
  }
  await saveRoom(code,room);
  await notify(code,'playerLeft',{playerId:pid});
  return{ok:true};
});

exports.checkTimer = functions.https.onCall(async(data)=>{
  const code=(data.code||'').trim().toUpperCase();
  const r=await expireTimer(code);
  return {expired:!!r,player:r?.player||null};
});

exports.scheduledTimer = functions.pubsub.schedule('every 1 minutes').onRun(async()=>{
  const snap=await rtdb.ref('rooms').once('value');
  const rooms=snap.val(); if(!rooms) return;
  for(const[code,room] of Object.entries(rooms)){
    if(!room.turnDeadline||room.phase==='waiting'||room.phase==='showdown') continue;
    if(Date.now()>=room.turnDeadline) await expireTimer(code);
  }
});
