-- ============================================================
--  矛盾处理室（037）上线自检脚本
--
--  用法：Supabase 控制台 → SQL Editor → 整段粘贴 → Run。
--  第 ② 段要先把自己空间两位成员的真实 uuid 填进去（从 auth.users 里查），
--  其余段落直接跑即可。
-- ============================================================

-- ---------- ① 五张表的 RLS 是否都真的开着 ----------
-- ⚠ 只看 policy 是不够的：RLS 关闭时 policy 根本不生效（020 的教训）。
select c.relname as 表名,
       c.relrowsecurity as rls已启用,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as 策略数
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'conflict_rooms',
    'conflict_room_messages',
    'conflict_room_feedback',
    'conflict_room_blocked_words',
    'conflict_room_filter_hits'
  )
order by 1;

-- ---------- ② RPC 是否都在 ----------
select p.proname as 函数, pg_get_function_identity_arguments(p.oid) as 参数
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like '%conflict_room%'
order by 1;

-- ---------- ③ 跨空间越权自检（把 uuid 换成真实值） ----------
-- 取两位成员的 uuid：
-- select u.id, m.couple_id, m.nickname
--   from auth.users u join public.members m on m.user_id = u.id;

-- 3.1 扮演「房间参与者」：能看到自己空间的房间与消息
-- begin;
--   set local role authenticated;
--   set local request.jwt.claim.sub = '<参与者 uuid>';
--   select count(*) as 应大于0_房间数 from public.conflict_rooms;
--   select count(*) as 应大于0_消息数 from public.conflict_room_messages;
-- rollback;

-- 3.2 扮演「另一个空间的人」：两张表都必须返回 0
-- begin;
--   set local role authenticated;
--   set local request.jwt.claim.sub = '<别的空间的用户 uuid>';
--   select count(*) as 必须为0_房间数 from public.conflict_rooms;
--   select count(*) as 必须为0_消息数 from public.conflict_room_messages;
-- rollback;

-- ---------- ③ 补：直写必须被拒绝（最关键的一条） ----------
-- 下面三段**各跑一次**（一次一段）：期望全部报错，报了才说明绕不过去。
--   权限被收回 → ERROR: permission denied for table …
--   策略没放行 → ERROR: new row violates row-level security policy
-- 两种都算通过；任何一段「成功执行」= 客户端能绕过轮流规则，**必须先修再上线**。

-- 3.3 直接改发言权（想连续发言的人会这么干）
-- begin;
--   set local role authenticated;
--   set local request.jwt.claim.sub = '<参与者 uuid>';
--   update public.conflict_rooms set turn_user_id = '<参与者 uuid>' where id = '<room uuid>';
-- rollback;

-- 3.4 直接改房间状态（想单方面结束房间的人会这么干）
-- begin;
--   set local role authenticated;
--   set local request.jwt.claim.sub = '<参与者 uuid>';
--   update public.conflict_rooms set status = 'ended_agreed' where id = '<room uuid>';
-- rollback;

-- 3.5 不经 RPC 直接插消息（想连发两条的人会这么干）
-- begin;
--   set local role authenticated;
--   set local request.jwt.claim.sub = '<参与者 uuid>';
--   insert into public.conflict_room_messages (room_id, couple_id, sender_user_id, body)
--   values ('<room uuid>', '<couple uuid>', '<参与者 uuid>', '这是一条绕过轮流规则的测试消息');
-- rollback;

-- ---------- ④ 轮流规则与幂等（手动验证模板） ----------
-- 4.1 非当前发言者发送 → 期望报错「还没轮到你发言」
-- begin;
--   set local role authenticated;
--   set local request.jwt.claim.sub = '<非发言者 uuid>';
--   select public.send_conflict_room_message('<room uuid>', '这是一句足够长的话用来测试权限', 'test-1');
-- rollback;

-- 4.2 少于 10 字 / 纯标点 → 期望报错
-- select public.send_conflict_room_message('<room uuid>', '气死我了', null);

-- 4.3 词表命中 → 期望报「请平复你的情绪，上头只会破坏双方的感情。」
-- select public.send_conflict_room_message('<room uuid>', '你就是个傻逼吧，我真的受够了', null);

-- 4.4 幂等：同一个 client_msg_id 连续发两次，消息表只应多出一条
-- select public.send_conflict_room_message('<room uuid>', '这是一句足够长的话用来测试幂等', 'same-id');
-- select public.send_conflict_room_message('<room uuid>', '这是一句足够长的话用来测试幂等', 'same-id');
-- select count(*) from public.conflict_room_messages where client_msg_id = 'same-id'; -- 期望 1

-- 4.5 并发（双开两个 SQL Editor 窗口同时执行同一条 send）：
--     send_conflict_room_message 里先 `select ... for update` 锁房间行，
--     第二个事务会等锁，醒来后 turn_user_id 已变 → 报「还没轮到你发言」。
--     最终只可能有一条消息写入（可用 4.4 的 count 断言为 1）。

-- ---------- ④ 补：邀请能不能送得出去 ----------
-- 期望两条触发器（026 的 fn_push_notify 已存在时才会挂上）
select c.relname as 表, t.tgname as 推送触发器
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal
  and c.relname in ('conflict_rooms', 'conflict_room_messages')
order by 1;

-- ---------- ⑤ 词表命中次数（含误拦截反馈） ----------
select r.id as 房间, count(h.id) as 命中反馈次数
from public.conflict_rooms r
left join public.conflict_room_filter_hits h on h.room_id = r.id
group by r.id
order by 2 desc;
