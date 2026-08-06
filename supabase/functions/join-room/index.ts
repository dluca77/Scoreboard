import { handle, json, requireUser, serviceClient, HttpError } from '../_shared/supa.ts';

Deno.serve((req) => handle(req, async (req) => {
  const user = await requireUser(req);
  const { code, displayName } = await req.json();
  if (!code || !displayName) throw new HttpError(400, 'code and displayName are required');

  const db = serviceClient();
  const { data: room, error: roomErr } = await db
    .from('rooms')
    .select('*')
    .eq('code', String(code).toUpperCase())
    .maybeSingle();
  if (roomErr) throw new HttpError(500, roomErr.message);
  if (!room) throw new HttpError(404, 'Room not found');
  if (room.status !== 'lobby') throw new HttpError(409, 'Room already started');

  const { data: existingPlayers, error: countErr } = await db
    .from('room_players')
    .select('id, user_id')
    .eq('room_id', room.id);
  if (countErr) throw new HttpError(500, countErr.message);
  if (existingPlayers.length >= 4) throw new HttpError(409, 'Room is full');

  const already = existingPlayers.find(p => p.user_id === user.id);
  if (already) return json({ room, player: already, rejoin: true });

  const { data: player, error: playerErr } = await db
    .from('room_players')
    .insert({ room_id: room.id, user_id: user.id, display_name: displayName, seat_order: existingPlayers.length })
    .select()
    .single();
  if (playerErr) throw new HttpError(500, playerErr.message);

  return json({ room, player });
}));
