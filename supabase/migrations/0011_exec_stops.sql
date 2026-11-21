-- 0011_exec_stops
-- The stop watchdog: every real buy remembers its stop-loss (in US$, the price the labs use), and
-- a small function lists the real positions that are still open, so the one-minute check doesn't
-- have to download the whole order log. Run AFTER 0010. Plain SQL, no placeholders.

alter table exec_orders add column if not exists stop_usd numeric;
alter table exec_orders add column if not exists exit_by timestamptz;

-- same as 0010's exec_put, plus stop_usd and exit_by
create or replace function exec_put(secret text, row_data jsonb, allow_update boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare k text := row_data->>'idem_key';
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  if exists (select 1 from exec_orders where idem_key = k) then
    if not allow_update then return 'duplicate'; end if;
    update exec_orders set
      status = coalesce(row_data->>'status', status),
      reason = coalesce(row_data->>'reason', reason),
      quote_rate = coalesce((row_data->>'quote_rate')::numeric, quote_rate),
      filled_rate = coalesce((row_data->>'filled_rate')::numeric, filled_rate),
      filled_amount = coalesce((row_data->>'filled_amount')::numeric, filled_amount),
      fee_aud = coalesce((row_data->>'fee_aud')::numeric, fee_aud),
      requested_amount = coalesce((row_data->>'requested_amount')::numeric, requested_amount),
      requested_aud = coalesce((row_data->>'requested_aud')::numeric, requested_aud),
      stop_usd = coalesce((row_data->>'stop_usd')::numeric, stop_usd),
      exit_by = coalesce((row_data->>'exit_by')::timestamptz, exit_by),
      raw = coalesce(row_data->'raw', raw),
      external_id = coalesce(row_data->>'external_id', external_id),
      updated_at = now()
    where idem_key = k;
    return 'updated';
  end if;
  insert into exec_orders (idem_key, owner, mode, venue, source, side, asset, market, requested_aud, requested_amount, signal_price,
    quote_rate, filled_rate, filled_amount, fee_aud, status, reason, raw, parent_idem, external_id, stop_usd, exit_by)
  values (k, coalesce(row_data->>'owner', 'john'), row_data->>'mode', row_data->>'venue', row_data->>'source', row_data->>'side', row_data->>'asset', row_data->>'market',
    (row_data->>'requested_aud')::numeric, (row_data->>'requested_amount')::numeric, (row_data->>'signal_price')::numeric,
    (row_data->>'quote_rate')::numeric, (row_data->>'filled_rate')::numeric, (row_data->>'filled_amount')::numeric,
    (row_data->>'fee_aud')::numeric, row_data->>'status', row_data->>'reason', row_data->'raw', row_data->>'parent_idem', row_data->>'external_id',
    (row_data->>'stop_usd')::numeric, (row_data->>'exit_by')::timestamptz);
  return 'inserted';
end $$;

-- real CoinSpot buys still held (no completed sell yet), with their stop, plus each owner's kill switch
create or replace function exec_open(secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'open', coalesce((select jsonb_agg(jsonb_build_object(
        'idem_key', b.idem_key, 'owner', b.owner, 'asset', b.asset, 'filled_amount', b.filled_amount, 'filled_rate', b.filled_rate,
        'stop_usd', b.stop_usd, 'exit_by', b.exit_by, 'created_at', b.created_at, 'source', b.source,
        'sell_status', (select s.status from exec_orders s where s.parent_idem = b.idem_key and s.side = 'SELL' order by s.updated_at desc limit 1),
        'sell_updated', (select s.updated_at from exec_orders s where s.parent_idem = b.idem_key and s.side = 'SELL' order by s.updated_at desc limit 1)))
      from exec_orders b
      where b.venue = 'coinspot' and b.side = 'BUY' and b.mode = 'live' and b.status = 'filled' and b.stop_usd is not null
        and b.created_at > now() - interval '30 days'
        and not exists (select 1 from exec_orders s where s.parent_idem = b.idem_key and s.side = 'SELL' and s.status in ('filled', 'submitted'))), '[]'::jsonb),
    'kill', coalesce((select jsonb_object_agg(owner, kill_switch) from exec_settings), '{}'::jsonb));
end $$;

grant execute on function exec_put(text, jsonb, boolean) to anon;
grant execute on function exec_open(text) to anon;
