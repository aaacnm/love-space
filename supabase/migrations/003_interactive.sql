-- ============================================================
--  003_interactive.sql · 互动三件套：心情 / 问答 / 转盘
--
--  顺序要求：必须在 002 之后（给 pokes 加 kind 列）
--  依赖迁移：001, 002
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='pokes' and column_name='kind')
--  check: pokes.kind 列已存在
-- ============================================================

-- ============================================================
--  迁移脚本：互动三件套
--    1) 今日心情速递  moods
--    2) 每日问答      qna_answers
--    3) 一起决定转盘  spins
--  外加给 pokes 增加 kind 字段（poke 戳一戳 / comfort 摸摸头）
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
-- ============================================================

-- ---------- 1. 今日心情（每人每天一条，重复提交即覆盖） ----------

create table if not exists public.moods (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mood text not null,
  note text,
  date date not null,
  created_at timestamptz not null default now(),
  unique (couple_id, user_id, date)
);

-- ---------- 2. 每日问答（每人每天每题一条） ----------

create table if not exists public.qna_answers (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  question_date date not null,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now(),
  unique (couple_id, user_id, question_date)
);

-- ---------- 3. 一起决定转盘 ----------

create table if not exists public.spins (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  options text[] not null default '{}',
  result text not null,
  created_at timestamptz not null default now()
);

-- ---------- 4. 戳一戳表（若之前的迁移没跑过，这里一并补建） ----------

create table if not exists public.pokes (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'poke',
  created_at timestamptz not null default now()
);

alter table public.pokes add column if not exists kind text not null default 'poke';

alter table public.pokes enable row level security;

drop policy if exists "pokes_all" on public.pokes;
create policy "pokes_all" on public.pokes
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

do $$
begin
  begin
    alter publication supabase_realtime add table public.pokes;
  exception when others then
    raise notice '跳过 realtime 表 pokes（可到后台手动开启）';
  end;
end;
$$;

-- ---------- 5. 行级安全 ----------

alter table public.moods enable row level security;
alter table public.qna_answers enable row level security;
alter table public.spins enable row level security;

drop policy if exists "moods_all" on public.moods;
create policy "moods_all" on public.moods
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "qna_all" on public.qna_answers;
create policy "qna_all" on public.qna_answers
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "spins_all" on public.spins;
create policy "spins_all" on public.spins
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ---------- 6. 实时同步 ----------

do $$
declare
  t text;
begin
  foreach t in array array['moods','qna_answers','spins']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台 Database -> Replication 手动开启）', t;
    end;
  end loop;
end;
$$;
