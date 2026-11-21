-- 0012_fix_cron_keys
-- The hourly Day trading lab and the 2-hourly Crypto Explorer stopped saving at about 3:35pm on
-- 21 Nov: their scheduled calls still carry the old cron key, while the Swing lab's job has the
-- current one. This copies the working job's command (and so its key) onto those two jobs.
-- No secret to paste: run as-is.

-- 1. before: what the last scheduled calls got back (401 = wrong key)
select created, status_code, left(content, 60) as reply
from net._http_response order by created desc limit 12;

-- 2. give both jobs the Swing lab job's (working) command, pointed at their own page and timeout
select cron.alter_job(
  (select jobid from cron.job where jobname = 'daytrade-hourly'),
  command := (select replace(replace(command, '/api/lab-cron', '/api/daytrade-cron'), '120000', '300000') from cron.job where jobname = 'lab-every-2h'));

select cron.alter_job(
  (select jobid from cron.job where jobname = 'explorer-every-2h'),
  command := (select replace(replace(command, '/api/lab-cron', '/api/explorer-cron'), '120000', '300000') from cron.job where jobname = 'lab-every-2h'));

-- 3. after: all jobs and their targets (the key itself is hidden)
select jobname, schedule, active, regexp_replace(command, 'Bearer [^"]+', 'Bearer …') as command
from cron.job order by jobname;
