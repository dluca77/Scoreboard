import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';
import { validateGrouping, isFreeJoker, ciftGrouping, JokerSpec } from '../_shared/engine.ts';
import { finalizeRound } from '../_shared/finish.ts';

Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { roundId, groups, discardCardId, mode } = await req.json();
  const isCift = mode === 'cift';
  if (!roundId || !discardCardId || (!isCift && !Array.isArray(groups))) {
    throw new HttpError(400, 'roundId, discardCardId, and groups (unless mode is cift) are required');
  }

  const db = serviceClient();
  const { data: round, error: roundErr } = await db.from('rounds').select('*').eq('id', roundId).single();
  if (roundErr) throw new HttpError(404, 'Round not found');
  if (round.phase !== 'playing') throw new HttpError(409, 'Round is not in progress');

  const { data: players, error: playersErr } = await db
    .from('room_players').select('*').eq('room_id', round.room_id);
  if (playersErr) throw new HttpError(500, playersErr.message);
  const caller = players.find(p => p.user_id === user.id);
  if (!caller) throw new HttpError(403, 'Not a player in this room');
  if (round.turn_player_id !== caller.id) throw new HttpError(409, 'Not your turn');

  const { data: hand, error: handErr } = await db
    .from('hands').select('*').eq('round_id', roundId).eq('player_id', caller.id).single();
  if (handErr) throw new HttpError(404, 'Hand not found');
  if (hand.cards.length !== 15) throw new HttpError(409, 'Draw a card before opening');

  const jokerSpec: JokerSpec = {
    suit: round.joker_suit,
    rank: isNaN(Number(round.joker_rank)) ? round.joker_rank : Number(round.joker_rank),
  };

  let finalGroups: string[][];
  let discardedCard;
  if (isCift) {
    // Çift ("pairs"): all 14 remaining cards must pair up into 7 pairs of
    // the exact same card — a completely separate mechanic from the
    // normal joker-assisted sets/runs, so it's recomputed directly from
    // the hand rather than trusting client-submitted groups.
    discardedCard = hand.cards.find((c: { id: string }) => c.id === discardCardId);
    if (!discardedCard) throw new HttpError(400, 'discardCardId not in hand');
    const remaining = hand.cards.filter((c: { id: string }) => c.id !== discardCardId);
    const { pairs, loose } = ciftGrouping(remaining);
    if (loose.length !== 0) throw new HttpError(400, 'Hand is not a complete çift (7 pairs)');
    finalGroups = pairs;
  } else {
    const { valid, looseCards } = validateGrouping(hand.cards, groups, jokerSpec);
    if (!valid || looseCards.length !== 1 || looseCards[0].id !== discardCardId) {
      throw new HttpError(400, 'Invalid grouping — hand is not a valid complete meld with exactly one leftover card');
    }
    discardedCard = looseCards[0];
    finalGroups = groups;
  }

  // "Opening with joker" only counts when the discarded card is the free
  // (real) joker — discarding a printed joker card is just a normal open,
  // since the printed joker only ever stands in for the free joker, it
  // isn't itself the special card this bonus is about. Discarding the
  // free joker as the 15th card of a complete çift hand is "çift-joker".
  const openedWithJoker = isFreeJoker(discardedCard, jokerSpec);

  const { data: allHands, error: allHandsErr } = await db.from('hands').select('*').eq('round_id', roundId);
  if (allHandsErr) throw new HttpError(500, allHandsErr.message);

  const { scores } = await finalizeRound(db, round, players, allHands, {
    openerPlayerId: caller.id,
    openedWithJoker,
    openedCift: isCift,
    openerLooseCards: [],
    openerGroups: finalGroups,
  });

  return json({ scores, openedWithJoker, openedCift: isCift, groups: finalGroups });
}));
