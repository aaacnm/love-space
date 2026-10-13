-- ============================================================
--  「和好」栏目 · 第 1 步（共 2 步）：建表 + 行级安全
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。跑完继续跑 migration_conflicts_b.sql
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
