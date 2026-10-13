-- ============================================================
--  「和好」轻量版 · 第 1 步（共 2 步）：建 3 张新表 + 行级安全
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。跑完继续跑 migration_signal_b.sql
-- ============================================================

-- ---------- 1. 信号灯（每人一条最新状态，前端判断 12 小时过期） ----------
-- kind: green = 消气了 / yellow = 还在气但想被哄 / red = 先别理我

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('green', 'yellow', 'red')),
  created_at timestamptz not null default now()
);

create index if not exists idx_signals_couple on public.signals(couple_id, created_at desc);

-- ---------- 2. 台阶卡（冷战中的一键台阶，对方「收下」即完成闭环） ----------
-- kind: tea = 递杯奶茶 / hug = 要一个抱抱 / words = 发句软话
-- accepted_at 为空 = 已递出还没被收下

create table if not exists public.steps (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('tea', 'hug', 'words')),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_steps_couple on public.steps(couple_id, created_at desc);

-- ---------- 3. 次日一问（代替复盘表单：一个单选 + 可选雷区标签） ----------
-- resolved: true = 过去了 / false = 还没有；tag 仅在 resolved 时可选填

create table if not exists public.conflict_checkins (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  conflict_id uuid not null references public.conflicts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  resolved boolean not null,
  tag text,
  created_at timestamptz not null default now(),
  unique (conflict_id, user_id)
);

-- ---------- 4. 行级安全 ----------

alter table public.signals enable row level security;
alter table public.steps enable row level security;
alter table public.conflict_checkins enable row level security;

drop policy if exists "signals_all" on public.signals;
create policy "signals_all" on public.signals
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "steps_all" on public.steps;
create policy "steps_all" on public.steps
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "checkins_all" on public.conflict_checkins;
create policy "checkins_all" on public.conflict_checkins
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());
