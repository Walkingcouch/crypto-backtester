-- Part 1: the forecasts table (readable by the site, written only by the daily job)
create table if not exists public.forecasts (
  as_of date not null, symbol text not null, horizon int not null,
  price float8 not null, p5 float8, p10 float8, p25 float8, p75 float8, p90 float8, p95 float8,
  p_up float8, p_up_mood float8, fng int, news_24h int, news_tone float8,
  created_at timestamptz not null default now(),
  primary key (as_of, symbol, horizon));
alter table public.forecasts enable row level security;
drop policy if exists f_read on public.forecasts;
create policy f_read on public.forecasts for select to anon, authenticated using (true);

-- Part 2: the function the daily job calls (it must send the secret)
create or replace function public.log_forecasts(secret text, rows jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if secret is distinct from 'yP6UcfEB0Sp1aKCR4fI9Z2DubyZc1eTS' then raise exception 'denied'; end if;
  insert into public.forecasts (as_of, symbol, horizon, price, p5, p10, p25, p75, p90, p95, p_up, p_up_mood, fng, news_24h, news_tone)
  select * from jsonb_to_recordset(rows) as x(as_of date, symbol text, horizon int, price float8, p5 float8, p10 float8, p25 float8, p75 float8, p90 float8, p95 float8, p_up float8, p_up_mood float8, fng int, news_24h int, news_tone float8)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.log_forecasts(text, jsonb) from public;
grant execute on function public.log_forecasts(text, jsonb) to anon;
