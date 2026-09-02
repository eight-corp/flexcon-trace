-- 委任状氏名を空白の違いを無視して重複チェックします。
-- 既存データの別項目更新は妨げず、氏名の新規登録・変更時に確認します。

create or replace function public.flexcon_normalize_authorization_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]　]+', '', 'g'));
$$;

create or replace function public.flexcon_check_authorization_name_duplicate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and public.flexcon_normalize_authorization_name(new.full_name)
         = public.flexcon_normalize_authorization_name(old.full_name) then
    return new;
  end if;

  if exists (
    select 1
    from public.flexcon_authorizations as authorization
    where authorization.id <> new.id
      and public.flexcon_normalize_authorization_name(authorization.full_name)
          = public.flexcon_normalize_authorization_name(new.full_name)
  ) then
    raise exception '氏名「%」はすでに登録されています。', btrim(new.full_name);
  end if;

  return new;
end;
$$;

drop trigger if exists flexcon_authorizations_name_duplicate_check
  on public.flexcon_authorizations;

create trigger flexcon_authorizations_name_duplicate_check
before insert or update of full_name on public.flexcon_authorizations
for each row
execute function public.flexcon_check_authorization_name_duplicate();

revoke all on function public.flexcon_normalize_authorization_name(text) from public;
revoke all on function public.flexcon_check_authorization_name_duplicate() from public;
