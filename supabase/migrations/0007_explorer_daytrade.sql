-- Schedules for the two new labs (state rows 'explorer' and 'daytrade' in lab_state, written
-- by the same lab_put function). CRON_KEY is a placeholder: the real value is pasted in the
-- SQL editor and never committed.
select cron.schedule('explorer-every-2h', '50 */2 * * *', $$select net.http_get(url := 'https://crypto-backtester-au.vercel.app/api/explorer-cron', headers := '{"Authorization": "Bearer CRON_KEY"}'::jsonb, timeout_milliseconds := 120000)$$);
select cron.schedule('daytrade-hourly', '5 * * * *', $$select net.http_get(url := 'https://crypto-backtester-au.vercel.app/api/daytrade-cron', headers := '{"Authorization": "Bearer CRON_KEY"}'::jsonb, timeout_milliseconds := 300000)$$);
