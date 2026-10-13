-- 生理期每日打卡（对标 Flo/美柚 的每日症状记录，情侣双方共享）
-- 每人每天最多一条（couple_id + user_id + log_date 唯一），可反复更新

-- ---------- 1. 建表 ----------
create table if not exists public.period_daily_logs (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  log_date date not null,
  -- 流量：none 没来 / light 少量 / medium 适中 / heavy 量多
  flow text check (flow in ('none','light','medium','heavy')),
  -- 痛经程度 0-3（不痛/轻微/中度/严重）
  pain int check (pain between 0 and 3),
  -- 情绪：happy/calm/irritable/low/sensitive
  mood text,
  -- 症状多选（预设标签）
  symptoms text[] not null default '{}',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (couple_id, user_id, log_date)
);

create index if not exists idx_period_daily_couple_date
  on public.period_daily_logs(couple_id, log_date);

-- ---------- 2. 行级安全（couple 内双方全权，与 period_logs 一致） ----------
alter table public.period_daily_logs enable row level security;

drop policy if exists "period_daily_all" on public.period_daily_logs;
create policy "period_daily_all" on public.period_daily_logs
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ---------- 3. 实时同步 ----------
alter table public.period_daily_logs replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'period_daily_logs'
  ) then
    alter publication supabase_realtime add table public.period_daily_logs;
  end if;
end $$;
