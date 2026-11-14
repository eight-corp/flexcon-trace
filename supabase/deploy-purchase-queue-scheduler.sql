begin;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
do $$ begin
  if not exists(select 1 from flexcon_queue_private.settings where gateway_key<>'') then
    raise exception 'Configure the existing public anon JWT for the queue gateway before enabling cron.';
  end if;
end; $$;
-- The secret stays in a private table; cron history contains neither secrets nor image data.
select cron.schedule('flexcon-purchase-statement-queue','* * * * *','select flexcon_queue_private.dispatch();');
commit;
