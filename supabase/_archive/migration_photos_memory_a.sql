-- ============================================================
--  相册「记忆空间」升级 · 第 1 步（共 2 步）：图集简介
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。两步依次跑完：a -> b
--
--  为什么拆成两个小文件：SQL Editor 把整个脚本放进一个事务执行，
--  一次性跑多条 DDL 持锁时间长，容易被 App 的实时连接堵住，
--  触发 40P01 deadlock detected（教训见 migration_albums.sql 拆分说明）。
-- ============================================================

-- ---------- 1. 图集简介（展示用，双方都可编辑） ----------
alter table public.albums add column if not exists description text;

notify pgrst, 'reload schema';

-- ---------- 自查（应返回 1） ----------
select count(*) as description_ok
from information_schema.columns
where table_schema = 'public' and table_name = 'albums' and column_name = 'description';
