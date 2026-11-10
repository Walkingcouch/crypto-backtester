-- Coins you open on the Predict page get added to the 5-hourly forecast log
create table if not exists public.tracked_coins (
  symbol text primary key, name text, added_at timestamptz not null default now());
alter table public.tracked_coins enable row level security;
drop policy if exists t_read on public.tracked_coins;
create policy t_read on public.tracked_coins for select to anon, authenticated using (true);

create or replace function public.track_coin(secret text, symbol text, name text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if secret is distinct from 'yP6UcfEB0Sp1aKCR4fI9Z2DubyZc1eTS' then raise exception 'denied'; end if;
  if symbol !~ '^[A-Z0-9]{2,15}USDT$' then raise exception 'bad symbol'; end if;
  if exists (select 1 from public.tracked_coins t where t.symbol = track_coin.symbol) then return 'already'; end if;
  if (select count(*) from public.tracked_coins) >= 50 then return 'full'; end if;
  insert into public.tracked_coins (symbol, name) values (track_coin.symbol, left(track_coin.name, 40));
  return 'added';
end $$;
revoke all on function public.track_coin(text, text, text) from public;
grant execute on function public.track_coin(text, text, text) to anon;
