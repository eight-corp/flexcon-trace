-- 仕切書マスタの全項目を編集・並べ替えできるようにします。

begin;

create or replace function public.flexcon_reorder_purchase_statement_master(
  p_worker_id text,
  p_value_type text,
  p_value_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_expected_count integer;
begin
  perform public.flexcon_require_admin_worker(p_worker_id);
  if p_value_type not in ('recipient', 'origin', 'product', 'category') then raise exception 'マスタの種類が不正です。'; end if;

  select count(*) into v_expected_count
  from public.flexcon_purchase_statement_master_values
  where value_type = p_value_type;

  if coalesce(cardinality(p_value_ids), 0) <> v_expected_count
     or (select count(distinct supplied.id) from unnest(coalesce(p_value_ids, '{}'::uuid[])) as supplied(id)) <> v_expected_count
     or exists (
       select 1
       from unnest(coalesce(p_value_ids, '{}'::uuid[])) as supplied(id)
       where not exists (
         select 1 from public.flexcon_purchase_statement_master_values
         where id = supplied.id and value_type = p_value_type
       )
     ) then
    raise exception '並び順の対象が現在のマスタと一致しません。再読込してください。';
  end if;

  update public.flexcon_purchase_statement_master_values as value
  set sort_order = ordered.position,
      updated_at = now()
  from unnest(p_value_ids) with ordinality as ordered(id, position)
  where value.id = ordered.id and value.value_type = p_value_type;
end;
$$;

revoke all on function public.flexcon_reorder_purchase_statement_master(text, text, uuid[]) from public;
grant execute on function public.flexcon_reorder_purchase_statement_master(text, text, uuid[]) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
