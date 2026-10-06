-- 同姓同名でも住所が異なれば登録できます。既存レコードは変更しません。
begin;

create or replace function public.flexcon_check_authorization_name_duplicate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and public.flexcon_normalize_authorization_name(new.full_name)
         = public.flexcon_normalize_authorization_name(old.full_name)
     and public.flexcon_normalize_authorization_name(new.address)
         = public.flexcon_normalize_authorization_name(old.address) then
    return new;
  end if;

  if exists (
    select 1
    from public.flexcon_authorizations as auth_record
    where auth_record.id <> new.id
      and public.flexcon_normalize_authorization_name(auth_record.full_name)
          = public.flexcon_normalize_authorization_name(new.full_name)
      and public.flexcon_normalize_authorization_name(auth_record.address)
          = public.flexcon_normalize_authorization_name(new.address)
  ) then
    raise exception '氏名「%」と住所が同じ委任状はすでに登録されています。', btrim(new.full_name);
  end if;

  return new;
end;
$$;

drop trigger if exists flexcon_authorizations_name_duplicate_check on public.flexcon_authorizations;
create trigger flexcon_authorizations_name_duplicate_check
before insert or update of full_name, address on public.flexcon_authorizations
for each row execute function public.flexcon_check_authorization_name_duplicate();

revoke all on function public.flexcon_check_authorization_name_duplicate() from public;
commit;
