/**
 * hand.js — Évaluation et comparaison des mains de poker Texas Hold'em
 *
 * Classement (du plus fort au plus faible) :
 *   9 - Quinte flush royale
 *   8 - Quinte flush
 *   7 - Carré
 *   6 - Full
 *   5 - Couleur (flush)
 *   4 - Suite (quinte)
 *   3 - Brelan
 *   2 - Double paire
 *   1 - Paire
 *   0 - Carte haute
 */

const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

const HAND_NAMES = [
  'Carte haute',
  'Paire',
  'Double paire',
  'Brelan',
  'Suite',
  'Couleur',
  'Full',
  'Carré',
  'Quinte flush',
  'Quinte flush royale',
];

/**
 * Retourne la valeur numérique d'une carte
 */
function cardValue(card) {
  return RANK_VALUES[card.rank] || 0;
}

/**
 * Compte les occurrences de chaque valeur
 * @returns {Map<value, count>}
 */
function countByValue(cards) {
  const counts = new Map();
  for (const c of cards) {
    const v = cardValue(c);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

/**
 * Compte les occurrences de chaque couleur
 * @returns {Map<suit, count>}
 */
function countBySuit(cards) {
  const counts = new Map();
  for (const c of cards) {
    counts.set(c.suit, (counts.get(c.suit) || 0) + 1);
  }
  return counts;
}

/**
 * Vérifie si les cartes forment une suite
 * Gère le cas spécial A-2-3-4-5 (roue)
 */
function isStraight(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length < 5) return { is: false };

  // Cas spécial : A-2-3-4-5 (wheel)
  if (sorted.includes(14) && sorted.includes(2) && sorted.includes(3) && sorted.includes(4) && sorted.includes(5)) {
    return { is: true, high: 5 }; // la haute est 5, pas A
  }

  // Vérifie 5 consécutifs
  for (let i = sorted.length - 1; i >= 4; i--) {
    if (sorted[i] - sorted[i - 4] === 4) {
      // Vérifie qu'il n'y a pas de trou
      let consecutive = true;
      for (let j = i - 4; j < i; j++) {
        if (sorted[j + 1] - sorted[j] !== 1) {
          consecutive = false;
          break;
        }
      }
      if (consecutive) return { is: true, high: sorted[i] };
    }
  }
  return { is: false };
}

/**
 * Vérifie si les cartes forment une couleur
 */
function isFlush(cards) {
  const suitCounts = countBySuit(cards);
  for (const [suit, count] of suitCounts) {
    if (count >= 5) {
      const suitedCards = cards.filter(c => c.suit === suit);
      return { is: true, suit, cards: suitedCards };
    }
  }
  return { is: false };
}

/**
 * Évalue la meilleure main de 5 cartes parmi 7 (2 main + 5 communes)
 * @param {Array} holeCards - 2 cartes du joueur
 * @param {Array} communityCards - 3 à 5 cartes communes
 * @returns {{ rank: number, name: string, values: number[] }}
 */
function evaluateHand(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  const values = allCards.map(cardValue);
  const counts = countByValue(allCards);

  // Grouper par count : { count: [values...] }
  const byCount = new Map();
  for (const [val, cnt] of counts) {
    if (!byCount.has(cnt)) byCount.set(cnt, []);
    byCount.get(cnt).push(val);
  }
  // Trier chaque groupe par valeur décroissante
  for (const [cnt, vals] of byCount) {
    vals.sort((a, b) => b - a);
  }

  const flushResult = isFlush(allCards);
  const straightResult = isStraight(values);

  // 9 - Quinte flush royale
  if (flushResult.is && straightResult.is) {
    // Vérifie que la suite est dans les cartes de la couleur
    const suitedValues = flushResult.cards.map(cardValue);
    const suitedStraight = isStraight(suitedValues);
    if (suitedStraight.is && suitedStraight.high === 14) {
      return { rank: 9, name: 'Quinte flush royale', values: [14] };
    }
    if (suitedStraight.is) {
      return { rank: 8, name: 'Quinte flush', values: [suitedStraight.high] };
    }
  }

  // 7 - Carré
  if (byCount.has(4)) {
    const quadVal = byCount.get(4)[0];
    const kicker = values.filter(v => v !== quadVal).sort((a, b) => b - a)[0];
    return { rank: 7, name: 'Carré', values: [quadVal, kicker] };
  }

  // 6 - Full
  if (byCount.has(3) && byCount.has(2)) {
    return { rank: 6, name: 'Full', values: [byCount.get(3)[0], byCount.get(2)[0]] };
  }
  // Cas : 2 brelans → le plus haut est le brelan, l'autre est la paire
  if (byCount.has(3) && byCount.get(3).length >= 2) {
    const trips = byCount.get(3).sort((a, b) => b - a);
    return { rank: 6, name: 'Full', values: [trips[0], trips[1]] };
  }

  // 5 - Couleur
  if (flushResult.is) {
    const suitedValues = flushResult.cards.map(cardValue).sort((a, b) => b - a).slice(0, 5);
    return { rank: 5, name: 'Couleur', values: suitedValues };
  }

  // 4 - Suite
  if (straightResult.is) {
    return { rank: 4, name: 'Suite', values: [straightResult.high] };
  }

  // 3 - Brelan
  if (byCount.has(3)) {
    const tripVal = byCount.get(3)[0];
    const kickers = values.filter(v => v !== tripVal).sort((a, b) => b - a).slice(0, 2);
    return { rank: 3, name: 'Brelan', values: [tripVal, ...kickers] };
  }

  // 2 - Double paire
  if (byCount.has(2) && byCount.get(2).length >= 2) {
    const pairs = byCount.get(2).sort((a, b) => b - a).slice(0, 2);
    const kicker = values.filter(v => !pairs.includes(v)).sort((a, b) => b - a)[0];
    return { rank: 2, name: 'Double paire', values: [...pairs, kicker] };
  }

  // 1 - Paire
  if (byCount.has(2)) {
    const pairVal = byCount.get(2)[0];
    const kickers = values.filter(v => v !== pairVal).sort((a, b) => b - a).slice(0, 3);
    return { rank: 1, name: 'Paire', values: [pairVal, ...kickers] };
  }

  // 0 - Carte haute
  const sorted = [...values].sort((a, b) => b - a).slice(0, 5);
  return { rank: 0, name: 'Carte haute', values: sorted };
}

/**
 * Compare deux mains évaluées
 * @returns {number} > 0 si a gagne, < 0 si b gagne, 0 si égalité
 */
function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.values.length, b.values.length); i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0; // égalité
}

/**
 * Trouve le(s) gagnant(s) parmi les joueurs actifs
 * @param {Array} players - joueurs avec { cards: [...] }
 * @param {Array} communityCards
 * @returns {Array} indices des gagnants
 */
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

  // Trier par force décroissante
  evaluated.sort((a, b) => compareHands(b.hand, a.hand));

  // Trouver tous les ex-aequo
  const best = evaluated[0];
  const winners = evaluated.filter(e => compareHands(e.hand, best.hand) === 0);

  return winners.map(w => w.index);
}

module.exports = {
  evaluateHand,
  compareHands,
  findWinners,
  HAND_NAMES,
  RANK_VALUES,
};
