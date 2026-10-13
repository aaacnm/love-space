-- ============================================================
--  图集功能 · 第 2 步（共 3 步）：照片归属字段
--  on delete set null：删掉图集时照片回到「未分组」，文件不会被删
-- ============================================================

alter table public.photos add column if not exists album_id uuid references public.albums(id) on delete set null;

create index if not exists idx_photos_album on public.photos(album_id);
