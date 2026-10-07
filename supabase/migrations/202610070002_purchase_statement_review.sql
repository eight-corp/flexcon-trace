-- 読取結果は確認待ちとして隔離し、別担当者の確認時だけ仕切書へ確定します。
begin;

create table if not exists public.flexcon_purchase_statement_drafts (
  id uuid primary key,
  source_type text not null check (source_type in ('camera', 'manual')),
  header jsonb not null check (jsonb_typeof(header) = 'object'),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  reading_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(reading_warnings) = 'array'),
  image_path text,
  created_by_worker_id text not null references public.workers(worker_id),
  created_by_worker_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_statement_id uuid,
  confirmed_by_worker_id text references public.workers(worker_id),
  confirmed_by_worker_name text,
  confirmed_at timestamptz,
  check ((confirmed_at is null and confirmed_by_worker_id is null and confirmed_statement_id is null)
    or (confirmed_at is not null and confirmed_by_worker_id is not null and confirmed_statement_id is not null
      and confirmed_by_worker_id <> created_by_worker_id))
);
create index if not exists flexcon_purchase_statement_drafts_pending_idx
  on public.flexcon_purchase_statement_drafts(created_at desc) where confirmed_at is null;
alter table public.flexcon_purchase_statement_drafts enable row level security;
revoke all on public.flexcon_purchase_statement_drafts from public, anon, authenticated;

create or replace function public.flexcon_submit_purchase_statement(
  p_worker_id text, p_draft_id uuid, p_source_type text, p_header jsonb, p_items jsonb, p_warnings jsonb
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_worker public.workers%rowtype;
  v_draft public.flexcon_purchase_statement_drafts%rowtype;
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'operator');
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  if p_draft_id is null then raise exception '読取IDが不正です。'; end if;
  if coalesce(p_source_type, '') not in ('camera', 'manual')
    or jsonb_typeof(coalesce(p_header, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_warnings, 'null'::jsonb)) <> 'array' then
    raise exception '読取結果が不正です。';
  end if;
  if jsonb_array_length(p_items) = 0 or exists (
    select 1 from jsonb_array_elements(p_items) item where jsonb_typeof(item) <> 'object'
  ) then raise exception '読取明細がありません。'; end if;
  insert into public.flexcon_purchase_statement_drafts(
    id, source_type, header, items, reading_warnings, created_by_worker_id, created_by_worker_name
  ) values (p_draft_id, p_source_type, p_header, p_items, p_warnings, v_worker.worker_id, v_worker.worker_name)
  on conflict (id) do nothing;
  select * into v_draft from public.flexcon_purchase_statement_drafts where id = p_draft_id;
  if v_draft.created_by_worker_id <> v_worker.worker_id or v_draft.source_type <> p_source_type
    or v_draft.header <> p_header or v_draft.items <> p_items or v_draft.reading_warnings <> p_warnings then
    raise exception '同じ読取IDの内容が一致しません。';
  end if;
  return v_draft.id;
end; $$;

create or replace function public.flexcon_list_pending_purchase_statements(p_worker_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'viewer');
  perform public.flexcon_require_active_worker(p_worker_id);
  return coalesce((
    select jsonb_agg(draft.header || jsonb_build_object(
      'id', draft.id, 'pending', true, 'source_type', draft.source_type,
      'image_path', coalesce(draft.image_path, ''), 'warnings', draft.reading_warnings,
      'created_by_worker_id', draft.created_by_worker_id, 'created_by_worker_name', draft.created_by_worker_name,
      'created_at', draft.created_at, 'updated_at', draft.updated_at,
      'items', (select jsonb_agg(item.value || jsonb_build_object('id', draft.id::text || ':' || item.position, 'line_no', item.position) order by item.position)
        from jsonb_array_elements(draft.items) with ordinality item(value, position))
    ) order by draft.created_at desc, draft.id)
    from public.flexcon_purchase_statement_drafts draft where draft.confirmed_at is null
  ), '[]'::jsonb);
end; $$;

create or replace function public.flexcon_confirm_purchase_statement(
  p_worker_id text, p_draft_id uuid, p_header jsonb, p_items jsonb, p_replace_statement_id uuid default null
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_worker public.workers%rowtype;
  v_draft public.flexcon_purchase_statement_drafts%rowtype;
  v_statement_id uuid;
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'operator');
  v_worker := public.flexcon_require_active_worker(p_worker_id);
  select * into v_draft from public.flexcon_purchase_statement_drafts where id = p_draft_id for update;
  if not found then raise exception '確認待ちの仕切書が見つかりません。'; end if;
  if v_worker.worker_id = v_draft.created_by_worker_id then
    raise exception '読取者本人は確認できません。別の担当者に確認を依頼してください。';
  end if;
  if v_draft.confirmed_at is not null then
    if v_draft.confirmed_by_worker_id = v_worker.worker_id and v_draft.header = p_header and v_draft.items = p_items then
      return v_draft.confirmed_statement_id;
    end if;
    raise exception 'この仕切書はすでに確認済みです。一覧を再読込してください。';
  end if;
  if v_draft.source_type = 'camera' and nullif(v_draft.image_path, '') is null then
    raise exception '元画像の保存が完了していません。読取者に保存の再試行を依頼してください。';
  end if;
  if p_replace_statement_id is not null and not exists (
    select 1 from public.flexcon_purchase_statements where id = p_replace_statement_id
      and lower(btrim(document_number)) = lower(btrim(p_header->>'document_number'))
  ) then raise exception '上書き先の仕切書№が一致しません。'; end if;
  v_statement_id := public.flexcon_save_purchase_statement_internal(
    p_worker_id, p_replace_statement_id, v_draft.source_type, p_header, p_items
  );
  update public.flexcon_purchase_statements set
    image_path = coalesce(v_draft.image_path, image_path),
    created_by_worker_id = case when p_replace_statement_id is null then v_draft.created_by_worker_id else created_by_worker_id end,
    created_by_worker_name = case when p_replace_statement_id is null then v_draft.created_by_worker_name else created_by_worker_name end
  where id = v_statement_id;
  update public.flexcon_purchase_statement_drafts set header = p_header, items = p_items,
    confirmed_statement_id = v_statement_id, confirmed_by_worker_id = v_worker.worker_id,
    confirmed_by_worker_name = v_worker.worker_name, confirmed_at = now(), updated_at = now()
  where id = p_draft_id;
  return v_statement_id;
end; $$;

-- 旧画面/APIから新規の読取結果を直接確定させないようにします。
create or replace function public.flexcon_save_purchase_statement(
  p_worker_id text, p_statement_id uuid, p_source_type text, p_header jsonb, p_items jsonb
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'operator');
  if p_statement_id is null then raise exception '新規の仕切書は確認待ちに保存し、別の担当者が確認してください。'; end if;
  return public.flexcon_save_purchase_statement_internal(p_worker_id, p_statement_id, p_source_type, p_header, p_items);
end; $$;

create or replace function public.flexcon_delete_pending_purchase_statement(p_worker_id text, p_draft_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.flexcon_set_purchase_statement_scope(p_worker_id, 'admin');
  perform public.flexcon_require_admin_worker(p_worker_id);
  delete from public.flexcon_purchase_statement_drafts where id = p_draft_id and confirmed_at is null;
  if not found then raise exception '確認待ちの仕切書が見つかりません。'; end if;
end; $$;

revoke all on function public.flexcon_submit_purchase_statement(text, uuid, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.flexcon_list_pending_purchase_statements(text) from public;
revoke all on function public.flexcon_confirm_purchase_statement(text, uuid, jsonb, jsonb, uuid) from public;
revoke all on function public.flexcon_delete_pending_purchase_statement(text, uuid) from public;
grant execute on function public.flexcon_submit_purchase_statement(text, uuid, text, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.flexcon_list_pending_purchase_statements(text) to anon, authenticated;
grant execute on function public.flexcon_confirm_purchase_statement(text, uuid, jsonb, jsonb, uuid) to anon, authenticated;
grant execute on function public.flexcon_delete_pending_purchase_statement(text, uuid) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
