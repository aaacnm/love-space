-- ============================================================
--  009_conflicts_tables.sql · 和好 ①：4 张表 + 双盲复盘策略
--
--  顺序要求：两步（009 → 010）按序执行
--  依赖迁移：001
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='conflicts')
--  check: public.conflicts 表已存在
-- ============================================================

-- ============================================================
--  「和好」栏目 · 第 1 步（共 2 步）：建表 + 行级安全
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。跑完继续跑 010_conflicts_realtime.sql
-- ============================================================

-- ---------- 1. 冷战/破冰事件流水 ----------
-- kind: 'upset' = 记录一次不愉快（进入冷战）；'peace' = 我要和好
-- 状态机：取最近一条事件，是 upset 则「冷战中」，是 peace 则「风和日丽」

create table if not exists public.makeups (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'peace' check (kind in ('upset', 'peace')),
  created_at timestamptz not null default now()
);

create index if not exists idx_makeups_couple on public.makeups(couple_id, created_at desc);

-- ---------- 2. 矛盾事件（一次争执一条） ----------

create table if not exists public.conflicts (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  title text not null,
  happened_at date not null default current_date,
  created_at timestamptz not null default now()
);

-- ---------- 3. 复盘（每人写一份，双方都交卷才互相可见） ----------

create table if not exists public.conflict_reviews (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  conflict_id uuid not null references public.conflicts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  what text,      -- 发生了什么
  feeling text,   -- 我当时的感受
  mine text,      -- 我也有不对的地方
  hope text,      -- 希望下次怎么做
  created_at timestamptz not null default now(),
  unique (conflict_id, user_id)
);

-- ---------- 4. 我们的约定 ----------

create table if not exists public.promises (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  content text not null,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- 5. 行级安全 ----------

alter table public.makeups enable row level security;
alter table public.conflicts enable row level security;
alter table public.conflict_reviews enable row level security;
alter table public.promises enable row level security;

drop policy if exists "makeups_all" on public.makeups;
create policy "makeups_all" on public.makeups
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "promises_all" on public.promises;
create policy "promises_all" on public.promises
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "conflicts_all" on public.conflicts;
create policy "conflicts_all" on public.conflicts
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- 复盘：核心的「双盲」策略
--   我自己那份随时可见；对方那份只有在我也为这条矛盾交了卷之后才可见
drop policy if exists "reviews_select" on public.conflict_reviews;
create policy "reviews_select" on public.conflict_reviews
  for select using (
    couple_id = public.current_couple_id()
    and (
      user_id = auth.uid()
      or exists (
        select 1 from public.conflict_reviews mine
        where mine.conflict_id = public.conflict_reviews.conflict_id
          and mine.user_id = auth.uid()
      )
    )
  );

drop policy if exists "reviews_insert" on public.conflict_reviews;
create policy "reviews_insert" on public.conflict_reviews
  for insert with check (
    couple_id = public.current_couple_id()
    and user_id = auth.uid()
  );

drop policy if exists "reviews_update" on public.conflict_reviews;
create policy "reviews_update" on public.conflict_reviews
  for update using (couple_id = public.current_couple_id() and user_id = auth.uid())
  with check (couple_id = public.current_couple_id() and user_id = auth.uid());

drop policy if exists "reviews_delete" on public.conflict_reviews;
create policy "reviews_delete" on public.conflict_reviews
  for delete using (couple_id = public.current_couple_id() and user_id = auth.uid());
-- ------------------------------------------------------------
--  附：原 migration_conflicts.sql 的拆分说明
-- ------------------------------------------------------------
-- ============================================================
--  「和好」栏目迁移 —— 拆成两个小脚本，请按顺序分别执行
--
--    supabase/009_conflicts_tables.sql   四张表 + 行级安全（含复盘双盲策略）
--    supabase/010_conflicts_realtime.sql   实时同步 + replica identity
--
--  为什么要拆：SQL Editor 把整个脚本放进一个事务执行，一次跑多条 DDL
--  时持锁过久，容易和并发会话互相等待触发 40P01 deadlock detected。
--
--  四张表：
--    makeups          冷战/破冰事件流水（upset / peace）
--    conflicts       矛盾事件（一次争执一条）
--    conflict_reviews 复盘（每人一份，双方交卷后才互相可见）
--    promises        我们的约定
-- ============================================================
