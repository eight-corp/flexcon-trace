-- 検査項目に量目を追加し、検査記録の総数量を自動計算します。
-- 202609030006_inspection_grades.sql の実行後に適用してください。

create table if not exists public.flexcon_inspection_weights (
  weight_type text primary key
    check (weight_type in ('branded_rice', 'feed_rice')),
  weight_kg integer not null
    check (weight_kg between 1 and 100000),
  updated_by_worker_id text references public.workers(worker_id),
  updated_at timestamptz not null default now()
);

insert into public.flexcon_inspection_weights (
  weight_type,
  weight_kg
)
values
  ('branded_rice', 1020),
  ('feed_rice', 1000)
on conflict (weight_type) do nothing;

alter table public.flexcon_inspection_weights
  enable row level security;

drop policy if exists flexcon_read_inspection_weights
  on public.flexcon_inspection_weights;

create policy flexcon_read_inspection_weights
on public.flexcon_inspection_weights
for select
to anon, authenticated
using (true);

create or replace function public.flexcon_save_inspection_weights(
  p_worker_id text,
  p_branded_rice_weight integer,
  p_feed_rice_weight integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.workers%rowtype;
begin
  v_worker := public.flexcon_require_active_worker(p_worker_id);

  if p_branded_rice_weight is null
     or p_branded_rice_weight <= 0
     or p_feed_rice_weight is null
     or p_feed_rice_weight <= 0 then
    raise exception '量目は1以上の整数で入力してください。';
  end if;

  insert into public.flexcon_inspection_weights (
    weight_type,
    weight_kg,
    updated_by_worker_id,
    updated_at
  )
  values
    (
      'branded_rice',
      p_branded_rice_weight,
      v_worker.worker_id,
      now()
    ),
    (
      'feed_rice',
      p_feed_rice_weight,
      v_worker.worker_id,
      now()
    )
  on conflict (weight_type) do update
  set
    weight_kg = excluded.weight_kg,
    updated_by_worker_id = excluded.updated_by_worker_id,
    updated_at = excluded.updated_at;
end;
$$;

alter table public.flexcon_inspection_records
  add column if not exists total_quantity bigint
  check (total_quantity is null or total_quantity >= 0);

create or replace function public.flexcon_set_inspection_total_quantity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_weight_type text;
  v_flexcon_weight integer;
begin
  if new.recommended_flexcon is null
     and new.paper_bags is null
     and new.bulk_quantity is null then
    new.total_quantity := null;
    return new;
  end if;

  v_weight_type := case
    when btrim(coalesce(new.brand, '')) = '飼料用玄米'
      then 'feed_rice'
    else 'branded_rice'
  end;

  select inspection_weight.weight_kg
  into v_flexcon_weight
  from public.flexcon_inspection_weights as inspection_weight
  where inspection_weight.weight_type = v_weight_type;

  v_flexcon_weight := coalesce(
    v_flexcon_weight,
    case
      when v_weight_type = 'feed_rice' then 1000
      else 1020
    end
  );

  new.total_quantity :=
      v_flexcon_weight * coalesce(new.recommended_flexcon, 0)
    + 30 * coalesce(new.paper_bags, 0)
    + coalesce(new.bulk_quantity, 0);

  return new;
end;
$$;

drop trigger if exists flexcon_inspection_total_quantity
  on public.flexcon_inspection_records;

create trigger flexcon_inspection_total_quantity
before insert or update of
  brand,
  recommended_flexcon,
  paper_bags,
  bulk_quantity
on public.flexcon_inspection_records
for each row
execute function public.flexcon_set_inspection_total_quantity();

update public.flexcon_inspection_records
set brand = brand;

revoke all
on function public.flexcon_save_inspection_weights(
  text,
  integer,
  integer
)
from public;

revoke all
on function public.flexcon_set_inspection_total_quantity()
from public;

grant select
on public.flexcon_inspection_weights
to anon, authenticated;

grant execute
on function public.flexcon_save_inspection_weights(
  text,
  integer,
  integer
)
to anon, authenticated;
