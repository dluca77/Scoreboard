// ESM port of /super-engine.js for Deno Edge Functions. Keep in sync with the
// root file — this is the server-side source of truth for rule validation.

export type Suit = 'C' | 'D' | 'H' | 'S' | 'J';
export type Rank = number | 'J' | 'Q' | 'K' | 'A' | 'JOKER';
export interface Card { suit: Suit; rank: Rank; id: string; }
export interface JokerSpec { suit: Suit; rank: Rank; }

export const SUITS: Suit[] = ['C', 'D', 'H', 'S'];
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'J', 'Q', 'K', 'A'];
export const SUIT_MULTIPLIER: Record<string, number> = { C: 2, S: 3, D: 4, H: 5 };

export function buildDeck(): Card[] {
  const cards: Card[] = [];
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

export function shuffle<T>(deck: T[], rng: () => number = Math.random): T[] {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextRankForJoker(rank: Rank): Rank {
  const idx = RANKS.indexOf(rank);
  return RANKS[(idx + 1) % RANKS.length];
}

export function determineJoker(openCard: Card): JokerSpec {
  return { suit: openCard.suit, rank: nextRankForJoker(openCard.rank) };
}

// Is this physical card one of the round's 4 joker cards (2 natural + 2
// printed)? Used for general "is this card special" purposes (candidate
// generation) — meld validation itself distinguishes the two kinds below,
// since they behave very differently.
export function isJokerCard(card: Card, jokerSpec: JokerSpec): boolean {
  if (card.suit === 'J') return true;
  return card.suit === jokerSpec.suit && card.rank === jokerSpec.rank;
}

// The "free" joker: an actual physical card of this round's designated
// rank+suit (e.g. the real ♥9 when ♥8 is the open card). Fully flexible —
// may stand in for any missing card in a meld.
export function isFreeJoker(card: Card, jokerSpec: JokerSpec): boolean {
  return card.suit === jokerSpec.suit && card.rank === jokerSpec.rank;
}

// The 2 printed joker cards are NOT flexible wildcards — they specifically
// take the place of this round's designated joker card (the free joker)
// and nothing else. So before validating a meld, replace each printed
// joker with that literal card identity; whether it actually fits is then
// just ordinary same-suit/same-rank matching, no special-casing needed.
function substitutePrintedJokers(cards: Card[], jokerSpec: JokerSpec): Card[] {
  return cards.map(c => c.suit === 'J' ? { suit: jokerSpec.suit, rank: jokerSpec.rank, id: c.id } : c);
}

export function cardValue(card: Card): number {
  if (typeof card.rank === 'number') return card.rank;
  if (card.rank === 'A') return 1;
  return 10;
}

const RUN_ORDER_LOW: Rank[] = ['A', 2, 3, 4, 5, 6, 7, 8, 9, 10, 'J', 'Q', 'K'];
const RUN_ORDER_HIGH: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'J', 'Q', 'K', 'A'];

export function isValidRun(cardsIn: Card[], jokerSpec: JokerSpec): boolean {
  if (cardsIn.length < 3) return false;
  const freeJokers = cardsIn.filter(c => isFreeJoker(c, jokerSpec));
  const real = substitutePrintedJokers(cardsIn.filter(c => !isFreeJoker(c, jokerSpec)), jokerSpec);
  const jokerCount = freeJokers.length; // only free jokers are flexible
  if (real.length === 0) return true;
  const suit = real[0].suit;
  if (!real.every(c => c.suit === suit)) return false;
  const rankSet = real.map(c => c.rank);
  if (new Set(rankSet).size !== rankSet.length) return false; // catches e.g. 2 printed jokers colliding

  const tryOrder = (order: Rank[]) => {
    const positions = real.map(c => order.indexOf(c.rank)).sort((a, b) => a - b);
    if (positions.some(p => p === -1)) return false;
    const lo = positions[0], hi = positions[positions.length - 1];
    const span = hi - lo + 1;
    if (span > cardsIn.length) return false;
    const need = span - real.length;
    if (need > jokerCount) return false;
    const extra = jokerCount - need;
    return span + extra === cardsIn.length || extra === 0;
  };
  return tryOrder(RUN_ORDER_LOW) || tryOrder(RUN_ORDER_HIGH);
}

export function isValidSet(cardsIn: Card[], jokerSpec: JokerSpec): boolean {
  if (cardsIn.length < 3 || cardsIn.length > 4) return false;
  const freeJokers = cardsIn.filter(c => isFreeJoker(c, jokerSpec));
  const real = substitutePrintedJokers(cardsIn.filter(c => !isFreeJoker(c, jokerSpec)), jokerSpec);
  const jokerCount = freeJokers.length;
  if (real.length === 0) return true;
  const rank = real[0].rank;
  if (!real.every(c => c.rank === rank)) return false;
  const suits = real.map(c => c.suit);
  if (new Set(suits).size !== suits.length) return false;
  return jokerCount <= 4 - real.length;
}

export function isValidMeld(cards: Card[], jokerSpec: JokerSpec): boolean {
  return isValidRun(cards, jokerSpec) || isValidSet(cards, jokerSpec);
}

export function validateGrouping(hand: Card[], groups: string[][], jokerSpec: JokerSpec) {
  const byId = new Map(hand.map(c => [c.id, c]));
  const used = new Set<string>();
  for (const group of groups) {
    const cards = group.map(id => byId.get(id)).filter(Boolean) as Card[];
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

function combinations<T>(arr: T[], k: number): T[][] {
  const results: T[][] = [];
  function helper(start: number, combo: T[]) {
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

// Runs have no upper length limit (unlike sets, capped at 4 by the suit
// count) — a 5+ card run like 5-6-7-8-9 of one suit is perfectly legal.
// Generating those via combinations(rest, k) for every k up to 12 would be
// combinatorially explosive, so instead this builds run candidates
// directly: anchor on `first`'s suit, scan every contiguous rank span
// (length 5+) that includes `first`, and check whether the gaps can be
// filled by however many joker cards are available. Sets and runs of
// length 3-4 are still covered separately via small combinations.
function longRunCandidates(first: Card, pool: Card[], jokerSpec: JokerSpec): Card[][] {
  if (isJokerCard(first, jokerSpec)) return [];
  const suit = first.suit;
  const jokerCards = pool.filter(c => c.id !== first.id && isJokerCard(c, jokerSpec));
  const bySuit = pool.filter(c => c.suit === suit && !isJokerCard(c, jokerSpec));
  const rankToCard = new Map<Rank, Card>();
  for (const c of bySuit) if (!rankToCard.has(c.rank)) rankToCard.set(c.rank, c);

  const results: Card[][] = [];
  for (const order of [RUN_ORDER_LOW, RUN_ORDER_HIGH]) {
    const firstPos = order.indexOf(first.rank);
    if (firstPos === -1) continue;
    for (let start = 0; start <= firstPos; start++) {
      for (let end = firstPos; end < order.length; end++) {
        const len = end - start + 1;
        if (len < 5) continue;
        const used: Card[] = [];
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

export function findCompleteGrouping(hand: Card[], jokerSpec: JokerSpec): string[][] | null {
  if (hand.length === 0) return [];
  if (hand.length < 3) return null;
  const first = hand[0];
  const rest = hand.slice(1);
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

export function canFormCompleteHand(hand: Card[], jokerSpec: JokerSpec): boolean {
  return findCompleteGrouping(hand, jokerSpec) !== null;
}

// Çift ("pairs") is an alternate way to complete a hand: instead of
// sets/runs, all 14 cards pair up into 7 pairs of the exact same card
// (same suit AND rank — possible because Super is played with 2 decks).
// This is a completely separate mechanic from the joker system: pairing
// is purely "does this exact card appear twice", no wildcards involved.
function cardKey(card: Card): string { return `${card.suit}${card.rank}`; }

export function ciftGrouping(hand: Card[]): { pairs: string[][]; loose: Card[] } {
  const byKey = new Map<string, Card[]>();
  for (const c of hand) {
    const k = cardKey(c);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(c);
  }
  const pairs: string[][] = [];
  const loose: Card[] = [];
  for (const group of byKey.values()) {
    if (group.length >= 2) pairs.push([group[0].id, group[1].id]);
    else loose.push(...group);
    if (group.length > 2) loose.push(...group.slice(2)); // can't happen with 2 decks, but stay safe
  }
  return { pairs, loose };
}

export function canFormCompleteCift(hand: Card[]): boolean {
  return hand.length > 0 && ciftGrouping(hand).loose.length === 0;
}

// For a hand that is NOT (necessarily) fully meldable, find the decomposition
// into melds that minimizes the point-value of the leftover loose cards.
export function minLooseValue(hand: Card[], jokerSpec: JokerSpec): { loose: Card[]; value: number } {
  const memo = new Map<string, { loose: Card[]; value: number }>();
  function search(cards: Card[]): { loose: Card[]; value: number } {
    if (cards.length === 0) return { loose: [], value: 0 };
    const key = cards.map(c => c.id).sort().join(',');
    const cached = memo.get(key);
    if (cached) return cached;
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

// Same search as minLooseValue, but also returns which melds it chose (as
// arrays of card ids) instead of just the leftover value — used to reveal
// how far a non-opening player got when a round ends.
export function bestPartialGrouping(hand: Card[], jokerSpec: JokerSpec): { loose: Card[]; groups: string[][]; value: number } {
  const memo = new Map<string, { loose: Card[]; groups: string[][]; value: number }>();
  function search(cards: Card[]): { loose: Card[]; groups: string[][]; value: number } {
    if (cards.length === 0) return { loose: [], groups: [], value: 0 };
    const key = cards.map(c => c.id).sort().join(',');
    const cached = memo.get(key);
    if (cached) return cached;
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

export interface RoundResultInput {
  playerId: string;
  looseCards: Card[];
  opened: boolean;
  openedWithJoker: boolean;
  openedCift: boolean;
  wasTurning: boolean;
}

export function scoreRound(
  results: RoundResultInput[],
  openCard: Card,
  opts: { stockExhausted?: boolean } = {},
): Record<string, number> {
  const stockExhausted = !!opts.stockExhausted;
  const baseMult = SUIT_MULTIPLIER[openCard.suit];
  const opener = results.find(r => r.opened);
  const jokerOpen = !!(opener && opener.openedWithJoker);
  const effMult = stockExhausted ? baseMult : baseMult * (jokerOpen ? 2 : 1);

  const scores: Record<string, number> = {};
  for (const r of results) {
    let pts = 0;
    if (!stockExhausted && r.opened) {
      if (r.openedCift && r.openedWithJoker) pts += -1000;      // çift-joker
      else if (r.openedCift) pts += -500;                       // çift
      else if (r.openedWithJoker) pts += -500;                  // normal open with joker
      else pts += -100;                                         // normal open
    } else {
      const loose = r.looseCards.reduce((s, c) => s + cardValue(c), 0);
      pts += loose * effMult;
    }
    if (!stockExhausted && r.wasTurning && !r.opened) pts += 500;
    scores[r.playerId] = pts;
  }
  return scores;
}
