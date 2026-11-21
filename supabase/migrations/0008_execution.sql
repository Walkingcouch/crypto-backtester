-- Real-money execution: guardrail settings and a full audit trail of every trade intent,
-- guardrail rejection, fill and manual share order.
--
-- BEFORE RUNNING: replace <<FORECAST_SECRET>> (three places) with the same value as the
-- FORECAST_SECRET environment variable in Vercel (the secret the server already uses for lab_put).
--
-- Nothing here is readable by the public website: both tables have row-level security with no
-- public policies, and every read or write goes through the secret-checked functions below,
-- which only the server knows how to call.

create table if not exists exec_settings (
  id int primary key default 1 check (id = 1),
  kill_switch boolean not null default false,          -- true = no orders at all
  max_order_aud numeric not null default 25,           -- hard cap per order
  max_daily_spend_aud numeric not null default 100,    -- rolling 24 h cap on buys
  min_wallet_buffer_aud numeric not null default 50,   -- AUD always left in the wallet
  max_slippage_pct numeric not null default 1.0,       -- reject if the live quote is this far off the signal
  max_signal_age_min int not null default 90,          -- don't act on stale signals after downtime
  crypto_source_lab text not null default 'daytrade',  -- which paper lab's trades to mirror
  crypto_source_account text not null default 'john',  -- …and which of its accounts (CoinSpot)
  require_proven boolean not null default true,        -- live: only mirror rules that passed every check
  share_source_lab text not null default 'stocks',     -- share lab whose trades go to the Superhero queue
  share_order_aud numeric not null default 500,        -- suggested AUD per share order
  share_fee_aud numeric not null default 2,            -- Superhero brokerage per order
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into exec_settings (id) values (1) on conflict (id) do nothing;

create table if not exists exec_orders (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  idem_key text not null unique,                       -- one row per signal and side: retries can't double-order
  mode text not null check (mode in ('paper', 'live')),
  venue text not null check (venue in ('coinspot', 'superhero')),
  source text,                                         -- e.g. 'daytrade/john v6 rev:2:4:tf0'
  side text not null check (side in ('BUY', 'SELL')),
  asset text not null,
  market text not null,                                -- CRYPTO, US, ASX
  requested_aud numeric,
  requested_amount numeric,                            -- coins or shares
  signal_price numeric,                                -- AUD price the signal saw
  quote_rate numeric,
  filled_rate numeric,
  filled_amount numeric,
  fee_aud numeric,
  status text not null,                                -- intent, rejected, paper_filled, submitted, filled, failed, pending_manual, executed_manual, dismissed
  reason text,                                         -- why it was rejected or failed (plain words)
  raw jsonb,                                           -- the exchange's raw response or error
  parent_idem text,                                    -- a sell points at the buy it closes
  external_id text
);
create index if not exists exec_orders_created on exec_orders (created_at desc);
create index if not exists exec_orders_status on exec_orders (status);

alter table exec_settings enable row level security;
alter table exec_orders enable row level security;

-- Insert a new row, or update an existing one by idem_key. Returns 'inserted', 'updated' or 'duplicate'
-- (an insert whose key already exists: the caller must treat that signal as already handled).
create or replace function exec_put(secret text, row_data jsonb, allow_update boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare k text := row_data->>'idem_key';
begin
  if secret <> '<<FORECAST_SECRET>>' then raise exception 'not allowed'; end if;
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

-- Settings and recent orders in one call.
create or replace function exec_get(secret text, since timestamptz default now() - interval '30 days', max_rows int default 500)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if secret <> '<<FORECAST_SECRET>>' then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from exec_settings s where id = 1),
    'orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at desc) from (
      select * from exec_orders where created_at >= since order by created_at desc limit max_rows) o), '[]'::jsonb)
  );
end $$;

-- Change settings (only the keys given). The kill switch is just a setting.
create or replace function exec_settings_set(secret text, patch jsonb, who text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if secret <> '<<FORECAST_SECRET>>' then raise exception 'not allowed'; end if;
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
  return (select to_jsonb(s) from exec_settings s where id = 1);
end $$;

grant execute on function exec_put(text, jsonb, boolean) to anon;
grant execute on function exec_get(text, timestamptz, int) to anon;
grant execute on function exec_settings_set(text, jsonb, text) to anon;
