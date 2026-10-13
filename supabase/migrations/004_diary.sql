-- ============================================================
--  004_diary.sql · 日记：多图 + 评论 + 私密日记
--
--  顺序要求：无特殊要求
--  依赖迁移：001（diary_entries）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='diary_entries' and column_name='images')
--  check: diary_entries.images 列已存在
-- ============================================================

-- ============================================================
--  日记增强：图片 / 评论 / 各自独立隐藏 / 只能删自己的日记
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）
-- ============================================================

-- ---------- 1. 日记配图（最多 3 张，存 storage 路径数组） ----------

alter table public.diary_entries add column if not exists images text[] not null default '{}';

-- ---------- 2. 日记评论 ----------

create table if not exists public.diary_comments (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  diary_id uuid not null references public.diary_entries(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_diary_comments_diary on public.diary_comments(diary_id);

-- ---------- 3. 日记隐藏（每人独立一份，互不影响） ----------

create table if not exists public.diary_hidden (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  diary_id uuid not null references public.diary_entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (diary_id, user_id)
);

-- ---------- 4. 行级安全 ----------

alter table public.diary_comments enable row level security;
alter table public.diary_hidden enable row level security;

-- 日记：把原来一条「本空间可读写全部」拆成细粒度策略
drop policy if exists "diary_all" on public.diary_entries;
drop policy if exists "diary_select" on public.diary_entries;
drop policy if exists "diary_insert" on public.diary_entries;
drop policy if exists "diary_update" on public.diary_entries;
drop policy if exists "diary_delete" on public.diary_entries;

-- 读：本空间成员都能看（「隐藏」是前端按人过滤的，不影响对方）
create policy "diary_select" on public.diary_entries
  for select using (couple_id = public.current_couple_id());

-- 写：只能以自己身份发布
create policy "diary_insert" on public.diary_entries
  for insert with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

create policy "diary_update" on public.diary_entries
  for update using (couple_id = public.current_couple_id() and author_user_id = auth.uid())
  with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

-- 删：★ 只能删自己写的日记
create policy "diary_delete" on public.diary_entries
  for delete using (couple_id = public.current_couple_id() and author_user_id = auth.uid());

-- 评论：本空间可读、自己身份发布、只能删自己发的
drop policy if exists "diary_comments_all" on public.diary_comments;
drop policy if exists "diary_comments_select" on public.diary_comments;
drop policy if exists "diary_comments_insert" on public.diary_comments;
drop policy if exists "diary_comments_delete" on public.diary_comments;

create policy "diary_comments_select" on public.diary_comments
  for select using (couple_id = public.current_couple_id());

create policy "diary_comments_insert" on public.diary_comments
  for insert with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

create policy "diary_comments_delete" on public.diary_comments
  for delete using (author_user_id = auth.uid());

-- 隐藏：★ 只能读写自己的隐藏记录（对方看不到你隐藏了什么）
drop policy if exists "diary_hidden_own" on public.diary_hidden;

create policy "diary_hidden_own" on public.diary_hidden
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and couple_id = public.current_couple_id());

-- ---------- 5. 实时同步 ----------

do $$
declare
  t text;
begin
  foreach t in array array['diary_comments','diary_hidden']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台手动开启）', t;
    end;
  end loop;
end;
$$;
