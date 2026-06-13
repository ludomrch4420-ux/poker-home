/**
 * deck.js — Gestion du deck de 52 cartes poker
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];

/**
 * Crée un deck neuf de 52 cartes
 * @returns {Array<{rank: string, suit: string}>}
 */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Mélange un deck (algorithme Fisher-Yates)
 * @param {Array} deck
 * @returns {Array} le même deck, mélangé
 */
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Pioche n cartes du dessus du deck
 * @param {Array} deck
 * @param {number} n
 * @returns {Array} les n cartes piochées
 */
function deal(deck, n) {
  return deck.splice(0, n);
}

/**
 * Crée un deck mélangé prêt à l'emploi
 * @returns {Array}
 */
function createShuffledDeck() {
  return shuffle(createDeck());
}

module.exports = { createDeck, shuffle, deal, createShuffledDeck, RANKS, SUITS };
