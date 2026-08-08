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
// Used for general "is this card special" purposes (loose-card display,
// candidate generation) — meld validation itself distinguishes the two
// kinds below, since they behave very differently.
function isJokerCard(card, jokerSpec) {
  if (card.suit === 'J') return true;
  return card.suit === jokerSpec.suit && card.rank === jokerSpec.rank;
}

// The "free" joker: an actual physical card of this round's designated
// rank+suit (e.g. the real ♥9 when ♥8 is the open card). Fully flexible —
// may stand in for any missing card in a meld.
function isFreeJoker(card, jokerSpec) {
  return card.suit === jokerSpec.suit && card.rank === jokerSpec.rank;
}

// The 2 printed joker cards are NOT flexible wildcards — they specifically
// take the place of this round's designated joker card (the free joker)
// and nothing else. So before validating a meld, replace each printed
// joker with that literal card identity; whether it actually fits is then
// just ordinary same-suit/same-rank matching, no special-casing needed.
function substitutePrintedJokers(cards, jokerSpec) {
  return cards.map(c => c.suit === 'J' ? { suit: jokerSpec.suit, rank: jokerSpec.rank, id: c.id } : c);
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

function isValidRun(cardsIn, jokerSpec) {
  if (cardsIn.length < 3) return false;
  const freeJokers = cardsIn.filter(c => isFreeJoker(c, jokerSpec));
  const real = substitutePrintedJokers(cardsIn.filter(c => !isFreeJoker(c, jokerSpec)), jokerSpec);
  const jokerCount = freeJokers.length; // only free jokers are flexible
  if (real.length === 0) return true; // all free jokers, trivially a run
  const suit = real[0].suit;
  if (!real.every(c => c.suit === suit)) return false;
  const rankSet = real.map(c => c.rank);
  if (new Set(rankSet).size !== rankSet.length) return false; // catches e.g. 2 printed jokers colliding

  return tryOrder(RUN_ORDER_LOW) || tryOrder(RUN_ORDER_HIGH);

  function tryOrder(order) {
    const positions = real.map(c => order.indexOf(c.rank)).sort((a, b) => a - b);
    if (positions.some(p => p === -1)) return false;
    const lo = positions[0], hi = positions[positions.length - 1];
    const span = hi - lo + 1;
    if (span > cardsIn.length) return false; // gaps too big even with free jokers
    const need = span - real.length; // free jokers needed to fill gaps in this span
    if (need > jokerCount) return false;
    // remaining free jokers (beyond what's needed to fill internal gaps) must extend the run
    const extra = jokerCount - need;
    return span + extra === cardsIn.length || extra === 0;
  }
}

function isValidSet(cardsIn, jokerSpec) {
  if (cardsIn.length < 3 || cardsIn.length > 4) return false;
  const freeJokers = cardsIn.filter(c => isFreeJoker(c, jokerSpec));
  const real = substitutePrintedJokers(cardsIn.filter(c => !isFreeJoker(c, jokerSpec)), jokerSpec);
  const jokerCount = freeJokers.length;
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

  // Try every possible meld that includes `first`: sets/short runs sized 3
  // or 4 drawn from rest, plus longer runs (5+) anchored on first's suit.
  const candidates = combinations(rest, 2).concat(combinations(rest, 3), longRunCandidates(first, hand, jokerSpec));
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

// Runs have no upper length limit (unlike sets, capped at 4 by the suit
// count) — a 5+ card run like 5-6-7-8-9 of one suit is perfectly legal.
// Generating those via combinations(rest, k) for every k up to 12 would be
// combinatorially explosive, so instead this builds run candidates
// directly: anchor on `first`'s suit, scan every contiguous rank span
// (length 5+) that includes `first`, and check whether the gaps can be
// filled by however many joker cards are available. Sets and runs of
// length 3-4 are still covered separately via small combinations.
function longRunCandidates(first, pool, jokerSpec) {
  if (isJokerCard(first, jokerSpec)) return [];
  const suit = first.suit;
  const jokerCards = pool.filter(c => c.id !== first.id && isJokerCard(c, jokerSpec));
  const bySuit = pool.filter(c => c.suit === suit && !isJokerCard(c, jokerSpec));
  const rankToCard = new Map();
  for (const c of bySuit) if (!rankToCard.has(c.rank)) rankToCard.set(c.rank, c);

  const results = [];
  for (const order of [RUN_ORDER_LOW, RUN_ORDER_HIGH]) {
    const firstPos = order.indexOf(first.rank);
    if (firstPos === -1) continue;
    for (let start = 0; start <= firstPos; start++) {
      for (let end = firstPos; end < order.length; end++) {
        const len = end - start + 1;
        if (len < 5) continue;
        const used = [];
        let jokersNeeded = 0;
        for (let p = start; p <= end; p++) {
          const card = rankToCard.get(order[p]);
          if (card) used.push(card);
          else jokersNeeded++;
        }
        if (jokersNeeded > jokerCards.length) continue;
        used.push(...jokerCards.slice(0, jokersNeeded));
        results.push(used.filter(c => c.id !== first.id));
      }
    }
  }
  return results;
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

// For a hand that is NOT (necessarily) fully meldable, find the decomposition
// into melds that minimizes the point-value of the leftover loose cards.
// Used to score players who didn't complete their hand when a round ends.
function minLooseValue(hand, jokerSpec) {
  const memo = new Map();
  function search(cards) {
    if (cards.length === 0) return { loose: [], value: 0 };
    const key = cards.map(c => c.id).sort().join(',');
    if (memo.has(key)) return memo.get(key);
    const first = cards[0];
    const rest = cards.slice(1);
    let best = search(rest);
    best = { loose: [first, ...best.loose], value: cardValue(first) + best.value };
    const candidates = combinations(rest, 2).concat(combinations(rest, 3), longRunCandidates(first, cards, jokerSpec));
    for (const combo of candidates) {
      const group = [first, ...combo];
      if (!isValidMeld(group, jokerSpec)) continue;
      const usedIds = new Set(group.map(c => c.id));
      const remaining = cards.filter(c => !usedIds.has(c.id));
      const sub = search(remaining);
      if (sub.value < best.value) best = sub;
    }
    memo.set(key, best);
    return best;
  }
  return search(hand);
}

// Same search as minLooseValue, but also returns which melds it chose
// (as arrays of card ids) instead of just the leftover value — used to
// drive an "auto-group my hand" client action.
function bestPartialGrouping(hand, jokerSpec) {
  const memo = new Map();
  function search(cards) {
    if (cards.length === 0) return { loose: [], groups: [], value: 0 };
    const key = cards.map(c => c.id).sort().join(',');
    if (memo.has(key)) return memo.get(key);
    const first = cards[0];
    const rest = cards.slice(1);
    let best = search(rest);
    best = { loose: [first, ...best.loose], groups: best.groups, value: cardValue(first) + best.value };
    const candidates = combinations(rest, 2).concat(combinations(rest, 3), longRunCandidates(first, cards, jokerSpec));
    for (const combo of candidates) {
      const group = [first, ...combo];
      if (!isValidMeld(group, jokerSpec)) continue;
      const usedIds = new Set(group.map(c => c.id));
      const remaining = cards.filter(c => !usedIds.has(c.id));
      const sub = search(remaining);
      if (sub.value < best.value) {
        best = { loose: sub.loose, groups: [group.map(c => c.id), ...sub.groups], value: sub.value };
      }
    }
    memo.set(key, best);
    return best;
  }
  return search(hand);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUITS, RANKS, SUIT_MULTIPLIER,
    buildDeck, shuffle, determineJoker, isJokerCard, isFreeJoker, cardValue,
    isValidRun, isValidSet, isValidMeld, validateGrouping,
    canFormCompleteHand, findCompleteGrouping, scoreRound, minLooseValue,
    bestPartialGrouping,
  };
}
