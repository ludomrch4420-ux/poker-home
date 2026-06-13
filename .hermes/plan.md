# Plan — PokerHome : Texas Hold'em en ligne

## État actuel

**Fait :**
- `index.html` — UI complète (lobby, table, cartes, sièges, actions, démo locale)
- `style.css` — Dark theme soigné, table ovale, responsive
- `wrangler.jsonc` — Config Cloudflare pour hébergement statique
- `package.json` — Nom "poker-home"

**À coder (fichiers vides) :**
- `server.js` — Serveur Node.js + Socket.IO
- `clients.js` — Gestion des connexions côté serveur
- `game/deck.js` — Deck de 52 cartes
- `game/gameroom.js` — Logique de room et de partie
- `game/hand.js` — Évaluation des mains de poker

---

## Phase 1 : Setup projet et serveur de base

### 1.1 Initialiser le projet npm
- `npm init` (déjà fait partiellement)
- Installer les dépendances : `express`, `socket.io`
- Ajouter un script `start` dans package.json

### 1.2 `server.js` — Serveur Express + Socket.IO
- Serveur HTTP servant les fichiers statiques (index.html, style.css, game/)
- Intégration Socket.IO
- Route de base `/` → `index.html`
- Gestion des rooms (créer, rejoindre, quitter)
- Redirection des événements vers `clients.js`

### 1.3 `clients.js` — Gestion des connexions
- Map des rooms actives (code → instance de GameRoom)
- Événements Socket.IO :
  - `createRoom` → crée une room, génère code aléatoire
  - `joinRoom` → rejoint une room existante
  - `leaveRoom` → quitte la room
  - `playerAction` → reçoit fold/check/call/raise
  - `startGame` → démarre la partie (si assez de joueurs)
- Diffusion aux joueurs de la room : `roomJoined`, `gameState`, `yourTurn`, `actionLog`

---

## Phase 2 : Logique de jeu

### 2.1 `game/deck.js` — Deck de 52 cartes
- Structure : tableau d'objets `{ rank, suit }`
- Ranks : `2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, A`
- Suits : `♠, ♥, ♦, ♣`
- Fonctions :
  - `createDeck()` → retourne un deck neuf
  - `shuffle(deck)` → mélange (Fisher-Yates)
  - `deal(deck, n)` → pioche n cartes du dessus

### 2.2 `game/hand.js` — Évaluation des mains
- Prend 7 cartes (2 main + 5 communes) et retourne la meilleure main de 5
- Classifications (du plus fort au plus faible) :
  1. Quinte flush royale
  2. Quinte flush
  3. Carré
  4. Full
  5. Flush (couleur)
  6. Quinte (suite)
  7. Brelan
  8. Double paire
  9. Paire
  10. Carte haute
- Retourne : `{ rank, name, cards, kickers }` pour comparaison
- Fonction `compareHands(a, b)` → retourne le gagnant

### 2.3 `game/gameroom.js` — Gestion d'une room/partie
- **Joueurs** : nom, stack (1000 jetons au départ), cartes, mise actuelle, état (actif/couché/all-in)
- **Phases** : `waiting → preflop → flop → turn → river → showdown`
- **Blinds** : petite blind 5, grosse blind 10
- **Pot** : pot principal + side pots (simplifié : pot unique pour l'instant)
- **Tour de parole** : rotation horaire depuis le dealer
- **Actions** :
  - `fold` → joueur éliminé du tour
  - `check` → si personne n'a misé
  - `call` → suit la mise actuelle
  - `raise` → relance (min = 2x la grosse blind)
- **Transitions de phase** :
  - Tous les joueurs ont agi → phase suivante
  - Distribution des cartes à chaque phase
- **Showdown** : évaluation des mains, distribution du pot, nouveau tour

---

## Phase 3 : Intégration client ↔ serveur

### 3.1 Décommenter le bloc Socket.IO dans `index.html`
- Activer le `<script src="/socket.io/socket.io.js"></script>`
- Décommenter le bloc `const socket = io()` et les `socket.on(...)`
- Adapter les réponses aux événements serveur

### 3.2 Synchronisation de l'état
- Le serveur est **source de vérité**
- Le client affiche ce que le serveur envoie
- Supprimer `demoPopulate()` une fois le serveur fonctionnel

### 3.3 Améliorations UI
- Affichage de la force de la main en temps réel (côté client avec `hand.js` côté client aussi)
- Animation des cartes distribuées
- Son/notification quand c'est ton tour

---

## Phase 4 : Polish et déploiement

### 4.1 Gestion des cas limites
- Joueur déconnecté → fold automatique après timer
- All-in géré correctement
- Minimum 2 joueurs pour démarrer
- Maximum 6 joueurs par room

### 4.2 Sécurité basique
- Validation de toutes les actions côté serveur
- Pas de triche : les cartes des autres joueurs ne sont pas envoyées au client

### 4.3 Déploiement Cloudflare
- Adapter `wrangler.jsonc` pour inclure le serveur (Workers ou Pages Functions)
- OU séparer : frontend Cloudflare + backend Node.js séparé (Railway, Fly.io, etc.)

---

## Ordre de recommandation

```
Phase 1 (serveur + connexions)
  ↓
Phase 2.1 (deck.js) + 2.2 (hand.js) — testables en isolation
  ↓
Phase 2.3 (gameroom.js) — assemble deck + hand
  ↓
Phase 3 (intégration Socket.IO)
  ↓
Phase 4 (polish)
```

---

## Fichiers à créer/modifier

| Fichier | Action |
|---|---|
| `package.json` | Ajouter dépendances express, socket.io |
| `server.js` | Créer de zéro |
| `clients.js` | Créer de zéro |
| `game/deck.js` | Créer de zéro |
| `game/hand.js` | Créer de zéro |
| `game/gameroom.js` | Créer de zéro |
| `index.html` | Décommenter Socket.IO, supprimer démo |
| `style.css` | Ajustements mineurs si nécessaire |
