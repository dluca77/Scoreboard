-- Super multiplayer card game — schema + RLS.
-- All writes to game state go through Edge Functions using the service_role
-- key (which bypasses RLS). Clients only ever SELECT directly, and only ever
-- their own row of `hands` — this is what stops one player's browser from
-- reading another player's cards.
--
-- Players authenticate via Supabase anonymous auth (supabase.auth.signInAnonymously())
-- so `auth.uid()` gives a stable per-device identity without a login screen.

create extension if not exists pgcrypto;

create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  status text not null default 'lobby', -- lobby | playing | finished
  round_target int not null default 8,
  current_round int not null default 0,
  created_at timestamptz not null default now()
);

create table room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid not null, -- auth.uid() of the device
  display_name text not null,
  team int, -- null = no teams, 0/1 = team index for 2v2
  seat_order int not null,
  total_score int not null default 0,
  connected_at timestamptz not null default now(),
  unique(room_id, user_id)
);

create table rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  round_no int not null,
  stock jsonb not null,             -- remaining face-down cards
  discard jsonb not null default '[]', -- discard pile, last element = top
  open_card jsonb not null,         -- the very first face-up card (sets joker + multiplier)
  joker_suit text not null,
  joker_rank text not null,
  turn_player_id uuid not null references room_players(id),
  phase text not null default 'playing', -- playing | finished
  winner_player_id uuid references room_players(id),
  opened_with_joker boolean not null default false,
  created_at timestamptz not null default now(),
  unique(room_id, round_no)
);

create table hands (
  round_id uuid not null references rounds(id) on delete cascade,
  player_id uuid not null references room_players(id) on delete cascade,
  user_id uuid not null, -- denormalized for a simple RLS check
  cards jsonb not null,
  is_turning boolean not null default false,
  primary key (round_id, player_id)
);

create table round_results (
  round_id uuid not null references rounds(id) on delete cascade,
  player_id uuid not null references room_players(id) on delete cascade,
  penalty_points int not null,
  opened boolean not null default false,
  opened_with_joker boolean not null default false,
  was_turning boolean not null default false,
  primary key (round_id, player_id)
);

-- ── RLS ──
alter table rooms enable row level security;
alter table room_players enable row level security;
alter table rounds enable row level security;
alter table hands enable row level security;
alter table round_results enable row level security;

-- Any authenticated (incl. anonymous) client can read room/round metadata —
-- none of it reveals hidden information (no cards in these tables).
create policy "rooms readable" on rooms for select to authenticated using (true);
create policy "room_players readable" on room_players for select to authenticated using (true);
create policy "rounds readable" on rounds for select to authenticated using (true);
create policy "round_results readable" on round_results for select to authenticated using (true);

-- Hands are the one place actual cards live — a player may only ever read
-- their own row. There is no insert/update/delete policy for any table:
-- all mutations happen server-side via Edge Functions using the service_role
-- key, which bypasses RLS entirely.
create policy "hands readable only by owner" on hands for select to authenticated
  using (user_id = auth.uid());
