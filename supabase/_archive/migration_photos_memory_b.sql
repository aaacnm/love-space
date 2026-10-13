-- ============================================================
--  相册「记忆空间」升级 · 第 2 步（共 2 步）：置顶照片
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。先跑 a 再跑本步。
-- ============================================================

-- ---------- 1. 置顶时间戳：null = 未置顶；置顶的照片在网格里排最前、优先当图集封面 ----------
-- 注意：pinned_at 存在照片行上，是情侣共同状态（双方看到同一个置顶效果），不是个人偏好
alter table public.photos add column if not exists pinned_at timestamptz;

notify pgrst, 'reload schema';

-- ---------- 自查（应返回 1） ----------
select count(*) as pinned_at_ok
from information_schema.columns
where table_schema = 'public' and table_name = 'photos' and column_name = 'pinned_at';
