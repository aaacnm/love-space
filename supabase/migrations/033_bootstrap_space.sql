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
