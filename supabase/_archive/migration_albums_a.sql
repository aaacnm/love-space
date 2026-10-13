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
