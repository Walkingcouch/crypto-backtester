-- 0009_exec_secret_from_lab_put
-- The exec_ functions check the caller's secret against the one already inside lab_put, read live
-- from the database, so there's no secret to paste (and they stay in step if it's ever rotated).
-- No placeholders: run as-is.

create or replace function exec_secret_ok(secret text)
returns boolean language sql stable security definer set search_path = public, pg_catalog as $$
  select secret is not null and secret = (
    select substring(prosrc from 'secret (?:is distinct from|<>) ''([^'']*)''')
    from pg_proc where proname = 'lab_put' limit 1)
$$;
revoke all on function exec_secret_ok(text) from public;
revoke all on function exec_secret_ok(text) from anon;

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
      raw = coalesce(row_data->'raw', raw),
      external_id = coalesce(row_data->>'external_id', external_id),
      updated_at = now()
    where idem_key = k;
    return 'updated';
  end if;
  insert into exec_orders (idem_key, mode, venue, source, side, asset, market, requested_aud, requested_amount, signal_price,
    quote_rate, filled_rate, filled_amount, fee_aud, status, reason, raw, parent_idem, external_id)
  values (k, row_data->>'mode', row_data->>'venue', row_data->>'source', row_data->>'side', row_data->>'asset', row_data->>'market',
    (row_data->>'requested_aud')::numeric, (row_data->>'requested_amount')::numeric, (row_data->>'signal_price')::numeric,
    (row_data->>'quote_rate')::numeric, (row_data->>'filled_rate')::numeric, (row_data->>'filled_amount')::numeric,
    (row_data->>'fee_aud')::numeric, row_data->>'status', row_data->>'reason', row_data->'raw', row_data->>'parent_idem', row_data->>'external_id');
  return 'inserted';
end $$;

create or replace function exec_get(secret text, since timestamptz default now() - interval '30 days', max_rows int default 500)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(st) from exec_settings st where id = 1),
    'orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at desc) from (
      select * from exec_orders where created_at >= since order by created_at desc limit max_rows) o), '[]'::jsonb)
  );
end $$;

create or replace function exec_settings_set(secret text, patch jsonb, who text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  update exec_settings set
    kill_switch = coalesce((patch->>'kill_switch')::boolean, kill_switch),
    max_order_aud = coalesce((patch->>'max_order_aud')::numeric, max_order_aud),
    max_daily_spend_aud = coalesce((patch->>'max_daily_spend_aud')::numeric, max_daily_spend_aud),
    min_wallet_buffer_aud = coalesce((patch->>'min_wallet_buffer_aud')::numeric, min_wallet_buffer_aud),
    max_slippage_pct = coalesce((patch->>'max_slippage_pct')::numeric, max_slippage_pct),
    max_signal_age_min = coalesce((patch->>'max_signal_age_min')::int, max_signal_age_min),
    crypto_source_lab = coalesce(patch->>'crypto_source_lab', crypto_source_lab),
    crypto_source_account = coalesce(patch->>'crypto_source_account', crypto_source_account),
    require_proven = coalesce((patch->>'require_proven')::boolean, require_proven),
    share_source_lab = coalesce(patch->>'share_source_lab', share_source_lab),
    share_order_aud = coalesce((patch->>'share_order_aud')::numeric, share_order_aud),
    share_fee_aud = coalesce((patch->>'share_fee_aud')::numeric, share_fee_aud),
    updated_at = now(), updated_by = who
  where id = 1;
  return (select to_jsonb(st) from exec_settings st where id = 1);
end $$;

grant execute on function exec_put(text, jsonb, boolean) to anon;
grant execute on function exec_get(text, timestamptz, int) to anon;
grant execute on function exec_settings_set(text, jsonb, text) to anon;
