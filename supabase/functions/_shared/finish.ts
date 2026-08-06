import { Card, JokerSpec, isJokerCard, minLooseValue, scoreRound, RoundResultInput } from './engine.ts';

interface PlayerRow { id: string; total_score: number; }
interface HandRow { player_id: string; cards: Card[]; is_turning: boolean; }
interface RoundRow { id: string; room_id: string; open_card: Card; joker_suit: string; joker_rank: string; }

// Shared by draw-card (stock exhausted) and open-hand (someone opened).
// Computes penalties for every player, writes round_results, bumps
// room_players.total_score, closes out the round, and advances/ends the room.
export async function finalizeRound(
  // deno-lint-ignore no-explicit-any
  db: any,
  round: RoundRow,
  players: PlayerRow[],
  hands: HandRow[],
  opts: { openerPlayerId?: string; openedWithJoker?: boolean; openerLooseCards?: Card[] },
) {
  const jokerSpec: JokerSpec = { suit: round.joker_suit as JokerSpec['suit'], rank: round.joker_rank as JokerSpec['rank'] };
  const stockExhausted = !opts.openerPlayerId;

  const results: RoundResultInput[] = hands.map(h => {
    const opened = h.player_id === opts.openerPlayerId;
    const looseCards = opened
      ? (opts.openerLooseCards ?? [])
      : minLooseValue(h.cards, jokerSpec).loose;
    return {
      playerId: h.player_id,
      looseCards,
      opened,
      openedWithJoker: opened && !!opts.openedWithJoker,
      wasTurning: h.is_turning,
    };
  });

  const scores = scoreRound(results, round.open_card, { stockExhausted });

  const resultRows = results.map(r => ({
    round_id: round.id,
    player_id: r.playerId,
    penalty_points: scores[r.playerId],
    opened: r.opened,
    opened_with_joker: r.openedWithJoker,
    was_turning: r.wasTurning,
  }));
  await db.from('round_results').insert(resultRows);

  for (const p of players) {
    const delta = scores[p.id] ?? 0;
    await db.from('room_players').update({ total_score: p.total_score + delta }).eq('id', p.id);
  }

  await db.from('rounds').update({
    phase: 'finished',
    winner_player_id: opts.openerPlayerId ?? null,
  }).eq('id', round.id);

  const { data: room } = await db.from('rooms').select('*').eq('id', round.room_id).single();
  if (room && room.current_round >= room.round_target) {
    await db.from('rooms').update({ status: 'finished' }).eq('id', room.id);
  } else {
    await db.from('rooms').update({ status: 'lobby' }).eq('id', round.room_id);
    // status returns to 'lobby' between rounds; any player can call start-round again.
  }

  return { scores };
}

export { isJokerCard };
