import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';

function randomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { displayName, roundTarget } = await req.json();
  if (!displayName || typeof displayName !== 'string') {
    throw new HttpError(400, 'displayName is required');
  }

  const db = serviceClient();
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    code = randomCode();
    const { data: existing } = await db.from('rooms').select('id').eq('code', code).maybeSingle();
    if (!existing) break;
  }

  const { data: room, error: roomErr } = await db
    .from('rooms')
    .insert({ code, round_target: roundTarget ?? 8 })
    .select()
    .single();
  if (roomErr) throw new HttpError(500, roomErr.message);

  const { data: player, error: playerErr } = await db
    .from('room_players')
    .insert({ room_id: room.id, user_id: user.id, display_name: displayName, seat_order: 0 })
    .select()
    .single();
  if (playerErr) throw new HttpError(500, playerErr.message);

  return json({ room, player });
}));
