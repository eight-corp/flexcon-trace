-- 検査記録で選択する「検査場所」と「銘柄」のマスターを追加します。
-- 202609030001_inspection_records.sql の実行後に適用してください。

create table if not exists public.flexcon_inspection_options (
  id uuid primary key default gen_random_uuid(),
  option_type text not null check (option_type in ('location', 'brand_aomori', 'brand_iwate', 'grade')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  created_by_worker_id text references public.workers(worker_id),
  updated_by_worker_id text references public.workers(worker_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (option_type, name)
);

create index if not exists flexcon_inspection_options_lookup_idx
  on public.flexcon_inspection_options (option_type, active, name);

alter table public.flexcon_inspection_options enable row level security;

drop policy if exists flexcon_read_inspection_options
  on public.flexcon_inspection_options;
create policy flexcon_read_inspection_options on public.flexcon_inspection_options
  for select to anon, authenticated using (true);

insert into public.flexcon_inspection_options (option_type, name)
values
  ('location', '浪岡倉庫'),
  ('location', '六戸倉庫'),
  ('location', '八幡平倉庫'),
  ('brand_aomori', 'まっしぐら'),
  ('brand_aomori', 'はれわたり'),
  ('brand_aomori', 'つがるロマン'),
  ('brand_aomori', '青天の霹靂'),
  ('brand_aomori', '飼料用玄米'),
  ('brand_aomori', 'あかりもち'),
  ('brand_aomori', 'つきあかり'),
  ('brand_iwate', 'あきたこまち'),
  ('brand_iwate', '飼料用玄米'),
  ('brand_iwate', 'ひとめぼれ'),
  ('brand_iwate', 'いわてっこ'),
  ('brand_iwate', 'つきあかり'),
  ('brand_iwate', '岩手141号'),
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

  if p_option_type not in ('location', 'brand_aomori', 'brand_iwate', 'grade') then
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
      and (p_option_id is null or inspection_option.id <> p_option_id)
  ) then
    raise exception '同じ名称がすでに登録されています。';
  end if;

  if p_option_id is null then
    insert into public.flexcon_inspection_options (
      option_type, name, created_by_worker_id, updated_by_worker_id
    ) values (
      p_option_type, v_name, v_worker.worker_id, v_worker.worker_id
    ) returning id into v_id;
  else
    update public.flexcon_inspection_options
    set name = v_name,
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

create or replace function public.flexcon_set_inspection_option_active(
  p_worker_id text,
  p_option_id uuid,
  p_active boolean
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

  update public.flexcon_inspection_options
  set active = coalesce(p_active, false),
      updated_by_worker_id = v_worker.worker_id,
      updated_at = now()
  where id = p_option_id;

  if not found then
    raise exception '検査項目が見つかりません。';
  end if;
end;
$$;

revoke all on function public.flexcon_save_inspection_option(text, uuid, text, text)
  from public;
revoke all on function public.flexcon_set_inspection_option_active(text, uuid, boolean)
  from public;

grant select on public.flexcon_inspection_options to anon, authenticated;
grant execute on function public.flexcon_save_inspection_option(text, uuid, text, text)
  to anon, authenticated;
grant execute on function public.flexcon_set_inspection_option_active(text, uuid, boolean)
  to anon, authenticated;
