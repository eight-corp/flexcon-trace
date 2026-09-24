begin;

create or replace function public.flexcon_validate_inventory_selection(
  p_origin text,
  p_product_name text,
  p_grade text,
  p_quantity numeric,
  p_unit text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_other_rice boolean;
begin
  if not exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'origin' and active = true and name = p_origin
  ) then raise exception '産地をマスタから選択してください。'; end if;

  select exists (
    select 1 from public.flexcon_inspection_options
    where option_type = 'shipment_product' and active = true and name = p_product_name
  ) into v_is_other_rice;

  if not v_is_other_rice and not exists (
    select 1 from public.flexcon_inspection_options
    where active = true and name = p_product_name
      and ((p_origin = '青森県' and option_type in ('brand', 'brand_aomori'))
        or (p_origin = '岩手県' and option_type = 'brand_iwate'))
  ) then raise exception '名称をマスタから選択してください。'; end if;

  if v_is_other_rice then
    if p_grade <> '' then raise exception '銘柄米以外の種類に等級は入力できません。'; end if;
  elsif p_grade not in ('未検査', '検査前') then
    if not exists (
      select 1 from public.flexcon_inspection_options
      where option_type = 'grade' and active = true and name = p_grade
    ) then raise exception '等級をマスタから選択してください。'; end if;
    if p_product_name = '飼料用玄米' and p_grade <> '合格' then raise exception '飼料用玄米の等級は合格を選択してください。'; end if;
    if p_product_name <> '飼料用玄米' and p_grade = '合格' then raise exception '飼料用玄米以外では合格を選択できません。'; end if;
  end if;

  if p_quantity is null or p_quantity <= 0 then raise exception '量は0より大きい数値で入力してください。'; end if;
  if p_unit not in ('本', '袋', 'kg') then raise exception '単位を本・袋・kgから選択してください。'; end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
