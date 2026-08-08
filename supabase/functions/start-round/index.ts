import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';
import { buildDeck, shuffle, determineJoker, canFormCompleteHand, SUIT_MULTIPLIER } from '../_shared/engine.ts';

Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { roomId } = await req.json();
  if (!roomId) throw new HttpError(400, 'roomId is required');

  const db = serviceClient();
  const { data: room, error: roomErr } = await db.from('rooms').select('*').eq('id', roomId).single();
  if (roomErr) throw new HttpError(404, 'Room not found');

  const { data: players, error: playersErr } = await db
    .from('room_players')
    .select('*')
    .eq('room_id', roomId)
    .order('seat_order', { ascending: true });
  if (playersErr) throw new HttpError(500, playersErr.message);
  if (!players.some(p => p.user_id === user.id)) throw new HttpError(403, 'Not a player in this room');
  if (players.length < 2) throw new HttpError(400, 'Need at least 2 players');

  const roundNo = room.current_round + 1;
  const deck = shuffle(buildDeck());

  const hands: Record<string, typeof deck> = {};
  for (const p of players) hands[p.id] = [];
  let idx = 0;
  for (let i = 0; i < 14; i++) {
    for (const p of players) hands[p.id].push(deck[idx++]);
  }
  const openCard = deck[idx++];
  const stock = deck.slice(idx);
  const jokerSpec = determineJoker(openCard);

  // House rule: if the exact card that got turned up as the open card
  // (same suit + rank, not just the joker rank) was also dealt into your
  // starting hand, that's an immediate bonus (negative points, same sign
  // convention as opening — lower total_score is better) — same per-suit
  // scale as the end-of-round multiplier (club 2, spade 3, diamond 4,
  // heart 5), times 10, per matching card (you can hold both copies from
  // the two decks).
  const dealBonusPerCard = -SUIT_MULTIPLIER[openCard.suit] * 10;
  const dealPenalties: Record<string, number> = {};
  for (const p of players) {
    const matches = hands[p.id].filter(c => c.suit === openCard.suit && c.rank === openCard.rank).length;
    if (matches > 0) dealPenalties[p.id] = matches * dealBonusPerCard;
  }

  const dealerSeat = (roundNo - 1) % players.length;
  const firstTurnSeat = (dealerSeat + 1) % players.length;
  const firstTurnPlayer = players[firstTurnSeat];

  const { data: round, error: roundErr } = await db
    .from('rounds')
    .insert({
      room_id: roomId,
      round_no: roundNo,
      stock,
      discard: [],
      open_card: openCard,
      joker_suit: jokerSpec.suit,
      joker_rank: String(jokerSpec.rank),
      turn_player_id: firstTurnPlayer.id,
      deal_penalties: dealPenalties,
    })
    .select()
    .single();
  if (roundErr) throw new HttpError(500, roundErr.message);

  for (const p of players) {
    const penalty = dealPenalties[p.id];
    if (penalty) await db.from('room_players').update({ total_score: p.total_score + penalty }).eq('id', p.id);
  }

  const handRows = players.map(p => ({
    round_id: round.id,
    player_id: p.id,
    user_id: p.user_id,
    cards: hands[p.id],
    is_turning: canFormCompleteHand(hands[p.id], jokerSpec),
  }));
  const { error: handsErr } = await db.from('hands').insert(handRows);
  if (handsErr) throw new HttpError(500, handsErr.message);

  await db.from('rooms').update({ status: 'playing', current_round: roundNo }).eq('id', roomId);

  return json({ round, jokerSpec });
}));
