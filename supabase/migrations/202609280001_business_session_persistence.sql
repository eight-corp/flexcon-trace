begin;

-- Normal sessions use a rolling 30-day expiry. Bootstrap sessions stay short-lived.
create or replace function business_private.keep_session_on_login()
returns trigger language plpgsql
set search_path = pg_catalog
as $$
begin
  if not new.bootstrap then
    new.expires_at := now() + interval '30 days';
  end if;
  return new;
end;
$$;
revoke all on function business_private.keep_session_on_login() from public, anon, authenticated;
drop trigger if exists business_session_login_expiry on business_private.sessions;
create trigger business_session_login_expiry
before insert on business_private.sessions
for each row execute function business_private.keep_session_on_login();

create or replace function business_private.actor(p_bootstrap boolean default false)
returns text language plpgsql security definer
set search_path = pg_catalog, business_private, extensions
as $$
declare v_token text; v_hash text; v_actor text;
begin
  v_token := coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'x-business-session', '');
  if length(v_token) <> 64 then return null; end if;
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  select s.worker_id into v_actor
  from business_private.sessions s
  join business_private.users u using (worker_id)
  join public.workers w using (worker_id)
  where s.token_hash = v_hash and s.expires_at > now()
    and s.bootstrap = p_bootstrap and u.enabled;
  if v_actor is not null and not p_bootstrap then
    -- Throttle writes; authorization and user status are checked on every request.
    update business_private.sessions
    set expires_at = now() + interval '30 days'
    where token_hash = v_hash and not bootstrap and expires_at > now()
      and expires_at < now() + interval '29 days';
  end if;
  return v_actor;
end;
$$;
revoke all on function business_private.actor(boolean) from public, anon, authenticated;

-- Extend only sessions that are still valid; never revive expired or revoked ones.
update business_private.sessions s
set expires_at = greatest(s.expires_at, now() + interval '30 days')
from business_private.users u
where u.worker_id = s.worker_id and u.enabled and not s.bootstrap and s.expires_at > now();

notify pgrst, 'reload schema';
commit;
