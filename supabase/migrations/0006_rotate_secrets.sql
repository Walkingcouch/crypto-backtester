-- Rotates the write secret and cron key after they appeared in the public repo
-- (migrations 0002-0005). This committed file holds PLACEHOLDERS only: the filled
-- version (real values) is pasted into the SQL editor and never committed.
-- WRITE_SECRET must equal Vercel env FORECAST_SECRET; CRON_KEY must equal CRON_SECRET.

create or replace function public.log_forecasts(secret text, rows jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if secret is distinct from 'WRITE_SECRET' then raise exception 'denied'; end if;
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
  if secret is distinct from 'WRITE_SECRET' then raise exception 'denied'; end if;
  update public.forecasts f set outcome = x.outcome, graded_at = now()
  from jsonb_to_recordset(rows) as x(symbol text, horizon int, made_at timestamptz, outcome float8)
  where f.symbol = x.symbol and f.horizon = x.horizon and f.made_at = x.made_at and f.outcome is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.track_coin(secret text, symbol text, name text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if secret is distinct from 'WRITE_SECRET' then raise exception 'denied'; end if;
  if symbol !~ '^[A-Z0-9]{2,15}USDT$' then raise exception 'bad symbol'; end if;
  if exists (select 1 from public.tracked_coins t where t.symbol = track_coin.symbol) then return 'already'; end if;
  if (select count(*) from public.tracked_coins) >= 50 then return 'full'; end if;
  insert into public.tracked_coins (symbol, name) values (track_coin.symbol, left(track_coin.name, 40));
  return 'added';
end $$;

create or replace function public.lab_put(secret text, sid text, payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
begin
  if secret is distinct from 'WRITE_SECRET' then raise exception 'denied'; end if;
  insert into lab_state (id, data, updated_at) values (sid, payload, now())
  on conflict (id) do update set data = excluded.data, updated_at = now();
  return 'ok';
end $$;

-- The key moves out of the URL and into a header, and both jobs run every 2 hours.
select cron.unschedule('forecast-every-5h');
select cron.unschedule('lab-every-5h');
select cron.schedule('forecast-every-2h', '30 */2 * * *', $$select net.http_get(url := 'https://crypto-backtester-au.vercel.app/api/forecast-cron', headers := '{"Authorization": "Bearer CRON_KEY"}'::jsonb, timeout_milliseconds := 120000)$$);
select cron.schedule('lab-every-2h', '45 */2 * * *', $$select net.http_get(url := 'https://crypto-backtester-au.vercel.app/api/lab-cron', headers := '{"Authorization": "Bearer CRON_KEY"}'::jsonb, timeout_milliseconds := 120000)$$);
