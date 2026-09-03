-- 検査項目に等級マスターを追加します。
-- 202609030005_prefecture_inspection_brands.sql の実行後に適用してください。

alter table public.flexcon_inspection_options
  drop constraint if exists flexcon_inspection_options_option_type_check;

alter table public.flexcon_inspection_options
  add constraint flexcon_inspection_options_option_type_check
  check (
    option_type in (
      'location',
      'brand_aomori',
      'brand_iwate',
      'grade'
    )
  );

insert into public.flexcon_inspection_options (
  option_type,
  name
)
values
  ('grade', '1等'),
  ('grade', '2等'),
  ('grade', '3等'),
  ('grade', '合格')
on conflict (option_type, name) do nothing;

create or replace function public.flexcon_save_inspection_option(
  p_worker_id text,
  p_option_id uuid,
  p_option_type text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
  v_id uuid;
  v_name text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_name := btrim(coalesce(p_name, ''));

  if p_option_type not in (
    'location',
    'brand_aomori',
    'brand_iwate',
    'grade'
  ) then
    raise exception '検査項目の種類が正しくありません。';
  end if;

  if char_length(v_name) not between 1 and 120 then
    raise exception '名称を1文字から120文字で入力してください。';
  end if;

  if exists (
    select 1
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = p_option_type
      and lower(btrim(inspection_option.name)) = lower(v_name)
      and (
        p_option_id is null
        or inspection_option.id <> p_option_id
      )
  ) then
    raise exception '同じ名称がすでに登録されています。';
  end if;

  if p_option_id is null then
    insert into public.flexcon_inspection_options (
      option_type,
      name,
      created_by_worker_id,
      updated_by_worker_id
    )
    values (
      p_option_type,
      v_name,
      v_worker.worker_id,
      v_worker.worker_id
    )
    returning id into v_id;
  else
    update public.flexcon_inspection_options
    set
      name = v_name,
      updated_by_worker_id = v_worker.worker_id,
      updated_at = now()
    where id = p_option_id
      and option_type = p_option_type
    returning id into v_id;

    if v_id is null then
      raise exception '検査項目が見つかりません。';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all
on function public.flexcon_save_inspection_option(
  text,
  uuid,
  text,
  text
)
from public;

grant execute
on function public.flexcon_save_inspection_option(
  text,
  uuid,
  text,
  text
)
to anon, authenticated;
