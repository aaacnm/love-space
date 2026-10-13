-- ============================================================
--  020_period.sql · 生理期：period_logs / period_settings
--
--  顺序要求：必须在 022 之前
--  依赖迁移：001
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='period_logs')
--  check: public.period_logs 表已存在
-- ============================================================

-- ============================================================
-- 生理期追踪：period_logs（每次经期开始日） + period_settings（周期配置）
-- 双方共享可见，都能记录/修改；在 SQL Editor 执行。
-- ============================================================

-- 1. 经期记录：每次生理期开始那天插一行
create table if not exists public.period_logs (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  start_date date not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_period_logs_couple on public.period_logs(couple_id, start_date);

-- 2. 周期设置：每个空间一行（周期长度 / 经期天数）
create table if not exists public.period_settings (
  couple_id uuid primary key references public.couples(id) on delete cascade,
  cycle_len int not null default 28 check (cycle_len between 15 and 60),
  period_len int not null default 5 check (period_len between 1 and 14),
  updated_at timestamptz not null default now()
);

-- 3. RLS：空间内双方全权（同 photos_all 模式）
drop policy if exists "period_logs_all" on public.period_logs;
create policy "period_logs_all" on public.period_logs
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "period_settings_all" on public.period_settings;
create policy "period_settings_all" on public.period_settings
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- 4. 实时同步
alter table public.period_logs replica identity full;
alter table public.period_settings replica identity full;

do $$
declare
  t text;
begin
  foreach t in array array['period_logs','period_settings']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台手动开启）', t;
    end;
  end loop;
end;
$$;
