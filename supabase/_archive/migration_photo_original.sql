-- 照片原图：浏览用压缩图（快），额外存一份原图供双方下载保存
-- 用法：Supabase Dashboard → SQL Editor → 粘贴执行（可重复执行，不会报错）

alter table public.photos add column if not exists original_path text;

-- 说明：
-- 1) 不用新建存储桶：原图存在同一个 public 桶 photos 里，路径前缀为 originals/
-- 2) 老照片 original_path 为空，界面上会自动回退到 storage_path（压缩图）来保存
-- 3) 想看看哪些照片有原图：
--    select id, storage_path, original_path from public.photos order by created_at desc limit 20;
