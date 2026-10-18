-- ============================================================
--  036_period_rls.sql · 补开 period_logs / period_settings 的行级安全（P0）
--
--  顺序要求：必须在 020 之后（两张表是 020 建的）
--  依赖迁移：001, 020
--  幂等：是，可重复执行（enable 本身幂等；policy 走 drop if exists + create）
--
--  fingerprint: (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname in ('period_logs', 'period_settings'))
--  check: period_logs / period_settings 的 relrowsecurity 均为 true
-- ============================================================

-- ⚠ 这是一个真实的越权漏洞，不是洁癖：
--   020 里已经写好了「按 couple_id 隔离」的 policy，但**漏了 enable row level security**。
--   RLS 关闭时 policy 完全不参与过滤 —— 表还在、policy 也在，等于没锁门。
--   只要角色有表权限（Supabase 默认把 public schema 的权限给了 anon / authenticated），
--   调用方就能跨空间读到所有人的经期记录、也能改别人的周期设置。
--   022 的 period_daily_logs 明确开了 RLS，对比之下更说明 020 这两张是漏的。
--
-- 只补开关，不改语义：policy 与 020 里的一字不变，空间内双方照旧可读可写。
alter table public.period_logs enable row level security;
alter table public.period_settings enable row level security;

-- 策略顺手重建一遍（幂等）：万一哪台库上 policy 被手工改过，这里把它拉回正轨
drop policy if exists "period_logs_all" on public.period_logs;
create policy "period_logs_all" on public.period_logs
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "period_settings_all" on public.period_settings;
create policy "period_settings_all" on public.period_settings
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- 让 PostgREST 立刻看见新状态（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';
