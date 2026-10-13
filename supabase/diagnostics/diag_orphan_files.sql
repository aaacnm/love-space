-- ============================================================
-- 照片桶孤儿文件诊断（第 1、2 条只读，放心执行）
--
-- 背景：migration_photo_original.sql 未执行的那段时间，上传时 insert
-- 带 original_path 字段会整批失败（42703），但文件已经进了 storage 桶，
-- 成为「有文件、没记录」的孤儿。本脚本把它们找出来。
--
-- 范围：检查 photos/、originals/ 与 thumbs/ 前缀（缩略图同样可能是孤儿，清理不能漏）；
--       diary/ 前缀是日记配图（不归 photos 表管），voice 桶是语音，均不在范围内。
--       软删除（回收站里 30 天内）的照片记录仍在 photos 表上，不会误判为孤儿。
--
-- 在 Supabase Dashboard → SQL Editor 执行。
-- ============================================================

-- 1) 孤儿文件清单（只读）
select
  o.name                as storage_path,
  round((o.metadata->>'size')::numeric / 1024) as kb,
  o.created_at
from storage.objects o
left join photos p
  on p.storage_path  = o.name
  or p.original_path = o.name
  or p.thumb_path    = o.name
where o.bucket_id = 'photos'
  and (o.name like 'photos/%' or o.name like 'originals/%' or o.name like 'thumbs/%')
  and p.id is null
order by o.created_at;

-- 2) 汇总：孤儿数量与总大小
select
  count(*) as orphan_count,
  coalesce(pg_size_pretty(sum((o.metadata->>'size')::bigint)), '0 bytes') as total_size
from storage.objects o
left join photos p
  on p.storage_path  = o.name
  or p.original_path = o.name
  or p.thumb_path    = o.name
where o.bucket_id = 'photos'
  and (o.name like 'photos/%' or o.name like 'originals/%' or o.name like 'thumbs/%')
  and p.id is null;

-- 3) （清理用，默认注释）确认第 1 条清单无误后再取消注释执行。
--    ⚠️ 删除后无法恢复；执行前请先备份或截图清单。
--
-- with orphans as (
--   select o.name
--   from storage.objects o
--   left join photos p
--     on p.storage_path  = o.name
--     or p.original_path = o.name
--     or p.thumb_path    = o.name
--   where o.bucket_id = 'photos'
--     and (o.name like 'photos/%' or o.name like 'originals/%' or o.name like 'thumbs/%')
--     and p.id is null
-- )
-- delete from storage.objects
-- where bucket_id = 'photos'
--   and name in (select name from orphans);
