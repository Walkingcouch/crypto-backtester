-- Profiles, saved runs and the append-only "unseen test" ledger.
-- Everything is readable by any signed-in member so partners share one honest record.
-- Reveals can never be edited or deleted (that's the point of a ledger).

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(coalesce(new.email, ''), '@', 1));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

create table public.test_reveals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  strategy_id text not null,
  strategy_version int not null,
  params jsonb not null,
  period_key text not null,
  symbol text not null,
  interval text not null,
  test_from text not null,
  test_to text not null,
  fee double precision not null,
  sharpe double precision not null,
  total_return double precision not null,
  max_drawdown double precision not null,
  bh_return double precision not null
);
create index on public.test_reveals (period_key, strategy_id);
create index on public.test_reveals (user_id);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  strategy_id text not null,
  symbol text not null,
  interval text not null,
  settings jsonb not null,
  params jsonb not null,
  train_metrics jsonb not null,
  test_metrics jsonb
);
create index on public.runs (user_id);

alter table public.profiles enable row level security;
alter table public.test_reveals enable row level security;
alter table public.runs enable row level security;

create policy "members read profiles" on public.profiles for select to authenticated using (true);
create policy "update own profile" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "members read ledger" on public.test_reveals for select to authenticated using (true);
create policy "append own reveal" on public.test_reveals for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "members read runs" on public.runs for select to authenticated using (true);
create policy "insert own run" on public.runs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "delete own run" on public.runs for delete to authenticated
  using ((select auth.uid()) = user_id);

create view public.test_reveals_view with (security_invoker = on) as
  select r.*, p.display_name as author from public.test_reveals r
  left join public.profiles p on p.id = r.user_id;

create view public.runs_view with (security_invoker = on) as
  select r.*, p.display_name as author from public.runs r
  left join public.profiles p on p.id = r.user_id;

grant select on public.test_reveals_view, public.runs_view to authenticated;
