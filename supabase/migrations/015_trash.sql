-- ============================================================
--  015_trash.sql · 最近删除 ①：trash_bin + 日记软删
--
--  顺序要求：无特殊要求
--  依赖迁移：001, 004
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='trash_bin')
--  check: public.trash_bin 表已存在
-- ============================================================

-- 最近删除（回收站）：删掉的日记 / 留言先在这里躺 3 天，期间可恢复，到期自动清除
-- 日记：软删除（deleted_at 标记，双人都看不到，但数据还在，评论也保留）
-- 留言：删除本来就只对自己生效，这里记一条回收站条目；音频保留给 TA 听

alter table public.diary_entries add column if not exists deleted_at timestamptz;

create table if not exists public.trash_bin (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  kind text not null check (kind in ('diary', 'message')),
  ref_id uuid not null,
  deleted_by uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 days'
);

create index if not exists idx_trash_bin_ref on public.trash_bin(ref_id);

alter table public.trash_bin enable row level security;
alter table public.trash_bin replica identity full;

-- 日记型：双方都看得到（删掉对两个人都生效）
-- 留言型：删除只对自己生效，所以只有自己能看见这条回收站记录
drop policy if exists "trash_select" on public.trash_bin;
create policy "trash_select" on public.trash_bin
  for select using (couple_id = public.current_couple_id() and (kind = 'diary' or deleted_by = auth.uid()));

drop policy if exists "trash_insert" on public.trash_bin;
create policy "trash_insert" on public.trash_bin
  for insert with check (couple_id = public.current_couple_id() and deleted_by = auth.uid());

drop policy if exists "trash_delete" on public.trash_bin;
create policy "trash_delete" on public.trash_bin
  for delete using (couple_id = public.current_couple_id());

-- 已进回收站的日记（deleted_at 非空）允许双方彻底清除；
-- 否则按原策略只有作者能删，对方那边 3 天后就清不掉
drop policy if exists "diary_delete_trashed" on public.diary_entries;
create policy "diary_delete_trashed" on public.diary_entries
  for delete using (couple_id = public.current_couple_id() and deleted_at is not null);

-- 实时同步（已存在会被跳过，不报错）
do $$
begin
  begin
    alter publication supabase_realtime add table public.trash_bin;
  exception when others then
    raise notice '跳过 realtime 表 trash_bin（可到后台手动开启）';
  end;
end;
$$;
