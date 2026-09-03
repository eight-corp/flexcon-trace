-- 平均水分を、水分1～100の入力済み値から小数第1位で四捨五入して保存します。
-- 202609030001_inspection_records.sql の実行後に適用してください。

create or replace function public.flexcon_set_inspection_moisture_average()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select round(avg(measured.value), 1)
  into new.moisture
  from unnest(new.moisture_values) as measured(value)
  where measured.value is not null;

  return new;
end;
$$;

drop trigger if exists flexcon_inspection_moisture_average
  on public.flexcon_inspection_records;

create trigger flexcon_inspection_moisture_average
before insert or update of moisture_values
on public.flexcon_inspection_records
for each row
execute function public.flexcon_set_inspection_moisture_average();

update public.flexcon_inspection_records as inspection
set moisture = (
  select round(avg(measured.value), 1)
  from unnest(inspection.moisture_values) as measured(value)
  where measured.value is not null
);

revoke all on function public.flexcon_set_inspection_moisture_average()
  from public;
