-- ============================================================
--  007_albums_photo_ref.sql · 图集 ②：photos.album_id 外键 + 索引
--
--  顺序要求：必须在 006 之后
--  依赖迁移：001, 006
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='album_id')
--  check: photos.album_id 列已存在
-- ============================================================

-- ============================================================
--  图集功能 · 第 2 步（共 3 步）：照片归属字段
--  on delete set null：删掉图集时照片回到「未分组」，文件不会被删
-- ============================================================

alter table public.photos add column if not exists album_id uuid references public.albums(id) on delete set null;

create index if not exists idx_photos_album on public.photos(album_id);
