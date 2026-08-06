-- Ready-up flow: the room creator (lowest seat_order) starts the round,
-- other players mark themselves ready first. `ready` is not sensitive
-- information (unlike hand contents), so players are allowed to update
-- only their own row's ready flag directly from the client.

alter table room_players add column if not exists ready boolean not null default false;

create policy "players can set their own ready state" on room_players
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
