-- ============================================================
--  紧急修复：period_logs / period_settings 未启用 RLS（P0 越权）
--
--  用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴 → Run。
--  幂等，可重复执行。内容与 supabase/migrations/036_period_rls.sql 一致，
--  这里额外加了「修复前先看现状 / 修复后复查 / 全库体检」三段。
-- ============================================================

-- ---------- ① 修复前：看现状（relrowsecurity = false 就是没上锁） ----------
select c.relname as 表名,
       c.relrowsecurity as rls已启用,
       c.relforcerowsecurity as rls强制,
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as 已有策略数
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in ('period_logs', 'period_settings')
order by 1;

-- 泄露面有多大：这两张表一共有多少行（开着 RLS 之前，它们对所有有权限的角色可见）
select 'period_logs' as 表名, count(*) as 行数 from public.period_logs
union all
select 'period_settings', count(*) from public.period_settings;

-- ---------- ② 全库体检：还有没有别的表忘了开 RLS ----------
-- 期望：只返回空（说明所有业务表都开着）。视图/分区表已排除。
select c.relname as 忘了开RLS的表
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and not c.relrowsecurity
order by 1;

-- ---------- ③ 修复 ----------
alter table public.period_logs enable row level security;
alter table public.period_settings enable row level security;

drop policy if exists "period_logs_all" on public.period_logs;
create policy "period_logs_all" on public.period_logs
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "period_settings_all" on public.period_settings;
create policy "period_settings_all" on public.period_settings
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

notify pgrst, 'reload schema';

-- ---------- ④ 修复后复查：两张表都必须是 true ----------
select c.relname as 表名,
       c.relrowsecurity as rls已启用,
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as 生效策略数
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('period_logs', 'period_settings')
order by 1;
