-- 0010_exec_per_user
-- One automation account per person: each owner ('john', 'mark', …) gets their own guardrail
-- settings row and their own orders. Existing settings and orders become John's.
-- Plain SQL, no placeholders: run as-is.

-- settings: one row per owner (the old single-row rule goes)
alter table exec_settings drop constraint if exists exec_settings_id_check;
alter table exec_settings add column if not exists owner text;
update exec_settings set owner = 'john' where owner is null;
alter table exec_settings alter column owner set not null;
create unique index if not exists exec_settings_owner on exec_settings (owner);
create sequence if not exists exec_settings_id_seq start 2;
alter table exec_settings alter column id set default nextval('exec_settings_id_seq');

-- orders: tagged with their owner
alter table exec_orders add column if not exists owner text not null default 'john';
create index if not exists exec_orders_owner on exec_orders (owner, created_at desc);

-- write an order row (owner taken from the row, default john)
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
      raw = coalesce(row_data->'raw', raw),
      external_id = coalesce(row_data->>'external_id', external_id),
      updated_at = now()
    where idem_key = k;
    return 'updated';
  end if;
  insert into exec_orders (idem_key, owner, mode, venue, source, side, asset, market, requested_aud, requested_amount, signal_price,
    quote_rate, filled_rate, filled_amount, fee_aud, status, reason, raw, parent_idem, external_id)
  values (k, coalesce(row_data->>'owner', 'john'), row_data->>'mode', row_data->>'venue', row_data->>'source', row_data->>'side', row_data->>'asset', row_data->>'market',
    (row_data->>'requested_aud')::numeric, (row_data->>'requested_amount')::numeric, (row_data->>'signal_price')::numeric,
    (row_data->>'quote_rate')::numeric, (row_data->>'filled_rate')::numeric, (row_data->>'filled_amount')::numeric,
    (row_data->>'fee_aud')::numeric, row_data->>'status', row_data->>'reason', row_data->'raw', row_data->>'parent_idem', row_data->>'external_id');
  return 'inserted';
end $$;

-- everyone's settings and recent orders in one call (each person can see the others)
create or replace function exec_get_all(secret text, since timestamptz default now() - interval '30 days', max_rows int default 2000)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'settings', coalesce((select jsonb_agg(to_jsonb(st) order by st.id) from exec_settings st), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at desc) from (
      select * from exec_orders where created_at >= since order by created_at desc limit max_rows) o), '[]'::jsonb)
  );
end $$;

-- change one owner's settings (creates their row with the defaults the first time)
create or replace function exec_settings_set_for(secret text, who_owner text, patch jsonb, who text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  if who_owner is null or who_owner !~ '^[a-z0-9]{1,20}$' then raise exception 'bad owner'; end if;
  insert into exec_settings (owner) values (who_owner) on conflict (owner) do nothing;
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
  where owner = who_owner;
  return (select to_jsonb(st) from exec_settings st where owner = who_owner);
end $$;

grant execute on function exec_put(text, jsonb, boolean) to anon;
grant execute on function exec_get_all(text, timestamptz, int) to anon;
grant execute on function exec_settings_set_for(text, text, jsonb, text) to anon;
