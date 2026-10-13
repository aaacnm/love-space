-- ============================================================
--  006_albums_table.sql · 图集 ①：albums 表
--
--  顺序要求：图集三步（006 → 007 → 008）必须按序连续执行
--  依赖迁移：001
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='albums')
--  check: public.albums 表已存在
-- ============================================================

-- ============================================================
--  图集功能 · 第 1 步（共 3 步）：建表
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。三步依次跑完：a -> b -> c
-- ============================================================

-- ---------- 1. 图集表 ----------

create table if not exists public.albums (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
-- ------------------------------------------------------------
--  附：原 migration_albums.sql 的拆分说明
-- ------------------------------------------------------------
-- ============================================================
--  图集功能迁移 —— 已拆分为三个小文件，请按顺序分别执行
--
--    supabase/006_albums_table.sql   建 albums 表
--    supabase/007_albums_photo_ref.sql   photos 加 album_id 字段 + 索引
--    supabase/008_albums_rls.sql   RLS 策略 + 实时同步 + replica identity
--
--  为什么要拆：SQL Editor 会把整个脚本放进一个事务执行，
--  一次性跑多条 DDL 时持锁时间过长，容易被其他会话（比如你开着
--  的应用页面在实时读 photos 表）堵住，触发 40P01 deadlock detected。
--  拆成每条只持锁几十毫秒后，基本不会再冲突。
-- ============================================================
