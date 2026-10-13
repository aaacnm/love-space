-- 最近删除 v2：不再依赖 trash_bin 表
-- 日记的回收站状态直接用 diary_entries.deleted_at 推导（软删除本身就是记录）
-- 语音的回收站状态直接用 message_hidden 推导，这里只需加一个「提前彻底删除」的标记列

alter table public.message_hidden add column if not exists purged_at timestamptz;
