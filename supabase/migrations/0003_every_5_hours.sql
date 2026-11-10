-- Part 1: each forecast now has a time, a target time and a stored result
alter table public.forecasts add column if not exists made_at timestamptz, add column if not exists target_at timestamptz, add column if not exists outcome float8, add column if not exists graded_at timestamptz;
update public.forecasts set made_at = (as_of + 1)::timestamptz where made_at is null;
update public.forecasts set target_at = made_at + make_interval(days => horizon) where target_at is null;
alter table public.forecasts alter column made_at set not null;
alter table public.forecasts drop constraint if exists forecasts_pkey;
alter table public.forecasts add primary key (symbol, horizon, made_at);

-- Part 2: save and grade functions (used by the job)
create or replace function public.log_forecasts(secret text, rows jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if secret is distinct from 'yP6UcfEB0Sp1aKCR4fI9Z2DubyZc1eTS' then raise exception 'denied'; end if;
  insert into public.forecasts (as_of, symbol, horizon, price, made_at, target_at, p5, p10, p25, p75, p90, p95, p_up, p_up_mood, fng, news_24h, news_tone)
  select * from jsonb_to_recordset(rows) as x(as_of date, symbol text, horizon int, price float8, made_at timestamptz, target_at timestamptz, p5 float8, p10 float8, p25 float8, p75 float8, p90 float8, p95 float8, p_up float8, p_up_mood float8, fng int, news_24h int, news_tone float8)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
create or replace function public.grade_forecasts(secret text, rows jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if secret is distinct from 'yP6UcfEB0Sp1aKCR4fI9Z2DubyZc1eTS' then raise exception 'denied'; end if;
  update public.forecasts f set outcome = x.outcome, graded_at = now()
  from jsonb_to_recordset(rows) as x(symbol text, horizon int, made_at timestamptz, outcome float8)
  where f.symbol = x.symbol and f.horizon = x.horizon and f.made_at = x.made_at and f.outcome is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.grade_forecasts(text, jsonb) from public;
grant execute on function public.grade_forecasts(text, jsonb) to anon;

-- Part 3: run the job every 5 hours (00:00, 05:00, 10:00, 15:00, 20:00 UTC)
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('forecast-every-5h', '0 */5 * * *', $$select net.http_get(url := 'https://crypto-backtester-au.vercel.app/api/forecast-cron?key=KTAm6_i7DXtgs0oYM447qi9HIy2TNGnA', timeout_milliseconds := 120000)$$);
