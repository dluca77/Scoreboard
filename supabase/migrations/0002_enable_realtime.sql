-- New tables aren't broadcast over Realtime until added to the
-- supabase_realtime publication. Without this, clients only ever see
-- data from their initial SELECT — they never receive live INSERT/UPDATE
-- events (e.g. another player joining a room), even though RLS allows
-- them to read it. Realtime Postgres Changes still respects each
-- table's RLS policies, so this does not loosen access (hands stays
-- owner-only).

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rooms') then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='room_players') then
    alter publication supabase_realtime add table public.room_players;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rounds') then
    alter publication supabase_realtime add table public.rounds;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='hands') then
    alter publication supabase_realtime add table public.hands;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='round_results') then
    alter publication supabase_realtime add table public.round_results;
  end if;
end $$;
