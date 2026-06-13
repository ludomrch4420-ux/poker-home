/**
 * gameroom.js — Logique d'une room / partie de Texas Hold'em
 */

const { createShuffledDeck, deal } = require('./deck');
const { evaluateHand, findWinners } = require('./hand');

const DEFAULTS = {
  smallBlind: 5,
  bigBlind: 10,
  startingStack: 1000,
  turnTimer: 20000,
  maxPlayers: 6,
};

/**
 * Représente un joueur dans la room
 */
function createPlayer(id, name, stack) {
  return {
    id,
    name,
    stack: stack || DEFAULTS.startingStack,
    cards: [],
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    isDealer: false,
    isConnected: true,
  };
}

class GameRoom {
  /**
   * @param {string} code - Code de la room
   * @param {object} settings - Paramètres de la partie
   */
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
  }

  /**
   * Retourne les données publiques d'un joueur (sans cartes des autres)
   */
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
        id: p.id,
        name: p.name,
        stack: p.stack,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        isDealer: p.isDealer,
        isMe: p.id === forPlayerId,
        // Les cartes ne sont visibles que pour le propriétaire et au showdown
        cards: (p.id === forPlayerId || this.phase === 'showdown')
          ? p.cards
          : (p.cards.length > 0 ? [{ rank: '?', suit: '?' }, { rank: '?', suit: '?' }] : []),
      })),
    };
  }

  /**
   * Ajoute un joueur à la room
   */
  addPlayer(id, name) {
    if (this.players.length >= this.settings.maxPlayers) return { error: `Room pleine (max ${this.settings.maxPlayers} joueurs)` };
    if (this.phase !== 'waiting') return { error: 'Partie déjà en cours' };
    if (this.players.find(p => p.id === id)) return { error: 'Déjà dans la room' };

    const player = createPlayer(id, name, this.settings.startingStack);
    this.players.push(player);

    // Le premier joueur devient dealer
    if (this.players.length === 1) {
      player.isDealer = true;
      this.dealerIndex = 0;
    }

    return { player, roomData: this.getData() };
  }

  /**
   * Retire un joueur de la room
   */
  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return null;

    const player = this.players[idx];
    this.players.splice(idx, 1);

    // Si la partie n'a pas commencé, recalculer le dealer
    if (this.phase === 'waiting') {
      if (this.players.length === 0) {
        this.dealerIndex = -1;
      } else if (idx === this.dealerIndex) {
        this.dealerIndex = 0;
        this.players[0].isDealer = true;
      } else if (this.dealerIndex >= this.players.length) {
        this.dealerIndex = 0;
        this.players[0].isDealer = true;
      }
    } else {
      // Partie en cours → le joueur est couché automatiquement
      player.folded = true;
      player.isConnected = false;
      // Vérifier si le joueur couché est celui qui devait jouer
      if (this.currentPlayerIndex === idx) {
        this.nextPlayer();
      } else if (this.currentPlayerIndex > idx) {
        this.currentPlayerIndex--;
      }
    }

    return this.getData();
  }

  /**
   * Démarre la partie
   */
  startGame() {
    if (this.players.length < 2) return { error: 'Il faut au moins 2 joueurs' };
    if (this.phase !== 'waiting') return { error: 'Partie déjà en cours' };

    this.dealCards();
    return { roomData: this.getData() };
  }

  /**
   * Distribue les cartes et lance le preflop
   */
  dealCards() {
    // Reset
    this.deck = createShuffledDeck();
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;

    for (const p of this.players) {
      p.cards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
    }

    // Avancer le dealer
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    this.players.forEach((p, i) => { p.isDealer = (i === this.dealerIndex); });

    // Distribuer 2 cartes à chaque joueur
    for (const p of this.players) {
      p.cards = deal(this.deck, 2);
    }

    // Positions
    const sbIndex = (this.dealerIndex + 1) % this.players.length;
    const bbIndex = (this.dealerIndex + 2) % this.players.length;

    // Petite blind
    this._placeBet(this.players[sbIndex], this.settings.smallBlind);
    // Grosse blind
    this._placeBet(this.players[bbIndex], this.settings.bigBlind);

    this.currentBet = this.settings.bigBlind;
    this.phase = 'preflop';

    // Le premier à agir est celui après la grosse blind
    this.currentPlayerIndex = (bbIndex + 1) % this.players.length;
    this._skipPlayersWhoCantAct();

    this._startTimer();
  }

  /**
   * Place une mise (blind ou mise normale)
   */
  _placeBet(player, amount) {
    const actualBet = Math.min(amount, player.stack);
    player.stack -= actualBet;
    player.bet += actualBet;
    player.totalBet += actualBet;
    this.pot += actualBet;
    if (player.stack === 0) player.allIn = true;
  }

  /**
   * Trouve le prochain joueur qui peut agir
   */
  _nextActivePlayer() {
    let idx = this.currentPlayerIndex;
    let looped = false;
    while (true) {
      idx = (idx + 1) % this.players.length;
      if (idx === this.currentPlayerIndex) {
        if (looped) return -1; // personne ne peut agir
        looped = true;
      }
      const p = this.players[idx];
      if (!p.folded && !p.allIn) return idx;
    }
  }

  /**
   * Passe au prochain joueur qui peut agir
   */
  _skipPlayersWhoCantAct() {
    const p = this.players[this.currentPlayerIndex];
    if (p.folded || p.allIn) {
      this.currentPlayerIndex = this._nextActivePlayer();
    }
  }

  /**
   * Passe au joueur suivant et vérifie si la phase est terminée
   */
  nextPlayer() {
    this._clearTimer();
    const next = this._nextActivePlayer();

    // Vérifier si tous les joueurs non couchés ont agi et sont égalisés
    const activePlayers = this.players.filter(p => !p.folded);
    const nonAllIn = activePlayers.filter(p => !p.allIn);

    const allMatched = nonAllIn.every(p => p.bet === this.currentBet);
    const allActed = activePlayers.filter(p => !p.allIn).length <= 1; // 0 ou 1 joueur non all-in

    if (next === -1 || next === this.currentPlayerIndex || (allMatched && allActed)) {
      // Phase terminée
      this._endPhase();
      return;
    }

    this.currentPlayerIndex = next;
    this._startTimer();
  }

  /**
   * Termine la phase actuelle et passe à la suivante
   */
  _endPhase() {
    // Réinitialiser les mises de phase
    for (const p of this.players) {
      p.bet = 0;
      p.totalBet = 0;
    }
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;

    // Vérifier combien de joueurs sont encore en jeu
    const activePlayers = this.players.filter(p => !p.folded);
    if (activePlayers.length <= 1) {
      // Un seul joueur → il gagne le pot
      this._declareWinner(activePlayers);
      return;
    }

    // Passer à la phase suivante
    const phases = ['preflop', 'flop', 'turn', 'river'];
    const currentIdx = phases.indexOf(this.phase);

    if (currentIdx === -1) {
      this._showdown();
      return;
    }

    const nextPhase = phases[currentIdx + 1];

    if (nextPhase === 'flop') {
      this.communityCards = deal(this.deck, 3); // flop : 3 cartes
    } else {
      this.communityCards.push(...deal(this.deck, 1)); // turn/river : 1 carte
    }

    this.phase = nextPhase;

    // Le premier à agir est le premier joueur non couché après le dealer
    this.currentPlayerIndex = this._firstAfterDealer();
    this._skipPlayersWhoCantAct();
    this._startTimer();
  }

  /**
   * Trouve le premier joueur non couché après le dealer
   */
  _firstAfterDealer() {
    if (this.players.length === 0) return -1;
    let idx = (this.dealerIndex + 1) % this.players.length;
    let looped = false;
    while (true) {
      if (!this.players[idx].folded && !this.players[idx].allIn) return idx;
      idx = (idx + 1) % this.players.length;
      if (idx === this.dealerIndex + 1) {
        if (looped) return this.dealerIndex; // fallback
        looped = true;
      }
    }
  }

  /**
   * Showdown : détermine le(s) gagnant(s)
   */
  _showdown() {
    this.phase = 'showdown';
    this._clearTimer();

    const winners = findWinners(this.players, this.communityCards);

    if (winners.length === 1) {
      const w = this.players[winners[0]];
      w.stack += this.pot;
    } else if (winners.length > 1) {
      // Split pot
      const share = Math.floor(this.pot / winners.length);
      for (const idx of winners) {
        this.players[idx].stack += share;
      }
    }

    this.pot = 0;
  }

  /**
   * Déclare un vainqueur (tous les autres couchés)
   */
  _declareWinner(remaining) {
    this.phase = 'showdown';
    this._clearTimer();
    if (remaining.length === 1) {
      remaining[0].stack += this.pot;
    }
    this.pot = 0;
  }

  /**
   * Relance le jeu pour un nouveau tour
   */
  nextHand() {
    if (this.phase !== 'showdown') return { error: 'La partie n\'est pas terminée' };

    // Retirer les joueurs sans jetons
    this.players = this.players.filter(p => p.stack > 0);

    if (this.players.length < 2) {
      this.phase = 'waiting';
      return { roomData: this.getData(), message: 'Pas assez de joueurs pour continuer' };
    }

    this.dealCards();
    return { roomData: this.getData() };
  }

  // ─── Actions du joueur ───────────────────────────────────

  /**
   * Action : fold
   */
  fold(playerId) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };
    p.folded = true;
    this.nextPlayer();
    return { action: 'fold', player: p.name, roomData: this.getData() };
  }

  /**
   * Action : check
   */
  check(playerId) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };
    if (p.bet < this.currentBet) return { error: 'Tu ne peux pas checker, il faut suivre ou relancer' };
    this.nextPlayer();
    return { action: 'check', player: p.name, roomData: this.getData() };
  }

  /**
   * Action : call
   */
  call(playerId) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    this._placeBet(p, toCall);
    this.nextPlayer();
    return { action: 'call', player: p.name, amount: toCall, roomData: this.getData() };
  }

  /**
   * Action : raise
   */
  raise(playerId, amount) {
    const p = this._validateTurn(playerId);
    if (!p) return { error: 'Ce n\'est pas ton tour' };

    const minAmount = this.currentBet + this.minRaise;
    if (amount < minAmount) return { error: `La relance minimum est de ${minAmount}` };
    if (amount > p.stack + p.bet) return { error: 'Pas assez de jetons' };

    const toAdd = amount - p.bet;
    this.minRaise = amount - this.currentBet;
    this.currentBet = amount;
    this._placeBet(p, toAdd);
    this.nextPlayer();
    return { action: 'raise', player: p.name, amount, roomData: this.getData() };
  }

  // ─── Utilitaires ─────────────────────────────────────────

  /**
   * Valide que c'est bien le tour du joueur
   */
  _validateTurn(playerId) {
    if (this.currentPlayerIndex < 0 || this.currentPlayerIndex >= this.players.length) return null;
    const p = this.players[this.currentPlayerIndex];
    if (p.id !== playerId) return null;
    if (p.folded || p.allIn) return null;
    return p;
  }

  /**
   * Retourne la force de la main du showdown
   */
  getHandStrength(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p || p.cards.length !== 2) return null;
    if (this.communityCards.length < 3) return evaluateHand(p.cards, []);
    return evaluateHand(p.cards, this.communityCards);
  }

  _startTimer() {
    this._clearTimer();
    this.actionTimer = setTimeout(() => {
      const p = this.players[this.currentPlayerIndex];
      if (p && p.id) {
        this.fold(p.id);
        // Les clients doivent être notifiés → c'est géré par clients.js
      }
    }, this.settings.turnTimer);
  }

  _clearTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }
}

module.exports = { GameRoom };
