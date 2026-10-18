-- ============================================================
--  037_conflict_rooms.sql · 矛盾处理室：房间 + 轮流发言 + 计时 + 双方同意结束
--
--  顺序要求：必须在 001 之后（读 couples / members）
--  依赖迁移：001
--  幂等：是，可重复执行（create if not exists / create or replace / drop policy if exists）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='conflict_rooms')
--  check: public.conflict_rooms 表已存在
-- ============================================================

-- ============================================================
-- 为什么另起一套表，而不是复用 009 的 conflicts：
--   009 的 conflicts 是「一次争执一条记录」+ 双盲复盘表单（双方都交卷才互相可见），
--   语义跟「实时轮流发言的房间」完全不同：房间要的是「说一句对方立刻看到」。
--   混在一张表里会让 RLS 策略自相矛盾，所以这里新建，009 那批表原样保留不动。
--
-- 产品边界（写在这里是因为它决定了数据库约束）：
--   · 不判断对错、不强制和好：结束态叫 ended_agreed / timed_out，没有「已和好」这种状态；
--   · 严格一人一条轮流：发言权只在消息**成功写入**后才切换，校验失败一律不切换；
--   · 时间以服务端 expires_at 为准，客户端计时器只负责显示；
--   · 提前结束必须双方确认（一方申请 + 另一方同意）。
-- ============================================================

-- ---------- 1. 房间 ----------
create table if not exists public.conflict_rooms (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  invited_user_id uuid not null references auth.users(id) on delete cascade,
  -- invited      待对方加入（此时不计时）
  -- active       双方都在，倒计时进行中
  -- cancelled    发起者在对方加入前取消
  -- declined     对方拒绝
  -- invite_expired 邀请 24 小时未被处理
  -- ended_agreed 双方同意提前结束
  -- timed_out    时间到
  status text not null default 'invited'
    check (status in ('invited','active','cancelled','declined','invite_expired','ended_agreed','timed_out')),
  turn_user_id uuid references auth.users(id) on delete set null,
  duration_seconds int not null check (duration_seconds between 300 and 7200),
  invite_note text,
  invite_expires_at timestamptz,
  started_at timestamptz,
  expires_at timestamptz,
  end_requested_by uuid references auth.users(id) on delete set null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- 同一时间最多一个进行中的房间：并发创建时靠这个部分唯一索引挡住第二个。
-- ⚠ 不用 exclude constraint：PostgreSQL 的排除约束只支持 gist / spgist，btree 不行。
create unique index if not exists conflict_rooms_one_active
  on public.conflict_rooms (couple_id)
  where status in ('invited','active');

create index if not exists idx_conflict_rooms_couple
  on public.conflict_rooms (couple_id, created_at desc);

-- ---------- 2. 房间消息（一人一条、轮流） ----------
create table if not exists public.conflict_room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.conflict_rooms(id) on delete cascade,
  -- couple_id 冗余一份：RLS 与列表查询都要按空间过滤，别每次回查房间
  couple_id uuid not null references public.couples(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  -- 幂等 ID：客户端重试 / 重复点击不能把同一句话插两遍（可空）
  client_msg_id text,
  created_at timestamptz not null default now(),
  unique (room_id, client_msg_id)
);

create index if not exists idx_conflict_messages_room
  on public.conflict_room_messages (room_id, created_at);

-- ---------- 3. 结束后的复盘状态（双方各记各的，不覆盖对方） ----------
create table if not exists public.conflict_room_feedback (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.conflict_rooms(id) on delete cascade,
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- resolved 已解决 / eased 有所缓和 / need_more 还需要继续沟通 / none 暂时不想评价
  status text not null check (status in ('resolved','eased','need_more','none')),
  created_at timestamptz not null default now(),
  unique (room_id, user_id)
);

-- ---------- 4. 辱骂词表（可维护：SQL Editor 里增删即可生效） ----------
-- 只放明显攻击性的辱骂 / 羞辱 / 威胁 / 嘲讽词。
-- ⚠ 刻意不放「生气 / 不同意 / 受伤 / 难过」这类负面感受词：
--   产品要保护的是「表达真实感受」，不是把负面情绪本身删掉。
create table if not exists public.conflict_room_blocked_words (
  word text primary key,
  created_at timestamptz not null default now()
);

insert into public.conflict_room_blocked_words (word) values
  ('傻逼'), ('煞笔'), ('沙比'), ('傻b'), ('智障'), ('弱智'), ('脑残'),
  ('蠢货'), ('蠢猪'), ('废物'), ('废人'), ('贱人'), ('贱货'),
  ('婊子'), ('骚货'), ('狗东西'), ('猪脑子'), ('滚蛋'), ('滚出去'),
  ('去死'), ('死了算了'), ('杀了你'), ('弄死你'), ('打死你'),
  ('你他妈'), ('他妈的'), ('你妈的'), ('尼玛'), ('草泥马'), ('狗屎')
on conflict (word) do nothing;

-- ---------- 5. 过滤规则命中反馈（只记「命中了」，绝不记原文） ----------
create table if not exists public.conflict_room_filter_hits (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.conflict_rooms(id) on delete cascade,
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 6. RLS：参与者可读；**所有写入只走 RPC**
--
--    ⚠ 每张表都要 enable —— 只写 policy 不开开关等于没锁门（020 的教训）。
--    ⚠ 更关键的坑：Supabase 默认把 public schema 的写权限也给了 anon / authenticated，
--      如果这里写 `for all`，客户端就能绕过 RPC 直接 update 房间（改 turn_user_id /
--      status 就能连续发言、单方面结束房间）或直接 insert 消息。
--      所以做法是**两层**：
--        ① 策略只开 select（for all 一律不写）；
--        ② 表级权限收回写权限，只留 select 给 authenticated。
--      这样即使以后有人误加了写策略，也仍然写不进来。
-- ============================================================
alter table public.conflict_rooms enable row level security;
alter table public.conflict_room_messages enable row level security;
alter table public.conflict_room_feedback enable row level security;
alter table public.conflict_room_blocked_words enable row level security;
alter table public.conflict_room_filter_hits enable row level security;

-- 房间：两位参与者可读
drop policy if exists "conflict_rooms_all" on public.conflict_rooms;
drop policy if exists "conflict_rooms_read" on public.conflict_rooms;
create policy "conflict_rooms_read" on public.conflict_rooms
  for select
  using (
    couple_id = public.current_couple_id()
    and (created_by = auth.uid() or invited_user_id = auth.uid())
  );

-- 消息：能进房间的人才能看。写入只能经 send_conflict_room_message ——
-- 「轮到谁发言 / 房间是否还开着」是它在一个事务里判定的，客户端插不进来。
drop policy if exists "conflict_messages_all" on public.conflict_room_messages;
drop policy if exists "conflict_messages_read" on public.conflict_room_messages;
create policy "conflict_messages_read" on public.conflict_room_messages
  for select
  using (
    exists (
      select 1 from public.conflict_rooms r
      where r.id = room_id
        and r.couple_id = public.current_couple_id()
        and (r.created_by = auth.uid() or r.invited_user_id = auth.uid())
    )
  );

-- 复盘：房间内双方都能看；写入走 set_conflict_room_feedback
drop policy if exists "conflict_feedback_select" on public.conflict_room_feedback;
drop policy if exists "conflict_feedback_write" on public.conflict_room_feedback;
drop policy if exists "conflict_feedback_read" on public.conflict_room_feedback;
create policy "conflict_feedback_read" on public.conflict_room_feedback
  for select
  using (
    exists (
      select 1 from public.conflict_rooms r
      where r.id = room_id
        and r.couple_id = public.current_couple_id()
        and (r.created_by = auth.uid() or r.invited_user_id = auth.uid())
    )
  );

-- 词表：登录即可读（前端要先拦一次，别让用户等一个来回才知道被拦）；
-- 没有写策略 —— 只有 service_role 能增删，客户端改不了。
drop policy if exists "conflict_words_select" on public.conflict_room_blocked_words;
create policy "conflict_words_select" on public.conflict_room_blocked_words
  for select using (auth.uid() is not null);

-- 命中反馈：只能看（写入走 report_conflict_room_filter_hit，只记「命中了」不记原文）
drop policy if exists "conflict_hits_insert" on public.conflict_room_filter_hits;
drop policy if exists "conflict_hits_select" on public.conflict_room_filter_hits;
drop policy if exists "conflict_hits_read" on public.conflict_room_filter_hits;
create policy "conflict_hits_read" on public.conflict_room_filter_hits
  for select
  using (
    exists (
      select 1 from public.conflict_rooms r
      where r.id = room_id
        and r.couple_id = public.current_couple_id()
        and (r.created_by = auth.uid() or r.invited_user_id = auth.uid())
    )
  );

-- ---------- 表级权限：客户端只保留读，写入一律收回 ----------
-- Supabase 默认把 public schema 的 ALL 给了 anon / authenticated；
-- 不显式 revoke 的话，光靠「策略里没写 insert/update」是挡不住直写的。
do $$
declare
  t text;
begin
  foreach t in array array[
    'conflict_rooms',
    'conflict_room_messages',
    'conflict_room_feedback',
    'conflict_room_blocked_words',
    'conflict_room_filter_hits'
  ]
  loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end;
$$;

-- ============================================================
-- 7. RPC：所有状态流转都走服务端，客户端绕不过去
-- ============================================================

-- 服务器时间：客户端倒计时拿它校准本地时钟（不能信客户端计时器判断到期）
create or replace function public.server_now()
returns timestamptz
language sql
stable
set search_path = public
as $$ select now(); $$;

revoke all on function public.server_now() from public;
grant execute on function public.server_now() to anon, authenticated;

-- ---------- 发起邀请：只认「同一空间的另一位成员」，不信客户端传的用户 ID ----------
create or replace function public.create_conflict_room(p_duration_seconds int, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_couple  uuid := public.current_couple_id();
  v_partner uuid;
  v_room    uuid;
begin
  if v_uid is null then raise exception '请先登录'; end if;
  if v_couple is null then raise exception '你还没有加入情侣空间'; end if;

  select m.user_id into v_partner
    from public.members m
   where m.couple_id = v_couple and m.user_id <> v_uid
   limit 1;
  if v_partner is null then
    raise exception '空间里还没有另一位成员，暂时无法发起';
  end if;

  if exists (
    select 1 from public.conflict_rooms r
     where r.couple_id = v_couple and r.status in ('invited','active')
  ) then
    raise exception '已经有一个进行中的沟通房间了';
  end if;

  insert into public.conflict_rooms
    (couple_id, created_by, invited_user_id, duration_seconds, invite_note, invite_expires_at)
  values
    (v_couple, v_uid, v_partner,
     greatest(300, least(7200, coalesce(p_duration_seconds, 600))),
     nullif(btrim(coalesce(p_note, '')), ''),
     now() + interval '24 hours')
  returning id into v_room;

  return v_room;
end;
$$;

-- ---------- 对方响应邀请：加入（开始计时）/ 拒绝 ----------
create or replace function public.join_conflict_room(p_room_id uuid, p_accept boolean)
returns public.conflict_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.conflict_rooms;
begin
  if v_uid is null then raise exception '请先登录'; end if;

  select * into v_room from public.conflict_rooms where id = p_room_id for update;
  if not found then raise exception '房间不存在'; end if;
  if v_room.invited_user_id <> v_uid then
    raise exception '只有被邀请的一方可以响应';
  end if;
  if v_room.status <> 'invited' then
    raise exception '邀请已被处理（当前状态：%）', v_room.status;
  end if;
  -- ⚠ 邀请过期：**正常返回**，不能「更新完再 raise exception」——
  --   PL/pgSQL 抛异常会回滚整个函数所在的事务，那条 status = 'invite_expired'
  --   也一起被撤销，用户刷新后还会看到「待加入」。这里改成更新后直接返回结束态。
  if v_room.invite_expires_at is not null and v_room.invite_expires_at <= now() then
    update public.conflict_rooms
       set status = 'invite_expired', ended_at = now()
     where id = p_room_id
    returning * into v_room;
    return v_room;
  end if;

  if coalesce(p_accept, false) then
    update public.conflict_rooms
       set status = 'active',
           started_at = now(),
           expires_at = now() + make_interval(secs => duration_seconds),
           turn_user_id = created_by
     where id = p_room_id
    returning * into v_room;
  else
    update public.conflict_rooms
       set status = 'declined', ended_at = now()
     where id = p_room_id
    returning * into v_room;
  end if;
  return v_room;
end;
$$;

-- ---------- 发起者取消（对方还没加入） ----------
create or replace function public.cancel_conflict_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.conflict_rooms;
begin
  if v_uid is null then raise exception '请先登录'; end if;
  select * into v_room from public.conflict_rooms where id = p_room_id for update;
  if not found then raise exception '房间不存在'; end if;
  if v_room.created_by <> v_uid then raise exception '只有发起者可以取消邀请'; end if;
  if v_room.status <> 'invited' then raise exception '房间已经开始，无法取消'; end if;
  update public.conflict_rooms set status = 'cancelled', ended_at = now() where id = p_room_id;
end;
$$;

-- ---------- 发言：一个事务里完成「锁房间 → 校验 → 插入 → 切换发言权」 ----------
-- 并发安全：for update 行锁 + 事务，两台设备同时点发送只有一个能成功。
-- 幂等：带 client_msg_id 的重试不会插入第二条，也不会切换第二次发言权。
create or replace function public.send_conflict_room_message(
  p_room_id uuid,
  p_body text,
  p_client_msg_id text default null
)
returns public.conflict_room_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_room    public.conflict_rooms;
  v_body    text := coalesce(p_body, '');
  v_stripped text;
  v_partner uuid;
  v_msg    public.conflict_room_messages;
begin
  if v_uid is null then raise exception '请先登录'; end if;

  -- 1) 锁房间
  select * into v_room from public.conflict_rooms where id = p_room_id for update;
  if not found then raise exception '房间不存在'; end if;

  -- 2) 参与者
  if v_room.created_by <> v_uid and v_room.invited_user_id <> v_uid then
    raise exception '你不是这个房间的参与者';
  end if;

  -- 3) ⚠ 幂等必须**排在发言权之前**：
  --    消息其实写成功了、只是响应在网络里丢了的话，发言权已经切给对方，
  --    重试时若先判发言权就会得到「还没轮到你发言」，永远回不到已写入的那条。
  --    所以确认过房间和本人之后，先按 (room_id, client_msg_id, sender_user_id) 查重。
  if p_client_msg_id is not null then
    select * into v_msg
      from public.conflict_room_messages
     where room_id = p_room_id
       and client_msg_id = p_client_msg_id
       and sender_user_id = v_uid;
    if found then return v_msg; end if;
  end if;

  -- 4) 房间仍在进行中；离线期间过期的房间在这里被就地判超时。
  --    同样不能「更新完再 raise」（异常会回滚，状态落不住）→ 更新后返回 NULL，
  --    由调用方（前端拿到 data 为空）提示时间到并刷新。
  if v_room.status = 'active' and v_room.expires_at is not null and v_room.expires_at <= now() then
    update public.conflict_rooms
       set status = 'timed_out', ended_at = now()
     where id = p_room_id;
    return null;
  end if;
  if v_room.status <> 'active' then
    raise exception '房间已经结束（%）', v_room.status;
  end if;

  -- 5) 发言权
  if v_room.turn_user_id <> v_uid then
    raise exception '还没轮到你发言';
  end if;

  -- 6) 内容校验：至少 10 个字符，且不能是空白 / 纯标点
  v_body := btrim(v_body);
  if char_length(v_body) < 10 then
    raise exception '再多写一点吧，至少 10 个字（现在 % 个）', char_length(v_body);
  end if;
  -- 中文全角标点不在 POSIX [:punct:] 里（依赖 locale），这里显式补上常见那几个
  v_stripped := regexp_replace(v_body, '[\s[:punct:]、，。！？；：（）《》【】…—～“”‘’]', '', 'g');
  if char_length(v_stripped) = 0 then
    raise exception '内容不能只是标点或空白';
  end if;

  -- 7) 词表
  if exists (
    select 1 from public.conflict_room_blocked_words w
     where position(w.word in v_body) > 0
  ) then
    raise exception '请平复你的情绪，上头只会破坏双方的感情。';
  end if;

  -- 8) 插入消息
  insert into public.conflict_room_messages (room_id, couple_id, sender_user_id, body, client_msg_id)
  values (p_room_id, v_room.couple_id, v_uid, v_body, p_client_msg_id)
  returning * into v_msg;

  -- 9) 发言权原子切换给另一方
  v_partner := case when v_room.created_by = v_uid then v_room.invited_user_id else v_room.created_by end;
  update public.conflict_rooms set turn_user_id = v_partner where id = p_room_id;

  return v_msg;
end;
$$;

-- ---------- 申请提前结束 ----------
-- 对方已经申请过时，你再申请 = 双方都同意 → 直接结束
create or replace function public.request_conflict_room_end(p_room_id uuid)
returns public.conflict_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.conflict_rooms;
begin
  if v_uid is null then raise exception '请先登录'; end if;
  select * into v_room from public.conflict_rooms where id = p_room_id for update;
  if not found then raise exception '房间不存在'; end if;
  if v_room.created_by <> v_uid and v_room.invited_user_id <> v_uid then
    raise exception '你不是这个房间的参与者';
  end if;
  if v_room.status <> 'active' then raise exception '房间不在进行中'; end if;

  if v_room.end_requested_by is not null and v_room.end_requested_by <> v_uid then
    update public.conflict_rooms
       set status = 'ended_agreed', ended_at = now()
     where id = p_room_id
    returning * into v_room;
  else
    update public.conflict_rooms
       set end_requested_by = v_uid
     where id = p_room_id
    returning * into v_room;
  end if;
  return v_room;
end;
$$;

-- ---------- 回应提前结束申请（同意才结束；不同意则房间继续、发言权不变） ----------
create or replace function public.respond_conflict_room_end(p_room_id uuid, p_approve boolean)
returns public.conflict_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.conflict_rooms;
begin
  if v_uid is null then raise exception '请先登录'; end if;
  select * into v_room from public.conflict_rooms where id = p_room_id for update;
  if not found then raise exception '房间不存在'; end if;
  if v_room.created_by <> v_uid and v_room.invited_user_id <> v_uid then
    raise exception '你不是这个房间的参与者';
  end if;
  if v_room.status <> 'active' then raise exception '房间不在进行中'; end if;
  if v_room.end_requested_by is null then raise exception '当前没有待确认的结束申请'; end if;
  if v_room.end_requested_by = v_uid then raise exception '不能回应自己发起的申请'; end if;

  if coalesce(p_approve, false) then
    update public.conflict_rooms
       set status = 'ended_agreed', ended_at = now()
     where id = p_room_id
    returning * into v_room;
  else
    update public.conflict_rooms
       set end_requested_by = null
     where id = p_room_id
    returning * into v_room;
  end if;
  return v_room;
end;
$$;

-- ---------- 超时收尾：回来时（或 Cron）把该结束的房间落定 ----------
-- 只处理「我是参与者」的房间：别人空间的房间轮不到我来关。
create or replace function public.close_expired_conflict_rooms()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count int := 0;
  v_step  int;
begin
  if v_uid is null then raise exception '请先登录'; end if;

  update public.conflict_rooms
     set status = 'timed_out', ended_at = coalesce(ended_at, expires_at, now())
   where status = 'active'
     and expires_at is not null
     and expires_at <= now()
     and (created_by = v_uid or invited_user_id = v_uid);
  get diagnostics v_step = row_count;
  v_count := v_count + v_step;

  update public.conflict_rooms
     set status = 'invite_expired', ended_at = coalesce(ended_at, invite_expires_at, now())
   where status = 'invited'
     and invite_expires_at is not null
     and invite_expires_at <= now()
     and (created_by = v_uid or invited_user_id = v_uid);
  get diagnostics v_step = row_count;
  v_count := v_count + v_step;

  return v_count;
end;
$$;

-- ---------- 结束后的复盘状态（双方各记各的） ----------
create or replace function public.set_conflict_room_feedback(p_room_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.conflict_rooms;
begin
  if v_uid is null then raise exception '请先登录'; end if;
  select * into v_room from public.conflict_rooms where id = p_room_id;
  if not found then raise exception '房间不存在'; end if;
  if v_room.created_by <> v_uid and v_room.invited_user_id <> v_uid then
    raise exception '你不是这个房间的参与者';
  end if;
  if v_room.status not in ('ended_agreed','timed_out') then
    raise exception '沟通还没结束，先聊完再记录感受';
  end if;
  if p_status not in ('resolved','eased','need_more','none') then
    raise exception '未知的复盘状态';
  end if;

  insert into public.conflict_room_feedback (room_id, couple_id, user_id, status)
  values (p_room_id, v_room.couple_id, v_uid, p_status)
  on conflict (room_id, user_id) do update set status = excluded.status, created_at = now();
end;
$$;

-- ---------- 规则命中反馈（只记「命中了」，不记原文） ----------
create or replace function public.report_conflict_room_filter_hit(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.conflict_rooms;
begin
  if v_uid is null then raise exception '请先登录'; end if;
  select * into v_room from public.conflict_rooms where id = p_room_id;
  if not found then raise exception '房间不存在'; end if;
  if v_room.created_by <> v_uid and v_room.invited_user_id <> v_uid then
    raise exception '你不是这个房间的参与者';
  end if;
  insert into public.conflict_room_filter_hits (room_id, couple_id, user_id)
  values (p_room_id, v_room.couple_id, v_uid);
end;
$$;

-- 权限：只给登录用户（security definer 默认授给 public，收掉）
revoke all on function public.create_conflict_room(int, text) from public;
revoke all on function public.join_conflict_room(uuid, boolean) from public;
revoke all on function public.cancel_conflict_room(uuid) from public;
revoke all on function public.send_conflict_room_message(uuid, text, text) from public;
revoke all on function public.request_conflict_room_end(uuid) from public;
revoke all on function public.respond_conflict_room_end(uuid, boolean) from public;
revoke all on function public.close_expired_conflict_rooms() from public;
revoke all on function public.set_conflict_room_feedback(uuid, text) from public;
revoke all on function public.report_conflict_room_filter_hit(uuid) from public;

grant execute on function public.create_conflict_room(int, text) to authenticated;
grant execute on function public.join_conflict_room(uuid, boolean) to authenticated;
grant execute on function public.cancel_conflict_room(uuid) to authenticated;
grant execute on function public.send_conflict_room_message(uuid, text, text) to authenticated;
grant execute on function public.request_conflict_room_end(uuid) to authenticated;
grant execute on function public.respond_conflict_room_end(uuid, boolean) to authenticated;
grant execute on function public.close_expired_conflict_rooms() to authenticated;
grant execute on function public.set_conflict_room_feedback(uuid, text) to authenticated;
grant execute on function public.report_conflict_room_filter_hit(uuid) to authenticated;

-- ---------- 实时同步：另一端靠它刷新 ----------
alter table public.conflict_rooms replica identity full;
alter table public.conflict_room_messages replica identity full;
alter table public.conflict_room_feedback replica identity full;

do $$
declare
  t text;
begin
  foreach t in array array['conflict_rooms','conflict_room_messages','conflict_room_feedback']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台手动开启）', t;
    end;
  end loop;
end;
$$;

-- ---------- 邀请要送得出去：挂 026 的推送触发器 ----------
-- 房间只在「和好」页签里订阅，对方没打开那个页签就完全看不到邀请；
-- App 关掉时更是只能靠 Web Push。这里复用 026 的 fn_push_notify（它按 couple
-- 找到另一位推送）。⚠ 026 没跑时函数不存在 → 捕获异常跳过，不影响其它部分。
-- 通知正文由 push-send 生成，刻意只写「邀请你加入矛盾处理室 / 房间有新消息」，
-- 不含任何矛盾内容。
do $$
declare
  t text;
begin
  foreach t in array array['conflict_rooms','conflict_room_messages']
  loop
    begin
      execute format(
        'create trigger push_notify_%I after insert on public.%I for each row execute function public.fn_push_notify()',
        t, t
      );
    exception when others then
      raise notice '跳过 % 的推送触发器（可先跑 026_push.sql 再重跑本迁移）', t;
    end;
  end loop;
end;
$$;

-- 让 PostgREST 立刻看见新对象（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';
