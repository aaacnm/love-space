-- ============================================================
--  一次性补齐脚本：把 032–035 四个迁移按顺序跑进生产库
--
--  ⚠️ 自动生成（由 scripts 拼装 migrations/ 原文件），请勿手改内容；
--     它只是「把四个迁移首尾相接」，方便在 SQL Editor 里一次粘贴执行。
--
--  用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴 → Run。
--  四个迁移全部幂等（create or replace / if not exists），重复执行无害。
--  全部执行成功会输出最后一段 NOTICE 与核对结果。
-- ============================================================
-- ################ 032_paged_indexes.sql ################
-- ============================================================
--  032_paged_indexes.sql · 分页索引：(couple_id, created_at) 复合索引
--
--  顺序要求：必须在 004/013/019/020 之后（索引建在这些表上）；不跑功能正常，只是全表扫描
--  依赖迁移：004, 013, 019, 020
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_indexes where schemaname='public' and indexname='photos_couple_created_idx')
--  check: photos_couple_created_idx 索引已存在
-- ============================================================

-- 分页性能索引：三大内容表按 (couple_id, created_at) 复合索引，
-- 支撑 usePagedCollection 的「WHERE couple_id ORDER BY created_at DESC LIMIT n」分页查询
-- 与留言/日记的月/日筛选。评论表与生理期日志同构顺手覆盖。
-- 跑法：Supabase Dashboard → SQL Editor 全量执行（幂等，可重复跑）。

set lock_timeout = '8s';

-- 主内容表：倒序查询（最新在前）
create index if not exists photos_couple_created_idx
  on public.photos (couple_id, created_at desc);
create index if not exists messages_couple_created_idx
  on public.messages (couple_id, created_at desc);
create index if not exists diary_entries_couple_created_idx
  on public.diary_entries (couple_id, created_at desc);
create index if not exists period_logs_couple_created_idx
  on public.period_logs (couple_id, created_at desc);

-- 评论表：正序（asc）展示，普通索引即可（Postgres 可反向扫描）
create index if not exists message_comments_couple_created_idx
  on public.message_comments (couple_id, created_at);
create index if not exists diary_comments_couple_created_idx
  on public.diary_comments (couple_id, created_at);

-- ################ 033_bootstrap_space.sql ################
-- ============================================================
--  033_bootstrap_space.sql · 首屏聚合 RPC：一次拿齐「用户 + 空间 + 成员 + 纪念日 + 下次见面」
--
--  顺序要求：必须在 001 之后（读 001 建的 couples / members / milestones）
--  依赖迁移：001
--  幂等：是，可重复执行（create or replace + grant）
--
--  fingerprint: exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'bootstrap_space')
--  check: public.bootstrap_space(date) 函数已存在
-- ============================================================

-- 为什么要有它：
--   首屏原本要串行跑 3 段请求（auth.getUser → members 查自己 → couples/members/milestones 三个查询），
--   手机上每一段都是一次往返，冷启动能明显感觉到白屏。这个函数把首屏需要的一切合成
--   **一个请求**，服务端顺手把「纪念日 / 下次见面」挑出来，前端连排序都不用做。
--
-- 权限边界（重要）：
--   刻意用 **security invoker**（不是 definer）——函数里的查询照样走调用者的 RLS，
--   所以这个函数**不会**变成绕过行级安全的后门：拿不到的数据，返回里就是空的。
--   前端的 localStorage 缓存同理，只用来「先画出来」，真正的权限仍由 RLS 说了算。

set lock_timeout = '8s';

create or replace function public.bootstrap_space(p_today date default null)
returns json
language plpgsql
security invoker
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cid uuid;
  v_couple json;
  v_mine json;
  v_members json := '[]'::json;
  v_milestones json := '[]'::json;
  v_anniversary json;
  v_next json;
  -- 「今天」按调用方传的为准：数据库的 current_date 是 UTC，东八区凌晨会差一天
  v_today date := coalesce(p_today, (now() at time zone 'utc')::date);
begin
  -- 没有身份（未登录 / 匿名态失效）：返回空壳，前端按「全新用户」处理
  if v_uid is null then
    return json_build_object(
      'user', null,
      'couple', null,
      'my_member', null,
      'members', '[]'::json,
      'milestones', '[]'::json,
      'anniversary', null,
      'next_meetup', null
    );
  end if;

  -- 我所属的空间（RLS 只允许看到自己那条成员记录，所以这里天然安全）
  select m.couple_id into v_cid
  from public.members m
  where m.user_id = v_uid
  limit 1;

  if v_cid is not null then
    select to_json(c) into v_couple from public.couples c where c.id = v_cid;

    select to_json(m) into v_mine from public.members m where m.user_id = v_uid limit 1;

    select coalesce(json_agg(to_json(m) order by m.created_at asc), '[]'::json)
      into v_members
    from public.members m
    where m.couple_id = v_cid;

    select coalesce(json_agg(to_json(t) order by t.date asc, t.created_at asc), '[]'::json)
      into v_milestones
    from public.milestones t
    where t.couple_id = v_cid;
  end if;

  -- 纪念日：取最早的那条 anniversary（历史上最多只有一条，多取也按日期升序稳）
  select to_json(t) into v_anniversary
  from public.milestones t
  where t.couple_id = v_cid and t.type = 'anniversary'
  order by t.date asc
  limit 1;

  -- 下次见面：今天及以后最近的一条 meetup（今天的也算「还没到」）
  select to_json(t) into v_next
  from public.milestones t
  where t.couple_id = v_cid and t.type = 'meetup' and t.date >= v_today
  order by t.date asc
  limit 1;

  return json_build_object(
    'user', json_build_object(
      'id', v_uid,
      'is_anonymous', coalesce((auth.jwt() -> 'is_anonymous')::bool, false)
    ),
    'couple', v_couple,
    'my_member', v_mine,
    'members', v_members,
    'milestones', v_milestones,
    'anniversary', v_anniversary,
    'next_meetup', v_next
  );
end;
$$;

-- 默认 PUBLIC 不带走：只放行真正带身份的调用方（匿名登录拿到的也是 authenticated 角色）
revoke all on function public.bootstrap_space(date) from public;
grant execute on function public.bootstrap_space(date) to anon, authenticated;

-- 让 PostgREST 立刻看见新函数（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';

-- ################ 034_photo_thumb_guard.sql ################
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

-- ################ 035_list_query_indexes.sql ################
-- ============================================================
--  035_list_query_indexes.sql · 列表查询索引：按空间 + 日期 / 按主表 id 的复合索引
--
--  顺序要求：必须在 003/004/014/017/019/027 之后（索引建在这些表上）；不跑功能正常，只是全表扫描
--  依赖迁移：001, 003, 004, 014, 017, 019, 027
--  幂等：是，可重复执行（全部使用 if not exists）
--
--  fingerprint: exists (select 1 from pg_indexes where schemaname='public' and indexname='moods_couple_date_idx')
--  check: moods_couple_date_idx 索引已存在
-- ============================================================

-- 为什么要有它：
--   前端的列表查询已经收窄成三种形态：
--     ① 主表分页：where couple_id = … order by created_at desc limit 18   → 032 已建复合索引
--     ② 心情按天：where couple_id = … and date = 'YYYY-MM-DD'             → 本文件的 moods 索引
--     ③ 副表按主表 id：where couple_id = … and message_id in (…)         → 本文件的 comments / reactions / hidden 索引
--   没有对应索引时，② ③ 都是全表扫描：空间里攒了几千条戳一戳之后，
--   「今天的心情」这种两行的查询也会把整张表翻一遍。
--
-- ⚠ 前置：请确认 032_paged_indexes.sql 已经在生产库跑过（它建的是 (couple_id, created_at)
--   复合索引，主表分页全靠它）。下面这条 SQL 可以直接核对，期望返回 4 行：
--     select indexname from pg_indexes
--     where schemaname = 'public'
--       and indexname in ('photos_couple_created_idx','messages_couple_created_idx',
--                         'diary_entries_couple_created_idx','period_logs_couple_created_idx');

set lock_timeout = '8s';

-- ---------- ① 按空间 + 日期：首页只查「今天的心情」 ----------
-- moods 的 unique 是 (couple_id, user_id, date)，按 date 过滤时前缀命不中（第二列是 user_id），
-- 所以要单独建一个 (couple_id, date) 的索引
create index if not exists moods_couple_date_idx
  on public.moods (couple_id, date desc);

-- ---------- ② 按空间 + 时间：戳一戳（首页只取最近一条，历史展开才翻） ----------
create index if not exists pokes_couple_created_idx
  on public.pokes (couple_id, created_at desc);

-- ---------- ③ 副表按主表 id：评论 / 回应 / 隐藏记录 ----------
-- 前端改成「只取当前页已加载的那些主表行」之后，查询形如
--   where couple_id = … and message_id in (…18 个 id…)
-- 前缀必须是 couple_id（RLS + 显式过滤都带它），第二列才是 message_id / diary_id。
create index if not exists message_comments_couple_message_idx
  on public.message_comments (couple_id, message_id);
create index if not exists message_reactions_couple_message_idx
  on public.message_reactions (couple_id, message_id);
create index if not exists message_hidden_couple_message_idx
  on public.message_hidden (couple_id, message_id);
create index if not exists diary_comments_couple_diary_idx
  on public.diary_comments (couple_id, diary_id);
create index if not exists diary_hidden_couple_diary_idx
  on public.diary_hidden (couple_id, diary_id);

-- ---------- ④ 相册列表：按空间 + 创建时间正序 ----------
create index if not exists albums_couple_created_idx
  on public.albums (couple_id, created_at);

-- 让 PostgREST 立刻看见新对象（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';

-- ################ 执行后核对（应全部为 t / 有行） ################
do $$
declare
  idx text[] := array[
    'photos_couple_created_idx','messages_couple_created_idx','diary_entries_couple_created_idx',
    'period_logs_couple_created_idx','message_comments_couple_created_idx','diary_comments_couple_created_idx',
    'moods_couple_date_idx','pokes_couple_created_idx','message_comments_couple_message_idx',
    'message_reactions_couple_message_idx','message_hidden_couple_message_idx',
    'diary_comments_couple_diary_idx','diary_hidden_couple_diary_idx','albums_couple_created_idx'
  ];
  missing text[];
begin
  select array_agg(x) into missing
  from unnest(idx) as x
  where not exists (select 1 from pg_indexes where schemaname='public' and indexname = x);
  if missing is null then
    raise notice '✅ 索引齐全：032 / 035 已应用';
  else
    raise notice '❌ 仍缺索引：%', array_to_string(missing, ', ');
  end if;
end $$;

select p.proname as 函数, pg_get_function_identity_arguments(p.oid) as 参数
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('bootstrap_space', 'photos_missing_thumb')
order by 1;
