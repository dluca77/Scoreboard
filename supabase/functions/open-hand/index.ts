import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';
import { validateGrouping, isJokerCard, JokerSpec } from '../_shared/engine.ts';
import { finalizeRound } from '../_shared/finish.ts';

Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { roundId, groups, discardCardId } = await req.json();
  if (!roundId || !Array.isArray(groups) || !discardCardId) {
    throw new HttpError(400, 'roundId, groups and discardCardId are required');
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
  const { valid, looseCards } = validateGrouping(hand.cards, groups, jokerSpec);
  if (!valid || looseCards.length !== 1 || looseCards[0].id !== discardCardId) {
    throw new HttpError(400, 'Invalid grouping — hand is not a valid complete meld with exactly one leftover card');
  }

  const openedWithJoker = isJokerCard(looseCards[0], jokerSpec);

  const { data: allHands, error: allHandsErr } = await db.from('hands').select('*').eq('round_id', roundId);
  if (allHandsErr) throw new HttpError(500, allHandsErr.message);

  const { scores } = await finalizeRound(db, round, players, allHands, {
    openerPlayerId: caller.id,
    openedWithJoker,
    openerLooseCards: [],
  });

  return json({ scores, openedWithJoker, groups });
}));
