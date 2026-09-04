-- 紙袋の1行を、合計数量を変えずに2行へ分割できるようにします。
-- 202609040006_flat_producer_inspections.sql の実行後に適用してください。

begin;

create or replace function public.flexcon_split_inspection_paper_bags(
  p_worker_id text,
  p_paper_bag_id uuid,
  p_first_bag_count integer,
  p_second_bag_count integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.flexcon_inspection_paper_bags%rowtype;
  v_new_id uuid;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  select *
  into v_source
  from public.flexcon_inspection_paper_bags
  where id = p_paper_bag_id
  for update;

  if v_source.id is null then
    raise exception '分割する紙袋検査記録が見つかりません。';
  end if;
  if p_first_bag_count is null or p_first_bag_count <= 0
     or p_second_bag_count is null or p_second_bag_count <= 0 then
    raise exception '分割後の袋数はどちらも1以上で入力してください。';
  end if;
  if p_first_bag_count + p_second_bag_count <> v_source.bag_count then
    raise exception '分割後の合計を元の袋数に合わせてください。';
  end if;

  update public.flexcon_inspection_paper_bags
  set bag_count = p_first_bag_count,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id = v_source.id;

  insert into public.flexcon_inspection_paper_bags (
    authorization_id,
    fiscal_year,
    purchase_date,
    inspection_date,
    inspection_location,
    brand,
    bag_count,
    grade,
    reason,
    moisture,
    moisture_values,
    created_by_worker_id,
    updated_by_worker_id
  ) values (
    v_source.authorization_id,
    v_source.fiscal_year,
    v_source.purchase_date,
    v_source.inspection_date,
    v_source.inspection_location,
    v_source.brand,
    p_second_bag_count,
    v_source.grade,
    v_source.reason,
    v_source.moisture,
    v_source.moisture_values,
    p_worker_id,
    p_worker_id
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.flexcon_split_inspection_paper_bags(text, uuid, integer, integer) from public;
grant execute on function public.flexcon_split_inspection_paper_bags(text, uuid, integer, integer) to anon, authenticated;

commit;
