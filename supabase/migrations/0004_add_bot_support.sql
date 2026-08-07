-- "Tegen computer" test mode: a bot player has no real auth session, so
-- it's driven by the human player's client calling the bot-move Edge
-- Function whenever it's the bot's turn. is_bot marks which room_players
-- row is a bot so bot-move (and the client) can find it and validate it's
-- really the bot's turn before acting on its behalf.
alter table room_players add column if not exists is_bot boolean not null default false;
