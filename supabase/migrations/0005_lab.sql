-- The Lab: one saved state for the paper-trading loop, written only by the server job.
create table if not exists lab_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table lab_state enable row level security;
drop policy if exists lab_read on lab_state;
create policy lab_read on lab_state for select using (true);

create or replace function lab_put(secret text, sid text, payload jsonb)
returns text language plpgsql security definer set search_path = public as $$
begin
  if secret <> 'yP6UcfEB0Sp1aKCR4fI9Z2DubyZc1eTS' then
    raise exception 'not allowed';
  end if;
  insert into lab_state (id, data, updated_at) values (sid, payload, now())
  on conflict (id) do update set data = excluded.data, updated_at = now();
  return 'ok';
end $$;
grant execute on function lab_put(text, text, jsonb) to anon;

-- run 15 minutes after the forecast job, every 5 hours
select cron.schedule('lab-every-5h', '15 */5 * * *', $$select net.http_get(url := 'https://crypto-backtester-au.vercel.app/api/lab-cron?key=KTAm6_i7DXtgs0oYM447qi9HIy2TNGnA', timeout_milliseconds := 120000)$$);
