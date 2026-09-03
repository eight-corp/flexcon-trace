-- 検査場所・銘柄の表示順を保存し、上下に並べ替えられるようにします。
-- 202609030002_inspection_options.sql の実行後に適用してください。

alter table public.flexcon_inspection_options
  add column if not exists sort_order integer not null default 0;

with ordered_options as (
  select
    id,
    row_number() over (
      partition by option_type
      order by name, created_at, id
    ) as new_sort_order
  from public.flexcon_inspection_options
)
update public.flexcon_inspection_options as inspection_option
set sort_order = ordered_options.new_sort_order
from ordered_options
where inspection_option.id = ordered_options.id
  and inspection_option.sort_order = 0;

create index if not exists flexcon_inspection_options_order_idx
  on public.flexcon_inspection_options (option_type, sort_order, name);

create or replace function public.flexcon_assign_inspection_option_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.sort_order <= 0 then
    select coalesce(max(inspection_option.sort_order), 0) + 1
    into new.sort_order
    from public.flexcon_inspection_options as inspection_option
    where inspection_option.option_type = new.option_type;
  end if;

  return new;
end;
$$;

drop trigger if exists flexcon_assign_inspection_option_order
  on public.flexcon_inspection_options;

create trigger flexcon_assign_inspection_option_order
before insert on public.flexcon_inspection_options
for each row
execute function public.flexcon_assign_inspection_option_order();

create or replace function public.flexcon_reorder_inspection_option(
  p_worker_id text,
  p_option_id uuid,
  p_direction integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.flexcon_inspection_options%rowtype;
  v_adjacent public.flexcon_inspection_options%rowtype;
begin
  perform public.flexcon_require_active_worker(p_worker_id);

  if p_direction not in (-1, 1) then
    raise exception '移動方向が正しくありません。';
  end if;

  select *
  into v_current
  from public.flexcon_inspection_options
  where id = p_option_id
  for update;

  if v_current.id is null then
    raise exception '検査項目が見つかりません。';
  end if;

  if p_direction = -1 then
    select *
    into v_adjacent
    from public.flexcon_inspection_options
    where option_type = v_current.option_type
      and sort_order < v_current.sort_order
    order by sort_order desc, name desc
    limit 1
    for update;
  else
    select *
    into v_adjacent
    from public.flexcon_inspection_options
    where option_type = v_current.option_type
      and sort_order > v_current.sort_order
    order by sort_order, name
    limit 1
    for update;
  end if;

  if v_adjacent.id is null then
    return;
  end if;

  update public.flexcon_inspection_options
  set sort_order = case
        when id = v_current.id then v_adjacent.sort_order
        else v_current.sort_order
      end,
      updated_by_worker_id = p_worker_id,
      updated_at = now()
  where id in (v_current.id, v_adjacent.id);
end;
$$;

revoke all on function public.flexcon_assign_inspection_option_order()
  from public;
revoke all on function public.flexcon_reorder_inspection_option(text, uuid, integer)
  from public;

grant execute on function public.flexcon_reorder_inspection_option(text, uuid, integer)
  to anon, authenticated;
