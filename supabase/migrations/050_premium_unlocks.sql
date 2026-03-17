-- Premium unlock tracking per authenticated user.
-- One row per unlock. Daily limit enforced in application code.
create table if not exists back_in_play_premium_unlocks (
  id         bigint generated always as identity primary key,
  user_id    uuid    not null references auth.users(id) on delete cascade,
  content_id text    not null,
  unlock_date date   not null default current_date,
  created_at timestamptz not null default now(),
  unique(user_id, content_id, unlock_date)
);

-- Fast lookup: "how many unlocks has this user used today?"
create index if not exists idx_premium_unlocks_user_date
  on back_in_play_premium_unlocks (user_id, unlock_date);

-- RLS: users can only read/write their own rows
alter table back_in_play_premium_unlocks enable row level security;

create policy "Users can read own unlocks"
  on back_in_play_premium_unlocks for select
  using (auth.uid() = user_id);

create policy "Users can insert own unlocks"
  on back_in_play_premium_unlocks for insert
  with check (auth.uid() = user_id);
