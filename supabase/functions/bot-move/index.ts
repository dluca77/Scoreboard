import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';
import { Card, JokerSpec, isJokerCard, findCompleteGrouping, minLooseValue, canFormCompleteHand } from '../_shared/engine.ts';
import { finalizeRound } from '../_shared/finish.ts';

// Plays exactly one full bot turn (draw, then open-if-possible or
// discard-the-least-useful-card). Triggered by a human player's client
// whenever it notices it's the bot's turn — the bot has no session of
// its own. Only proceeds if the caller is really in the room and it is
// really the bot's turn, so a human can't use this to puppet anyone else.
Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { roundId } = await req.json();
  if (!roundId) throw new HttpError(400, 'roundId is required');

  const db = serviceClient();
  const { data: round, error: roundErr } = await db.from('rounds').select('*').eq('id', roundId).single();
  if (roundErr) throw new HttpError(404, 'Round not found');
  if (round.phase !== 'playing') throw new HttpError(409, 'Round is not in progress');

  const { data: players, error: playersErr } = await db
    .from('room_players').select('*').eq('room_id', round.room_id).order('seat_order', { ascending: true });
  if (playersErr) throw new HttpError(500, playersErr.message);
  const caller = players.find((p: any) => p.user_id === user.id);
  if (!caller) throw new HttpError(403, 'Not a player in this room');

  const bot = players.find((p: any) => p.is_bot);
  if (!bot) throw new HttpError(400, 'No bot in this room');
  if (round.turn_player_id !== bot.id) throw new HttpError(409, "Not the bot's turn");

  const { data: hand, error: handErr } = await db
    .from('hands').select('*').eq('round_id', roundId).eq('player_id', bot.id).single();
  if (handErr) throw new HttpError(404, 'Bot hand not found');

  const jokerSpec: JokerSpec = {
    suit: round.joker_suit,
    rank: isNaN(Number(round.joker_rank)) ? round.joker_rank : Number(round.joker_rank),
  };

  let cards: Card[] = hand.cards;

  if (cards.length === 14) {
    if (round.stock.length === 0) {
      const { data: allHands } = await db.from('hands').select('*').eq('round_id', roundId);
      await finalizeRound(db, round, players, allHands, {});
      return json({ acted: true, reason: 'stock_exhausted' });
    }
    const drawn = round.stock[round.stock.length - 1];
    const newStock = round.stock.slice(0, -1);
    await db.from('rounds').update({ stock: newStock }).eq('id', roundId);
    cards = [...cards, drawn];
    await db.from('hands').update({ cards }).eq('round_id', roundId).eq('player_id', bot.id);
  }

  // Can the bot go out this turn? Try each card as the leftover discard.
  let openGroups: string[][] | null = null;
  let leftoverCard: Card | null = null;
  for (const candidate of cards) {
    const remaining = cards.filter((c) => c.id !== candidate.id);
    const grouping = findCompleteGrouping(remaining, jokerSpec);
    if (grouping) { openGroups = grouping; leftoverCard = candidate; break; }
  }

  if (openGroups && leftoverCard) {
    const openedWithJoker = isJokerCard(leftoverCard, jokerSpec);
    const { data: allHands } = await db.from('hands').select('*').eq('round_id', roundId);
    const { scores } = await finalizeRound(db, round, players, allHands, {
      openerPlayerId: bot.id,
      openedWithJoker,
      openerLooseCards: [],
    });
    return json({ acted: true, opened: true, scores });
  }

  // Otherwise discard whichever card leaves the lowest-value loose hand.
  let bestCard = cards[0];
  let bestValue = Infinity;
  for (const candidate of cards) {
    const remaining = cards.filter((c) => c.id !== candidate.id);
    const { value } = minLooseValue(remaining, jokerSpec);
    if (value < bestValue) { bestValue = value; bestCard = candidate; }
  }
  const remaining = cards.filter((c) => c.id !== bestCard.id);
  const isTurning = canFormCompleteHand(remaining, jokerSpec);
  const seatIdx = players.findIndex((p: any) => p.id === bot.id);
  const nextPlayer = players[(seatIdx + 1) % players.length];

  await db.from('hands').update({ cards: remaining, is_turning: isTurning })
    .eq('round_id', roundId).eq('player_id', bot.id);
  await db.from('rounds').update({
    discard: [...round.discard, bestCard],
    turn_player_id: nextPlayer.id,
  }).eq('id', roundId);

  return json({ acted: true, opened: false, discarded: bestCard });
}));
