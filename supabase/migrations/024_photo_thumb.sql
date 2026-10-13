-- ============================================================
--  024_photo_thumb.sql · 照片缩略图：photos.thumb_path
--
--  顺序要求：无特殊要求
--  依赖迁移：001（photos）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='thumb_path')
--  check: photos.thumb_path 列已存在
-- ============================================================

-- 照片缩略图：网格/列表/封面用 480px 小图（几十 KB），点开大图才加载 1600px 压缩图。
-- 手机上浏览照片页的流量和解码时间都能降一个数量级，弱网下明显更快。
-- 在 SQL Editor 中执行一次即可，幂等可重复执行。

alter table public.photos
  add column if not exists thumb_path text;

-- RLS 无需改动（photos_all 策略覆盖整行）；
-- 旧照片 thumb_path 为 null，界面自动回退到 storage_path 显示。
