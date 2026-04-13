create table if not exists back_in_play_waitlist (
  id bigint generated always as identity primary key,
  email text not null,
  source text not null default 'unknown',
  page text,
  created_at timestamptz not null default now(),
  unique(email)
);

-- Allow inserts from anon (public site)
alter table back_in_play_waitlist enable row level security;
create policy "Anyone can join waitlist"
  on back_in_play_waitlist for insert
  to anon, authenticated
  with check (true);
