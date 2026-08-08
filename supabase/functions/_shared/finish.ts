import { Card, JokerSpec, isJokerCard, bestPartialGrouping, cardValue, ciftGrouping, scoreRound, RoundResultInput } from './engine.ts';

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
  opts: { openerPlayerId?: string; openedWithJoker?: boolean; openedCift?: boolean; openerLooseCards?: Card[]; openerGroups?: string[][] },
) {
  // joker_rank is stored as a string (see start-round), but card.rank is a
  // number for numeric ranks — comparing them with the raw string would
  // silently fail to recognize any numeric-rank joker card as a joker,
  // both here (everyone's leftover-value scoring) and in isJokerCard below.
  const jokerSpec: JokerSpec = {
    suit: round.joker_suit as JokerSpec['suit'],
    rank: (isNaN(Number(round.joker_rank)) ? round.joker_rank : Number(round.joker_rank)) as JokerSpec['rank'],
  };
  const stockExhausted = !opts.openerPlayerId;

  // Everyone's hand — including the opener's — gets laid out for the
  // "table reveal" at round end, so the rest of the table can see how
  // close (or not) everyone else actually was. Non-openers get scored
  // under whichever interpretation of their hand is best for them — the
  // normal sets/runs grouping, or the çift (identical-pairs) grouping —
  // since either could apply and there's no way to know which one they
  // were actually going for.
  const grouped = new Map<string, { loose: Card[]; groups: string[][] }>();
  for (const h of hands) {
    const opened = h.player_id === opts.openerPlayerId;
    if (opened) {
      grouped.set(h.player_id, { loose: opts.openerLooseCards ?? [], groups: opts.openerGroups ?? [] });
    } else {
      const normal = bestPartialGrouping(h.cards, jokerSpec);
      const cift = ciftGrouping(h.cards);
      const normalValue = normal.loose.reduce((s, c) => s + cardValue(c), 0);
      const ciftValue = cift.loose.reduce((s, c) => s + cardValue(c), 0);
      grouped.set(h.player_id, ciftValue < normalValue
        ? { loose: cift.loose, groups: cift.pairs }
        : { loose: normal.loose, groups: normal.groups });
    }
  }

  const results: RoundResultInput[] = hands.map(h => {
    const opened = h.player_id === opts.openerPlayerId;
    return {
      playerId: h.player_id,
      looseCards: grouped.get(h.player_id)!.loose,
      opened,
      openedWithJoker: opened && !!opts.openedWithJoker,
      openedCift: opened && !!opts.openedCift,
      wasTurning: h.is_turning,
    };
  });

  const scores = scoreRound(results, round.open_card, { stockExhausted });

  const resultRows = results.map(r => {
    const g = grouped.get(r.playerId)!;
    const allCards = hands.find(h => h.player_id === r.playerId)!.cards;
    // For the opener, only the melded 14 cards should be shown (the 15th,
    // discarded card isn't part of the completed hand); for everyone else
    // it's whatever they were still holding when the round ended.
    const shownCards = r.opened
      ? allCards.filter(c => g.groups.some(group => group.includes(c.id)))
      : allCards;
    return {
      round_id: round.id,
      player_id: r.playerId,
      penalty_points: scores[r.playerId],
      opened: r.opened,
      opened_with_joker: r.openedWithJoker,
      opened_cift: r.openedCift,
      was_turning: r.wasTurning,
      hand_cards: shownCards,
      groups: g.groups,
    };
  });
  // These writes don't depend on each other, so fire them together instead
  // of one network round-trip at a time — with several players that was
  // the main source of the multi-second lag after opening a hand.
  await Promise.all([
    db.from('round_results').insert(resultRows),
    // Reset everyone's "ready" flag here too — the round-end screen reuses
    // the same lobby-style ready gate for starting the next round, so a
    // stale ready=true from before this round shouldn't let it skip ahead.
    ...players.map(p => db.from('room_players').update({ total_score: p.total_score + (scores[p.id] ?? 0), ready: false }).eq('id', p.id)),
    db.from('rounds').update({
      phase: 'finished',
      winner_player_id: opts.openerPlayerId ?? null,
    }).eq('id', round.id),
  ]);

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
