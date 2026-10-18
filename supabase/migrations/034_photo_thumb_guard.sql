-- ============================================================
--  034_photo_thumb_guard.sql · 缩略图保障：缺缩略图照片的检查函数 + 部分索引
--
--  顺序要求：必须在 024 之后（读 024 加的 photos.thumb_path）
--  依赖迁移：001, 024
--  幂等：是，可重复执行（create or replace / if not exists + grant）
--
--  fingerprint: exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'photos_missing_thumb')
--  check: public.photos_missing_thumb() 函数已存在
-- ============================================================

-- 为什么要有它：
--   photos.thumb_path 是 024 加的列，那之前的照片全是 null。前端曾经用
--   `thumb_path || storage_path` 兜底，等于让浏览列表去签**原图**——手机上
--   一屏十几张老照片就能吃掉几十 MB 流量。
--   现在前端改成「没有缩略图就走服务端 480 变换」，这里再从数据库侧把
--   「缺缩略图的记录」显式暴露出来，方便核对补齐进度。
--
-- 为什么不加 not null / 触发器强约束（重要）：
--   · 已有数据里 thumb_path 就是 null，加 not null 会直接失败；
--   · 前端还有一条兼容路径——列不存在时去掉 thumb_path 字段重试入库，
--     加触发器会让这条降级路径整批失败，反而把照片弄丢。
--   所以这里只做「可观测」（函数 + 索引），真正的补齐交给前端后台任务（useThumbBackfill）。

set lock_timeout = '8s';

-- 列出当前空间里还没有缩略图的照片（security invoker：照走 RLS，只看得到自己的）
create or replace function public.photos_missing_thumb()
returns table (photo_id uuid, storage_path text, created_at timestamptz)
language sql
security invoker
stable
set search_path = public
as $$
  select p.id, p.storage_path, p.created_at
  from public.photos p
  where p.thumb_path is null
    and p.couple_id = public.current_couple_id()
  order by p.created_at desc;
$$;

-- 缺缩略图的照片是少数，用部分索引让上面的检查几乎不花钱
create index if not exists photos_thumb_missing_idx
  on public.photos (couple_id, created_at desc)
  where thumb_path is null;

-- 默认 PUBLIC 不带走：只放行真正带身份的调用方（匿名登录拿到的也是 authenticated 角色）
revoke all on function public.photos_missing_thumb() from public;
grant execute on function public.photos_missing_thumb() to anon, authenticated;

-- 让 PostgREST 立刻看见新函数（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';
