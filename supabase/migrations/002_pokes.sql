-- ============================================================
--  002_pokes.sql · 「想你了」戳一戳
--
--  顺序要求：无特殊要求
--  依赖迁移：001（couples / auth.users）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='pokes')
--  check: public.pokes 表已存在
-- ============================================================

-- ============================================================
--  迁移脚本：「想你了」戳一戳
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  （幂等，重复运行不会报错）
-- ============================================================

-- ---------- 1. 数据表 ----------

create table if not exists public.pokes (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- 2. 行级安全 ----------

alter table public.pokes enable row level security;

drop policy if exists "pokes_all" on public.pokes;
create policy "pokes_all" on public.pokes
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ---------- 3. 实时同步 ----------
-- 关键：新表必须加入 realtime publication，否则对方收不到实时推送

do $$
begin
  begin
    alter publication supabase_realtime add table public.pokes;
  exception when others then
    raise notice '跳过 realtime 表 pokes（可能已添加，可到后台 Database -> Replication 手动开启）';
  end;
end;
$$;
