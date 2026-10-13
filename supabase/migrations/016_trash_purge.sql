-- ============================================================
--  016_trash_purge.sql · 最近删除 ②：语音彻底删除标记
--
--  顺序要求：必须在 014 之后
--  依赖迁移：014
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_hidden' and column_name='purged_at')
--  check: message_hidden.purged_at 列已存在
-- ============================================================

-- 最近删除 v2：不再依赖 trash_bin 表
-- 日记的回收站状态直接用 diary_entries.deleted_at 推导（软删除本身就是记录）
-- 语音的回收站状态直接用 message_hidden 推导，这里只需加一个「提前彻底删除」的标记列

alter table public.message_hidden add column if not exists purged_at timestamptz;
