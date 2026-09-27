begin;
do $$
declare
  v_worker text;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash text;
begin
  select worker_id into v_worker from business_private.users where enabled limit 1;
  if v_worker is null then raise exception 'test requires an enabled worker'; end if;
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  insert into business_private.sessions values (v_hash, v_worker, now() + interval '12 hours', false);
  if not exists (select 1 from business_private.sessions where token_hash = v_hash and expires_at >= now() + interval '30 days') then
    raise exception 'login expiry failed';
  end if;
  update business_private.sessions set expires_at = now() + interval '1 hour' where token_hash = v_hash;
  perform set_config('request.headers', jsonb_build_object('x-business-session', v_token)::text, true);
  if business_private.actor() is distinct from v_worker then raise exception 'actor failed'; end if;
  if not exists (select 1 from business_private.sessions where token_hash = v_hash and expires_at >= now() + interval '30 days') then
    raise exception 'renewal failed';
  end if;
  update business_private.sessions set expires_at = now() - interval '1 minute' where token_hash = v_hash;
  if business_private.actor() is not null then raise exception 'expired session accepted'; end if;
  delete from business_private.sessions where token_hash = v_hash;
  if business_private.actor() is not null then raise exception 'revoked session accepted'; end if;
  insert into business_private.sessions values (v_hash, v_worker, now() + interval '15 minutes', true);
  if business_private.actor(true) is distinct from v_worker then raise exception 'bootstrap failed'; end if;
  if exists (select 1 from business_private.sessions where token_hash = v_hash and expires_at > now() + interval '16 minutes') then
    raise exception 'bootstrap extended';
  end if;
end;
$$;
rollback;
