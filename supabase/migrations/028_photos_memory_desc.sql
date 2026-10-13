-- ============================================================
--  028_photos_memory_desc.sql · 记忆空间 ①：图集简介
--
--  顺序要求：两步（028 → 029）按序执行；必须在 006 之后
--  依赖迁移：006
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='albums' and column_name='description')
--  check: albums.description 列已存在
-- ============================================================

-- ============================================================
--  相册「记忆空间」升级 · 第 1 步（共 2 步）：图集简介
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。两步依次跑完：a -> b
--
--  为什么拆成两个小文件：SQL Editor 把整个脚本放进一个事务执行，
--  一次性跑多条 DDL 持锁时间长，容易被 App 的实时连接堵住，
--  触发 40P01 deadlock detected（教训见 （图集三步：006_albums_table.sql → 007_albums_photo_ref.sql → 008_albums_rls.sql） 拆分说明）。
-- ============================================================

-- ---------- 1. 图集简介（展示用，双方都可编辑） ----------
alter table public.albums add column if not exists description text;

notify pgrst, 'reload schema';

-- ---------- 自查（应返回 1） ----------
select count(*) as description_ok
from information_schema.columns
where table_schema = 'public' and table_name = 'albums' and column_name = 'description';
