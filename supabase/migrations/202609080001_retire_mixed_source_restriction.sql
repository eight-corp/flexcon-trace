-- 廃止した混在フレコンの参照が、通常の検査記録の編集・削除を妨げないようにします。
-- 混在フレコンと内訳の既存データは削除しません。

begin;

drop trigger if exists flexcon_guard_mixed_source_record_trigger
  on public.flexcon_inspection_flexcons;

alter table public.flexcon_mixed_flexcon_members
  drop constraint if exists flexcon_mixed_flexcon_members_source_flexcon_id_fkey;

alter table public.flexcon_mixed_flexcon_members
  add constraint flexcon_mixed_flexcon_members_source_flexcon_id_fkey
  foreign key (source_flexcon_id)
  references public.flexcon_inspection_flexcons(id)
  on delete set null;

commit;
