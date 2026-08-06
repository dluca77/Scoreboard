// Super card engine — pure functions, no I/O. Shared logic for client hints and
// (eventually) server-side authoritative validation in the Supabase Edge Function.
//
// Card representation: {suit: 'C'|'D'|'H'|'S'|'J', rank: 2-10|'J'|'Q'|'K'|'A', id: string}
// 'J' suit is only used for the 2 printed joker cards (rank is irrelevant for them).
// `id` uniquely identifies a physical card instance (e.g. 'H8-0', 'H8-1', 'JOKER-0').

const SUITS = ['C', 'D', 'H', 'S'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'J', 'Q', 'K', 'A'];
const SUIT_MULTIPLIER = { C: 2, S: 3, D: 4, H: 5 };

function buildDeck() {
  const cards = [];
  for (let deckNo = 0; deckNo < 2; deckNo++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ suit, rank, id: `${suit}${rank}-${deckNo}` });
      }
    }
  }
  cards.push({ suit: 'J', rank: 'JOKER', id: 'JOKER-0' });
  cards.push({ suit: 'J', rank: 'JOKER', id: 'JOKER-1' });
  return cards;
}

function shuffle(deck, rng = Math.random) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Next rank in sequence for joker determination purposes only (wraps K->A, A->2).
function nextRankForJoker(rank) {
  const idx = RANKS.indexOf(rank);
  return RANKS[(idx + 1) % RANKS.length];
}

// Given the open (face-up) card, determine this round's designated joker rank/suit.
// Returns {suit, rank} — the specific card that acts as wildcard.
function determineJoker(openCard) {
  return { suit: openCard.suit, rank: nextRankForJoker(openCard.rank) };
}

// Is this physical card one of the round's 4 joker cards (2 natural + 2 printed)?
function isJokerCard(card, jokerSpec) {
  if (card.suit === 'J') return true;
  return card.suit === jokerSpec.suit && card.rank === jokerSpec.rank;
}

function cardValue(card) {
  if (typeof card.rank === 'number') return card.rank;
  if (card.rank === 'A') return 1;
  return 10; // J, Q, K
}

// RANKS index used for straight/run adjacency. Ace can sit low (before 2) or
// high (after K), but a single run instance may not span both ends (no wrap).
const RUN_ORDER_LOW = ['A', 2, 3, 4, 5, 6, 7, 8, 9, 10, 'J', 'Q', 'K'];
const RUN_ORDER_HIGH = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'J', 'Q', 'K', 'A'];

function isValidRun(cards, jokerSpec) {
  if (cards.length < 3) return false;
  const real = cards.filter(c => !isJokerCard(c, jokerSpec));
  const jokerCount = cards.length - real.length;
  if (real.length === 0) return true; // all jokers, trivially a run of jokers
  const suit = real[0].suit;
  if (!real.every(c => c.suit === suit)) return false;
  const rankSet = real.map(c => c.rank);
  if (new Set(rankSet).size !== rankSet.length) return false; // no duplicate ranks

  return tryOrder(RUN_ORDER_LOW) || tryOrder(RUN_ORDER_HIGH);

  function tryOrder(order) {
    const positions = real.map(c => order.indexOf(c.rank)).sort((a, b) => a - b);
    if (positions.some(p => p === -1)) return false;
    const lo = positions[0], hi = positions[positions.length - 1];
    const span = hi - lo + 1;
    if (span > cards.length) return false; // gaps too big even with jokers
    const need = span - real.length; // jokers needed to fill gaps in this span
    if (need > jokerCount) return false;
    // remaining jokers (beyond what's needed to fill internal gaps) must extend the run
    const extra = jokerCount - need;
    return span + extra === cards.length || extra === 0;
  }
}

function isValidSet(cards, jokerSpec) {
  if (cards.length < 3 || cards.length > 4) return false;
  const real = cards.filter(c => !isJokerCard(c, jokerSpec));
  const jokerCount = cards.length - real.length;
  if (real.length === 0) return true;
  const rank = real[0].rank;
  if (!real.every(c => c.rank === rank)) return false;
  const suits = real.map(c => c.suit);
  if (new Set(suits).size !== suits.length) return false; // unique suits only
  return jokerCount <= 4 - real.length;
}

function isValidMeld(cards, jokerSpec) {
  return isValidRun(cards, jokerSpec) || isValidSet(cards, jokerSpec);
}

// Given a full hand (array of cards) and a proposed grouping (array of arrays of
// card ids), validate that every group is a legal meld and every card is used
// at most once. Returns {valid, looseCards} where looseCards are cards not in
// any (valid) group.
function validateGrouping(hand, groups, jokerSpec) {
  const byId = new Map(hand.map(c => [c.id, c]));
  const used = new Set();
  for (const group of groups) {
    const cards = group.map(id => byId.get(id)).filter(Boolean);
    if (cards.length !== group.length) return { valid: false, looseCards: hand };
    if (!isValidMeld(cards, jokerSpec)) return { valid: false, looseCards: hand };
    for (const id of group) {
      if (used.has(id)) return { valid: false, looseCards: hand };
      used.add(id);
    }
  }
  const looseCards = hand.filter(c => !used.has(c.id));
  return { valid: true, looseCards };
}

// Can this hand (exactly 14 cards) be fully arranged into valid melds with zero
// loose cards? Attempts exhaustive search over meld combinations (hand sizes are
// small enough — 14 cards — for backtracking to be fast).
function canFormCompleteHand(hand, jokerSpec) {
  return findCompleteGrouping(hand, jokerSpec) !== null;
}

function findCompleteGrouping(hand, jokerSpec) {
  if (hand.length === 0) return [];
  if (hand.length < 3) return null;

  const first = hand[0];
  const rest = hand.slice(1);

  // Try every possible meld that includes `first`, sized 3 or 4, drawn from rest.
  const candidates = combinations(rest, 2).concat(combinations(rest, 3));
  for (const combo of candidates) {
    const group = [first, ...combo];
    if (!isValidMeld(group, jokerSpec)) continue;
    const usedIds = new Set(group.map(c => c.id));
    const remaining = hand.filter(c => !usedIds.has(c.id));
    const sub = findCompleteGrouping(remaining, jokerSpec);
    if (sub !== null) return [group.map(c => c.id), ...sub];
  }
  return null;
}

function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) { results.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

// Score a round. `results` is an array of {playerId, looseCards, opened, openedWithJoker, wasTurning}.
// `openCard` is the round's face-up card (its suit sets the base multiplier).
// Returns {playerId: penaltyPoints}.
function scoreRound(results, openCard, { stockExhausted = false } = {}) {
  const baseMult = SUIT_MULTIPLIER[openCard.suit];
  const opener = results.find(r => r.opened);
  const jokerOpen = !!(opener && opener.openedWithJoker);
  const effMult = stockExhausted ? baseMult : baseMult * (jokerOpen ? 2 : 1);

  const scores = {};
  for (const r of results) {
    let pts = 0;
    if (!stockExhausted && r.opened) {
      pts += r.openedWithJoker ? -500 : -100;
    } else {
      const loose = r.looseCards.reduce((s, c) => s + cardValue(c), 0);
      pts += loose * effMult;
    }
    if (!stockExhausted && r.wasTurning && !r.opened) pts += 500;
    scores[r.playerId] = pts;
  }
  return scores;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUITS, RANKS, SUIT_MULTIPLIER,
    buildDeck, shuffle, determineJoker, isJokerCard, cardValue,
    isValidRun, isValidSet, isValidMeld, validateGrouping,
    canFormCompleteHand, findCompleteGrouping, scoreRound,
  };
}
