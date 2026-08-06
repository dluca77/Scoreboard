import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';
import { finalizeRound } from '../_shared/finish.ts';

Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { roundId, source } = await req.json();
  if (!roundId || (source !== 'stock' && source !== 'discard')) {
    throw new HttpError(400, 'roundId and source ("stock"|"discard") are required');
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
  if (hand.cards.length !== 14) throw new HttpError(409, 'You already drew this turn');

  if (source === 'stock' && round.stock.length === 0) {
    const { data: allHands } = await db.from('hands').select('*').eq('round_id', roundId);
    await finalizeRound(db, round, players, allHands, {});
    return json({ roundFinished: true, reason: 'stock_exhausted' });
  }

  let drawnCard;
  const update: Record<string, unknown> = {};
  if (source === 'stock') {
    drawnCard = round.stock[round.stock.length - 1];
    update.stock = round.stock.slice(0, -1);
  } else {
    if (round.discard.length === 0) throw new HttpError(409, 'Discard pile is empty');
    drawnCard = round.discard[round.discard.length - 1];
    update.discard = round.discard.slice(0, -1);
  }

  await db.from('rounds').update(update).eq('id', roundId);
  const newCards = [...hand.cards, drawnCard];
  await db.from('hands').update({ cards: newCards }).eq('round_id', roundId).eq('player_id', caller.id);

  return json({ drawnCard, cards: newCards });
}));
