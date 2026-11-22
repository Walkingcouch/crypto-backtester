-- 0013_connections
-- Exchange (CEX) API keys and DEX wallets added from the website's Connections page.
-- Secrets arrive here already ENCRYPTED by the server (AES-256-GCM with CONNECTIONS_KEY, which lives
-- only in Vercel and never in this database), so a copy of this database alone can't reveal them.
-- Only the server can read or write this table (secret-checked functions, like the order log).
-- Also lets each person switch their bot between paper and live from the site.
-- Run AFTER 0010 and 0011. Plain SQL, no placeholders.

create table if not exists exec_connections (
  id bigserial primary key,
  owner text not null check (owner ~ '^[a-z0-9]{1,20}$'),
  venue text not null check (venue ~ '^[a-z0-9_-]{1,30}$'),       -- coinspot, binance, kraken, coinbase, solana, base, ethereum…
  kind text not null check (kind in ('cex', 'dex')),
  label text,
  public_info jsonb not null default '{}'::jsonb,                  -- safe to show: key hint (last 4), wallet address, permissions found
  cipher text not null,                                            -- encrypted secrets (base64), never sent to the browser
  status text not null default 'untested',
  last_test jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (owner, venue)
);
alter table exec_connections enable row level security;           -- no policies: the public API can't touch it

alter table exec_settings add column if not exists execution_mode text check (execution_mode in ('paper', 'live'));

create or replace function conn_list(secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('owner', owner, 'venue', venue, 'kind', kind, 'label', label, 'public_info', public_info,
    'status', status, 'last_test', last_test, 'created_at', created_at, 'updated_at', updated_at, 'updated_by', updated_by) order by owner, venue)
    from exec_connections), '[]'::jsonb);
end $$;

-- the encrypted secrets of one owner's connections, and their paper/live choice (server only)
create or replace function conn_get(secret text, who_owner text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'venues', coalesce((select jsonb_object_agg(venue, jsonb_build_object('kind', kind, 'cipher', cipher, 'public_info', public_info, 'status', status))
      from exec_connections where owner = who_owner), '{}'::jsonb),
    'mode', (select execution_mode from exec_settings where owner = who_owner));
end $$;

create or replace function conn_put(secret text, row_data jsonb, who text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  insert into exec_connections (owner, venue, kind, label, public_info, cipher, status, last_test, updated_by)
  values (row_data->>'owner', row_data->>'venue', row_data->>'kind', row_data->>'label', coalesce(row_data->'public_info', '{}'::jsonb),
          row_data->>'cipher', coalesce(row_data->>'status', 'untested'), row_data->'last_test', who)
  on conflict (owner, venue) do update set
    kind = excluded.kind, label = excluded.label, public_info = excluded.public_info, cipher = excluded.cipher,
    status = excluded.status, last_test = excluded.last_test, updated_at = now(), updated_by = who;
  return 'saved';
end $$;

create or replace function conn_status(secret text, who_owner text, v text, new_status text, test jsonb)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  update exec_connections set status = new_status, last_test = test, updated_at = now() where owner = who_owner and venue = v;
  return 'ok';
end $$;

create or replace function conn_delete(secret text, who_owner text, v text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not exec_secret_ok(secret) then raise exception 'not allowed'; end if;
  delete from exec_connections where owner = who_owner and venue = v;
  return 'deleted';
end $$;

-- 0010's settings function, plus execution_mode
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
    execution_mode = coalesce(patch->>'execution_mode', execution_mode),
    updated_at = now(), updated_by = who
  where owner = who_owner;
  return (select to_jsonb(st) from exec_settings st where owner = who_owner);
end $$;

revoke all on function conn_list(text) from public;
revoke all on function conn_get(text, text) from public;
revoke all on function conn_put(text, jsonb, text) from public;
revoke all on function conn_status(text, text, text, text, jsonb) from public;
revoke all on function conn_delete(text, text, text) from public;
grant execute on function conn_list(text) to anon;
grant execute on function conn_get(text, text) to anon;
grant execute on function conn_put(text, jsonb, text) to anon;
grant execute on function conn_status(text, text, text, text, jsonb) to anon;
grant execute on function conn_delete(text, text, text) to anon;
grant execute on function exec_settings_set_for(text, text, jsonb, text) to anon;
