import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';
import { canFormCompleteHand, JokerSpec } from '../_shared/engine.ts';

Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { roundId, cardId } = await req.json();
  if (!roundId || !cardId) throw new HttpError(400, 'roundId and cardId are required');

  const db = serviceClient();
  const { data: round, error: roundErr } = await db.from('rounds').select('*').eq('id', roundId).single();
  if (roundErr) throw new HttpError(404, 'Round not found');
  if (round.phase !== 'playing') throw new HttpError(409, 'Round is not in progress');

  const { data: players, error: playersErr } = await db
    .from('room_players').select('*').eq('room_id', round.room_id).order('seat_order', { ascending: true });
  if (playersErr) throw new HttpError(500, playersErr.message);
  const caller = players.find(p => p.user_id === user.id);
  if (!caller) throw new HttpError(403, 'Not a player in this room');
  if (round.turn_player_id !== caller.id) throw new HttpError(409, 'Not your turn');

  const { data: hand, error: handErr } = await db
    .from('hands').select('*').eq('round_id', roundId).eq('player_id', caller.id).single();
  if (handErr) throw new HttpError(404, 'Hand not found');
  if (hand.cards.length !== 15) throw new HttpError(409, 'Draw a card before discarding');

  const idx = hand.cards.findIndex((c: { id: string }) => c.id === cardId);
  if (idx === -1) throw new HttpError(400, 'Card not in hand');

  const remaining = hand.cards.slice(0, idx).concat(hand.cards.slice(idx + 1));
  const discardedCard = hand.cards[idx];

  const jokerSpec: JokerSpec = { suit: round.joker_suit, rank: round.joker_rank };
  const isTurning = canFormCompleteHand(remaining, jokerSpec);

  const seatIdx = players.findIndex(p => p.id === caller.id);
  const nextPlayer = players[(seatIdx + 1) % players.length];

  await db.from('hands').update({ cards: remaining, is_turning: isTurning })
    .eq('round_id', roundId).eq('player_id', caller.id);
  await db.from('rounds').update({
    discard: [...round.discard, discardedCard],
    turn_player_id: nextPlayer.id,
  }).eq('id', roundId);

  return json({ cards: remaining, isTurning, nextPlayerId: nextPlayer.id });
}));
