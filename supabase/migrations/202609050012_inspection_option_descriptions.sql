-- 等級と等級の理由に、任意の説明文を登録できるようにします。
begin;

alter table public.flexcon_inspection_options
  add column if not exists description text;

alter table public.flexcon_inspection_options
  drop constraint if exists flexcon_inspection_options_description_length_check;

alter table public.flexcon_inspection_options
  add constraint flexcon_inspection_options_description_length_check
  check (description is null or char_length(description) <= 1000);

drop function if exists public.flexcon_save_inspection_option(text, uuid, text, text);

create or replace function public.flexcon_save_inspection_option(
  p_worker_id text,
  p_option_id uuid,
  p_option_type text,
  p_name text,
  p_description text default null
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
  v_description text;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  v_name := btrim(coalesce(p_name, ''));
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  if p_option_type not in (
    'location',
    'inspector',
    'brand_aomori',
    'brand_iwate',
    'grade',
    'grade_reason',
    'shipment_product'
  ) then
    raise exception 'マスタ項目の種類が正しくありません。';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception '名称を1文字から120文字で入力してください。';
  end if;
  if v_description is not null and char_length(v_description) > 1000 then
    raise exception '説明文は1000文字以内で入力してください。';
  end if;
  if p_option_type not in ('grade', 'grade_reason') and v_description is not null then
    raise exception '説明文を登録できるのは等級と等級の理由だけです。';
  end if;
  if exists (
    select 1
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = p_option_type
      and lower(btrim(inspection_option.name)) = lower(v_name)
      and (p_option_id is null or inspection_option.id <> p_option_id)
  ) then
    raise exception '同じ名称がすでに登録されています。';
  end if;

  if p_option_id is null then
    insert into public.flexcon_inspection_options (
      option_type,
      name,
      description,
      created_by_worker_id,
      updated_by_worker_id
    ) values (
      p_option_type,
      v_name,
      v_description,
      v_worker.worker_id,
      v_worker.worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_options
    set name = v_name,
        description = v_description,
        updated_by_worker_id = v_worker.worker_id,
        updated_at = now()
    where id = p_option_id
      and option_type = p_option_type
    returning id into v_id;

    if v_id is null then
      raise exception 'マスタ項目が見つかりません。';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.flexcon_save_inspection_option(text, uuid, text, text, text) from public;
grant execute on function public.flexcon_save_inspection_option(text, uuid, text, text, text) to anon, authenticated;

commit;
