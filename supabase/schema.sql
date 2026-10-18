-- ============================================================
--  ⚠️ 自动生成文件，请勿手改 —— 由 migrations/ 目录生成
--     重跑命令：npm run db:sync
--
--  本文件内容 = 按顺序执行 supabase/migrations/ 下全部迁移后的结果。
--  用途：
--    1) 新 Supabase 项目一次性建库（SQL Editor 全选粘贴执行）
--    2) 想快速看清「最新库结构到底长什么样」
--
--  已上线环境不要直接跑这个文件！请用 `supabase db push`，或对照
--  supabase/check_migration_status.sql 找出没跑过的编号逐个补。
--  若一次执行多条 DDL 担心锁等待（40P01），改成按编号逐文件跑。
-- ============================================================

-- ------------------------------------------------------------
--  001_initial.sql · public.couples 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  001_initial.sql · 初始库结构（8 张表 + RLS + 存储 + 实时 + 情侣码函数）
--
--  顺序要求：第 1 个，必须先跑。这是接手本项目时 git HEAD 里 schema.sql 的原样快照
--  依赖迁移：无
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='couples')
--  check: public.couples 表已存在
-- ============================================================

-- ============================================================
--  恋爱手账 · Supabase 一次性初始化脚本
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  作用：建 8 张表 + 行级安全(RLS) + 图片存储 + 实时同步 + 情侣码函数
-- ============================================================

-- ---------- 1. 数据表 ----------

create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  password_hash text,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  nickname text not null,
  emoji text not null default '💕',
  city text,
  timezone text,
  created_at timestamptz not null default now()
);

create table if not exists public.milestones (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  type text not null check (type in ('anniversary', 'meetup')),
  title text not null,
  date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.diary_entries (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  mood text,
  created_at timestamptz not null default now()
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  caption text,
  created_at timestamptz not null default now()
);

create table if not exists public.wishes (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  category text not null check (category in ('place', 'food', 'thing')),
  title text not null,
  note text,
  status text not null default 'todo' check (status in ('todo', 'done')),
  done_by uuid references auth.users(id),
  done_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.timeline_events (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  title text not null,
  description text,
  date date not null,
  emoji text not null default '✨',
  created_at timestamptz not null default now()
);

-- ---------- 2. 辅助函数 ----------

-- 返回当前登录用户所属情侣空间 id（不属于任何空间则返回 null）
create or replace function public.current_couple_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select couple_id from public.members where user_id = auth.uid();
$$;

-- 生成 6 位易读情侣码（去掉易混淆字符 0/O/1/I/L）
create or replace function public.gen_couple_code()
returns text
language sql
as $$
  select string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random()*32)::int, 1), '')
  from generate_series(1, 6);
$$;

-- 创建空间（供第一个使用）
create or replace function public.create_couple(
  p_my_nickname text,
  p_my_emoji text default '💕',
  p_my_city text default null,
  p_my_timezone text default null,
  p_anniversary_date date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_couple_id uuid;
  v_code text;
begin
  loop
    v_code := public.gen_couple_code();
    exit when not exists (select 1 from public.couples where code = v_code);
  end loop;

  insert into public.couples (code) values (v_code) returning id into v_couple_id;

  insert into public.members (couple_id, user_id, nickname, emoji, city, timezone)
  values (v_couple_id, auth.uid(), p_my_nickname, p_my_emoji, p_my_city, p_my_timezone);

  if p_anniversary_date is not null then
    insert into public.milestones (couple_id, type, title, date)
    values (v_couple_id, 'anniversary', '在一起', p_anniversary_date);
  end if;

  return json_build_object('id', v_couple_id, 'code', v_code);
end;
$$;

-- 加入空间（供第二个人输入情侣码）
create or replace function public.join_couple(
  p_code text,
  p_nickname text,
  p_emoji text default '💕',
  p_city text default null,
  p_timezone text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_couple_id uuid;
begin
  select id into v_couple_id from public.couples where upper(code) = upper(trim(p_code));
  if v_couple_id is null then
    raise exception '无效的情侣码，请检查后重试';
  end if;

  -- 每个空间最多两人：满员则拒绝加入（排除当前用户自己，允许本人重新加入）
  if (select count(*) from public.members where couple_id = v_couple_id and user_id <> auth.uid()) >= 2 then
    raise exception '该空间已满员，最多只能两人加入';
  end if;

  -- 一个用户只属于一个空间：先清理旧关系再插入
  delete from public.members where user_id = auth.uid();

  insert into public.members (couple_id, user_id, nickname, emoji, city, timezone)
  values (v_couple_id, auth.uid(), p_nickname, p_emoji, p_city, p_timezone);

  return json_build_object('id', v_couple_id, 'code', (select code from public.couples where id = v_couple_id));
end;
$$;

grant execute on function public.current_couple_id() to anon, authenticated;
grant execute on function public.create_couple(text, text, text, text, date) to anon, authenticated;
grant execute on function public.join_couple(text, text, text, text, text) to anon, authenticated;

-- ---------- 3. 行级安全 (RLS) ----------

alter table public.couples enable row level security;
alter table public.members enable row level security;
alter table public.milestones enable row level security;
alter table public.diary_entries enable row level security;
alter table public.photos enable row level security;
alter table public.wishes enable row level security;
alter table public.messages enable row level security;
alter table public.timeline_events enable row level security;

-- 先清理旧的同名策略，保证脚本可重复运行（幂等）
drop policy if exists "couples_select" on public.couples;
drop policy if exists "members_select" on public.members;
drop policy if exists "members_update_own" on public.members;
drop policy if exists "members_delete_other" on public.members;
drop policy if exists "milestones_all" on public.milestones;
drop policy if exists "diary_all" on public.diary_entries;
drop policy if exists "photos_all" on public.photos;
drop policy if exists "wishes_all" on public.wishes;
drop policy if exists "messages_all" on public.messages;
drop policy if exists "timeline_all" on public.timeline_events;

-- couples：只有本空间成员可读（创建/加入由上面的 security definer 函数完成）
create policy "couples_select" on public.couples
  for select using (id = public.current_couple_id());

-- members：本空间成员互相可见；只能改自己的资料；可移除同空间其他成员
create policy "members_select" on public.members
  for select using (couple_id = public.current_couple_id());
create policy "members_update_own" on public.members
  for update using (user_id = auth.uid());
create policy "members_delete_other" on public.members
  for delete using (couple_id = public.current_couple_id() and user_id <> auth.uid());
-- 允许用户主动退出：删除自己的成员记录（空间与所有内容保留，情侣码仍可重新加入）
drop policy if exists "members_delete_self" on public.members;
create policy "members_delete_self" on public.members
  for delete using (user_id = auth.uid());

-- 以下业务表：只有本空间成员可读写
create policy "milestones_all" on public.milestones
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

create policy "diary_all" on public.diary_entries
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

create policy "photos_all" on public.photos
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

create policy "wishes_all" on public.wishes
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

create policy "messages_all" on public.messages
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

create policy "timeline_all" on public.timeline_events
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ---------- 4. 图片存储 Storage ----------

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

-- 公开读（图片 URL 通过随机文件名保护），登录用户可上传/删除
drop policy if exists "photos_read" on storage.objects;
drop policy if exists "photos_insert" on storage.objects;
drop policy if exists "photos_delete" on storage.objects;

create policy "photos_read" on storage.objects
  for select using (bucket_id = 'photos');
create policy "photos_insert" on storage.objects
  for insert with check (bucket_id = 'photos' and auth.uid() is not null);
create policy "photos_delete" on storage.objects
  for delete using (bucket_id = 'photos' and auth.uid() is not null);

-- ---------- 5. 实时同步 Realtime ----------
-- 逐表加入 supabase_realtime publication；若你的版本已无该 publication，
-- 可到后台 Database -> Replication -> supabase_realtime 手动勾选，效果相同。
-- 这里对每张表单独容错，重复运行或个别已添加都不会中断。

do $$
declare
  t text;
begin
  foreach t in array array['members','milestones','diary_entries','photos','wishes','messages','timeline_events']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台手动开启）', t;
    end;
  end loop;
end;
$$;

-- ---------- 6. 头像上传 Storage ----------

-- members 增加头像路径字段（可空；为 null 时前端回退到 emoji）
alter table public.members add column if not exists avatar_path text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- 公开读（随机文件名保护），登录用户可上传/删除
drop policy if exists "avatars_read" on storage.objects;
drop policy if exists "avatars_insert" on storage.objects;
drop policy if exists "avatars_delete" on storage.objects;

create policy "avatars_read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatars_insert" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.uid() is not null);
create policy "avatars_delete" on storage.objects
  for delete using (bucket_id = 'avatars' and auth.uid() is not null);

-- ------------------------------------------------------------
--  002_pokes.sql · public.pokes 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  002_pokes.sql · 「想你了」戳一戳
--
--  顺序要求：无特殊要求
--  依赖迁移：001（couples / auth.users）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='pokes')
--  check: public.pokes 表已存在
-- ============================================================

-- ============================================================
--  迁移脚本：「想你了」戳一戳
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  （幂等，重复运行不会报错）
-- ============================================================

-- ---------- 1. 数据表 ----------

create table if not exists public.pokes (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- 2. 行级安全 ----------

alter table public.pokes enable row level security;

drop policy if exists "pokes_all" on public.pokes;
create policy "pokes_all" on public.pokes
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ---------- 3. 实时同步 ----------
-- 关键：新表必须加入 realtime publication，否则对方收不到实时推送

do $$
begin
  begin
    alter publication supabase_realtime add table public.pokes;
  exception when others then
    raise notice '跳过 realtime 表 pokes（可能已添加，可到后台 Database -> Replication 手动开启）';
  end;
end;
$$;

-- ------------------------------------------------------------
--  003_interactive.sql · pokes.kind 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  003_interactive.sql · 互动三件套：心情 / 问答 / 转盘
--
--  顺序要求：必须在 002 之后（给 pokes 加 kind 列）
--  依赖迁移：001, 002
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='pokes' and column_name='kind')
--  check: pokes.kind 列已存在
-- ============================================================

-- ============================================================
--  迁移脚本：互动三件套
--    1) 今日心情速递  moods
--    2) 每日问答      qna_answers
--    3) 一起决定转盘  spins
--  外加给 pokes 增加 kind 字段（poke 戳一戳 / comfort 摸摸头）
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
-- ============================================================

-- ---------- 1. 今日心情（每人每天一条，重复提交即覆盖） ----------

create table if not exists public.moods (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mood text not null,
  note text,
  date date not null,
  created_at timestamptz not null default now(),
  unique (couple_id, user_id, date)
);

-- ---------- 2. 每日问答（每人每天每题一条） ----------

create table if not exists public.qna_answers (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  question_date date not null,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now(),
  unique (couple_id, user_id, question_date)
);

-- ---------- 3. 一起决定转盘 ----------

create table if not exists public.spins (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  options text[] not null default '{}',
  result text not null,
  created_at timestamptz not null default now()
);

-- ---------- 4. 戳一戳表（若之前的迁移没跑过，这里一并补建） ----------

create table if not exists public.pokes (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'poke',
  created_at timestamptz not null default now()
);

alter table public.pokes add column if not exists kind text not null default 'poke';

alter table public.pokes enable row level security;

drop policy if exists "pokes_all" on public.pokes;
create policy "pokes_all" on public.pokes
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

do $$
begin
  begin
    alter publication supabase_realtime add table public.pokes;
  exception when others then
    raise notice '跳过 realtime 表 pokes（可到后台手动开启）';
  end;
end;
$$;

-- ---------- 5. 行级安全 ----------

alter table public.moods enable row level security;
alter table public.qna_answers enable row level security;
alter table public.spins enable row level security;

drop policy if exists "moods_all" on public.moods;
create policy "moods_all" on public.moods
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "qna_all" on public.qna_answers;
create policy "qna_all" on public.qna_answers
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "spins_all" on public.spins;
create policy "spins_all" on public.spins
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ---------- 6. 实时同步 ----------

do $$
declare
  t text;
begin
  foreach t in array array['moods','qna_answers','spins']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台 Database -> Replication 手动开启）', t;
    end;
  end loop;
end;
$$;

-- ------------------------------------------------------------
--  004_diary.sql · diary_entries.images 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  004_diary.sql · 日记：多图 + 评论 + 私密日记
--
--  顺序要求：无特殊要求
--  依赖迁移：001（diary_entries）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='diary_entries' and column_name='images')
--  check: diary_entries.images 列已存在
-- ============================================================

-- ============================================================
--  日记增强：图片 / 评论 / 各自独立隐藏 / 只能删自己的日记
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）
-- ============================================================

-- ---------- 1. 日记配图（最多 3 张，存 storage 路径数组） ----------

alter table public.diary_entries add column if not exists images text[] not null default '{}';

-- ---------- 2. 日记评论 ----------

create table if not exists public.diary_comments (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  diary_id uuid not null references public.diary_entries(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_diary_comments_diary on public.diary_comments(diary_id);

-- ---------- 3. 日记隐藏（每人独立一份，互不影响） ----------

create table if not exists public.diary_hidden (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  diary_id uuid not null references public.diary_entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (diary_id, user_id)
);

-- ---------- 4. 行级安全 ----------

alter table public.diary_comments enable row level security;
alter table public.diary_hidden enable row level security;

-- 日记：把原来一条「本空间可读写全部」拆成细粒度策略
drop policy if exists "diary_all" on public.diary_entries;
drop policy if exists "diary_select" on public.diary_entries;
drop policy if exists "diary_insert" on public.diary_entries;
drop policy if exists "diary_update" on public.diary_entries;
drop policy if exists "diary_delete" on public.diary_entries;

-- 读：本空间成员都能看（「隐藏」是前端按人过滤的，不影响对方）
create policy "diary_select" on public.diary_entries
  for select using (couple_id = public.current_couple_id());

-- 写：只能以自己身份发布
create policy "diary_insert" on public.diary_entries
  for insert with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

create policy "diary_update" on public.diary_entries
  for update using (couple_id = public.current_couple_id() and author_user_id = auth.uid())
  with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

-- 删：★ 只能删自己写的日记
create policy "diary_delete" on public.diary_entries
  for delete using (couple_id = public.current_couple_id() and author_user_id = auth.uid());

-- 评论：本空间可读、自己身份发布、只能删自己发的
drop policy if exists "diary_comments_all" on public.diary_comments;
drop policy if exists "diary_comments_select" on public.diary_comments;
drop policy if exists "diary_comments_insert" on public.diary_comments;
drop policy if exists "diary_comments_delete" on public.diary_comments;

create policy "diary_comments_select" on public.diary_comments
  for select using (couple_id = public.current_couple_id());

create policy "diary_comments_insert" on public.diary_comments
  for insert with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

create policy "diary_comments_delete" on public.diary_comments
  for delete using (author_user_id = auth.uid());

-- 隐藏：★ 只能读写自己的隐藏记录（对方看不到你隐藏了什么）
drop policy if exists "diary_hidden_own" on public.diary_hidden;

create policy "diary_hidden_own" on public.diary_hidden
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and couple_id = public.current_couple_id());

-- ---------- 5. 实时同步 ----------

do $$
declare
  t text;
begin
  foreach t in array array['diary_comments','diary_hidden']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台手动开启）', t;
    end;
  end loop;
end;
$$;

-- ------------------------------------------------------------
--  005_realtime_replica.sql · public.photos 已是 REPLICA IDENTITY FULL
-- ------------------------------------------------------------

-- ============================================================
--  005_realtime_replica.sql · 实时同步修复：删除事件带上完整旧记录
--
--  顺序要求：必须在所有会用到 DELETE 监听的表建完之后；新增表要在对应迁移里各自设 REPLICA IDENTITY FULL
--  依赖迁移：001, 004
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='photos' and c.relreplident='f')
--  check: public.photos 已是 REPLICA IDENTITY FULL
-- ============================================================

-- ============================================================
--  实时同步修复：删除操作对方不刷新也能立刻消失
--
--  问题：Postgres 的 logical replication 在 DELETE 时默认只发送主键
--        （REPLICA IDENTITY DEFAULT），所以 Realtime 里的
--        filter: couple_id=eq.<id> 匹配不到删除事件，消息被服务端丢掉，
--        对方只能手动刷新才看得到日记/照片等被删掉。
--
--  解决：把表设为 REPLICA IDENTITY FULL，DELETE/UPDATE 的旧记录会带上
--        所有列，couple_id 过滤即可正常命中。
--
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
-- ============================================================

alter table public.members            replica identity full;
alter table public.milestones         replica identity full;
alter table public.diary_entries      replica identity full;
alter table public.diary_comments     replica identity full;
alter table public.diary_hidden       replica identity full;
alter table public.photos             replica identity full;
alter table public.wishes             replica identity full;
alter table public.messages           replica identity full;
alter table public.timeline_events    replica identity full;
alter table public.pokes              replica identity full;
alter table public.moods              replica identity full;

-- 校验：下面这条查询应返回上面所有表的 relreplident = 'f'
-- select relname, relreplident from pg_class
--  where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;

-- ------------------------------------------------------------
--  006_albums_table.sql · public.albums 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  006_albums_table.sql · 图集 ①：albums 表
--
--  顺序要求：图集三步（006 → 007 → 008）必须按序连续执行
--  依赖迁移：001
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='albums')
--  check: public.albums 表已存在
-- ============================================================

-- ============================================================
--  图集功能 · 第 1 步（共 3 步）：建表
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。三步依次跑完：a -> b -> c
-- ============================================================

-- ---------- 1. 图集表 ----------

create table if not exists public.albums (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
-- ------------------------------------------------------------
--  附：原 migration_albums.sql 的拆分说明
-- ------------------------------------------------------------
-- ============================================================
--  图集功能迁移 —— 已拆分为三个小文件，请按顺序分别执行
--
--    supabase/006_albums_table.sql   建 albums 表
--    supabase/007_albums_photo_ref.sql   photos 加 album_id 字段 + 索引
--    supabase/008_albums_rls.sql   RLS 策略 + 实时同步 + replica identity
--
--  为什么要拆：SQL Editor 会把整个脚本放进一个事务执行，
--  一次性跑多条 DDL 时持锁时间过长，容易被其他会话（比如你开着
--  的应用页面在实时读 photos 表）堵住，触发 40P01 deadlock detected。
--  拆成每条只持锁几十毫秒后，基本不会再冲突。
-- ============================================================

-- ------------------------------------------------------------
--  007_albums_photo_ref.sql · photos.album_id 列已存在
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
--  008_albums_rls.sql · albums 的 albums_all 策略已存在
-- ------------------------------------------------------------

-- ============================================================
--  008_albums_rls.sql · 图集 ③：RLS 策略 + 实时同步
--
--  顺序要求：必须在 006、007 之后
--  依赖迁移：006, 007
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_policies where schemaname='public' and tablename='albums' and policyname='albums_all')
--  check: albums 的 albums_all 策略已存在
-- ============================================================

-- ============================================================
--  图集功能 · 第 3 步（共 3 步）：权限 + 实时同步
-- ============================================================

-- ---------- 行级安全 ----------

alter table public.albums enable row level security;

drop policy if exists "albums_all" on public.albums;

create policy "albums_all" on public.albums
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- photos 沿用已有的 photos_all 策略（本空间可读写），无需改动

-- ---------- 实时同步 ----------

do $$
begin
  begin
    alter publication supabase_realtime add table public.albums;
  exception when others then
    raise notice '跳过 realtime 表 albums（可到后台 Database -> Replication 手动开启）';
  end;
end;
$$;

-- 让 DELETE / UPDATE 事件带上完整旧记录（否则对方删除不同步）
alter table public.photos replica identity full;
alter table public.albums  replica identity full;

-- ------------------------------------------------------------
--  009_conflicts_tables.sql · public.conflicts 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  009_conflicts_tables.sql · 和好 ①：4 张表 + 双盲复盘策略
--
--  顺序要求：两步（009 → 010）按序执行
--  依赖迁移：001
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='conflicts')
--  check: public.conflicts 表已存在
-- ============================================================

-- ============================================================
--  「和好」栏目 · 第 1 步（共 2 步）：建表 + 行级安全
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。跑完继续跑 010_conflicts_realtime.sql
-- ============================================================

-- ---------- 1. 冷战/破冰事件流水 ----------
-- kind: 'upset' = 记录一次不愉快（进入冷战）；'peace' = 我要和好
-- 状态机：取最近一条事件，是 upset 则「冷战中」，是 peace 则「风和日丽」

create table if not exists public.makeups (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'peace' check (kind in ('upset', 'peace')),
  created_at timestamptz not null default now()
);

create index if not exists idx_makeups_couple on public.makeups(couple_id, created_at desc);

-- ---------- 2. 矛盾事件（一次争执一条） ----------

create table if not exists public.conflicts (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  title text not null,
  happened_at date not null default current_date,
  created_at timestamptz not null default now()
);

-- ---------- 3. 复盘（每人写一份，双方都交卷才互相可见） ----------

create table if not exists public.conflict_reviews (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  conflict_id uuid not null references public.conflicts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  what text,      -- 发生了什么
  feeling text,   -- 我当时的感受
  mine text,      -- 我也有不对的地方
  hope text,      -- 希望下次怎么做
  created_at timestamptz not null default now(),
  unique (conflict_id, user_id)
);

-- ---------- 4. 我们的约定 ----------

create table if not exists public.promises (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  content text not null,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- 5. 行级安全 ----------

alter table public.makeups enable row level security;
alter table public.conflicts enable row level security;
alter table public.conflict_reviews enable row level security;
alter table public.promises enable row level security;

drop policy if exists "makeups_all" on public.makeups;
create policy "makeups_all" on public.makeups
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "promises_all" on public.promises;
create policy "promises_all" on public.promises
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "conflicts_all" on public.conflicts;
create policy "conflicts_all" on public.conflicts
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- 复盘：核心的「双盲」策略
--   我自己那份随时可见；对方那份只有在我也为这条矛盾交了卷之后才可见
drop policy if exists "reviews_select" on public.conflict_reviews;
create policy "reviews_select" on public.conflict_reviews
  for select using (
    couple_id = public.current_couple_id()
    and (
      user_id = auth.uid()
      or exists (
        select 1 from public.conflict_reviews mine
        where mine.conflict_id = public.conflict_reviews.conflict_id
          and mine.user_id = auth.uid()
      )
    )
  );

drop policy if exists "reviews_insert" on public.conflict_reviews;
create policy "reviews_insert" on public.conflict_reviews
  for insert with check (
    couple_id = public.current_couple_id()
    and user_id = auth.uid()
  );

drop policy if exists "reviews_update" on public.conflict_reviews;
create policy "reviews_update" on public.conflict_reviews
  for update using (couple_id = public.current_couple_id() and user_id = auth.uid())
  with check (couple_id = public.current_couple_id() and user_id = auth.uid());

drop policy if exists "reviews_delete" on public.conflict_reviews;
create policy "reviews_delete" on public.conflict_reviews
  for delete using (couple_id = public.current_couple_id() and user_id = auth.uid());
-- ------------------------------------------------------------
--  附：原 migration_conflicts.sql 的拆分说明
-- ------------------------------------------------------------
-- ============================================================
--  「和好」栏目迁移 —— 拆成两个小脚本，请按顺序分别执行
--
--    supabase/009_conflicts_tables.sql   四张表 + 行级安全（含复盘双盲策略）
--    supabase/010_conflicts_realtime.sql   实时同步 + replica identity
--
--  为什么要拆：SQL Editor 把整个脚本放进一个事务执行，一次跑多条 DDL
--  时持锁过久，容易和并发会话互相等待触发 40P01 deadlock detected。
--
--  四张表：
--    makeups          冷战/破冰事件流水（upset / peace）
--    conflicts       矛盾事件（一次争执一条）
--    conflict_reviews 复盘（每人一份，双方交卷后才互相可见）
--    promises        我们的约定
-- ============================================================

-- ------------------------------------------------------------
--  010_conflicts_realtime.sql · public.conflicts 已是 REPLICA IDENTITY FULL
-- ------------------------------------------------------------

-- ============================================================
--  010_conflicts_realtime.sql · 和好 ②：REPLICA IDENTITY FULL
--
--  顺序要求：必须在 009 之后
--  依赖迁移：009
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='conflicts' and c.relreplident='f')
--  check: public.conflicts 已是 REPLICA IDENTITY FULL
-- ============================================================

-- ============================================================
--  「和好」栏目 · 第 2 步（共 2 步）：实时同步
-- ============================================================

-- ---------- 加入 realtime 推送 ----------

do $$
declare
  t text;
begin
  foreach t in array array['makeups','conflicts','conflict_reviews','promises']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台 Database -> Replication 手动开启）', t;
    end;
  end loop;
end;
$$;

-- 让 DELETE / UPDATE 带上完整旧记录，否则对方必须刷新才能看到变化
alter table public.makeups          replica identity full;
alter table public.conflicts        replica identity full;
alter table public.conflict_reviews replica identity full;
alter table public.promises         replica identity full;

-- ------------------------------------------------------------
--  011_signal_tables.sql · public.signals 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  011_signal_tables.sql · 信号灯 ①：signals / steps / checkins 表
--
--  顺序要求：两步（011 → 012）按序执行
--  依赖迁移：001
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='signals')
--  check: public.signals 表已存在
-- ============================================================

-- ============================================================
--  「和好」轻量版 · 第 1 步（共 2 步）：建 3 张新表 + 行级安全
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。跑完继续跑 012_signal_realtime.sql
-- ============================================================

-- ---------- 1. 信号灯（每人一条最新状态，前端判断 12 小时过期） ----------
-- kind: green = 消气了 / yellow = 还在气但想被哄 / red = 先别理我

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('green', 'yellow', 'red')),
  created_at timestamptz not null default now()
);

create index if not exists idx_signals_couple on public.signals(couple_id, created_at desc);

-- ---------- 2. 台阶卡（冷战中的一键台阶，对方「收下」即完成闭环） ----------
-- kind: tea = 递杯奶茶 / hug = 要一个抱抱 / words = 发句软话
-- accepted_at 为空 = 已递出还没被收下

create table if not exists public.steps (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('tea', 'hug', 'words')),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_steps_couple on public.steps(couple_id, created_at desc);

-- ---------- 3. 次日一问（代替复盘表单：一个单选 + 可选雷区标签） ----------
-- resolved: true = 过去了 / false = 还没有；tag 仅在 resolved 时可选填

create table if not exists public.conflict_checkins (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  conflict_id uuid not null references public.conflicts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  resolved boolean not null,
  tag text,
  created_at timestamptz not null default now(),
  unique (conflict_id, user_id)
);

-- ---------- 4. 行级安全 ----------

alter table public.signals enable row level security;
alter table public.steps enable row level security;
alter table public.conflict_checkins enable row level security;

drop policy if exists "signals_all" on public.signals;
create policy "signals_all" on public.signals
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "steps_all" on public.steps;
create policy "steps_all" on public.steps
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "checkins_all" on public.conflict_checkins;
create policy "checkins_all" on public.conflict_checkins
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ------------------------------------------------------------
--  012_signal_realtime.sql · public.signals 已是 REPLICA IDENTITY FULL
-- ------------------------------------------------------------

-- ============================================================
--  012_signal_realtime.sql · 信号灯 ②：REPLICA IDENTITY FULL + 加入 publication
--
--  顺序要求：必须在 011 之后
--  依赖迁移：011
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='signals' and c.relreplident='f')
--  check: public.signals 已是 REPLICA IDENTITY FULL
-- ============================================================

-- ============================================================
--  「和好」轻量版 · 第 2 步（共 2 步）：实时同步 + 删除事件完整化
--  在 011_signal_tables.sql 成功后运行
-- ============================================================

alter table public.signals replica identity full;
alter table public.steps replica identity full;
alter table public.conflict_checkins replica identity full;

do $$
declare
  pub text;
  t text;
begin
  select pubname into pub from pg_publication where pubname = 'supabase_realtime';
  if pub is null then
    raise notice 'no supabase_realtime publication, skip';
    return;
  end if;

  foreach t in array array['signals', 'steps', 'conflict_checkins']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = pub and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication %I add table public.%I', pub, t);
    else
      raise notice 'table % already in publication', t;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
--  013_voice.sql · messages.voice_path 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  013_voice.sql · 语音留言：messages 语音字段 + voice 桶
--
--  顺序要求：无特殊要求
--  依赖迁移：001（messages）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='voice_path')
--  check: messages.voice_path 列已存在
-- ============================================================

-- ============================================================
-- 语音留言：messages 表加语音字段 + voice 存储桶
-- 幂等脚本，可重复执行
-- ============================================================

-- 1. messages 表：语音文件的存储路径 + 时长（秒）
alter table public.messages
  add column if not exists voice_path text,
  add column if not exists voice_seconds int;

-- 2. voice 桶：公开读（随机文件名保护），登录用户可上传/删除
insert into storage.buckets (id, name, public)
values ('voice', 'voice', true)
on conflict (id) do nothing;

drop policy if exists "voice_read" on storage.objects;
drop policy if exists "voice_insert" on storage.objects;
drop policy if exists "voice_delete" on storage.objects;

create policy "voice_read" on storage.objects
  for select using (bucket_id = 'voice');

create policy "voice_insert" on storage.objects
  for insert with check (bucket_id = 'voice' and auth.uid() is not null);

create policy "voice_delete" on storage.objects
  for delete using (bucket_id = 'voice' and auth.uid() is not null);

-- messages 已在 realtime publication 且 replica identity full，无需额外处理

-- ------------------------------------------------------------
--  014_message_hidden.sql · public.message_hidden 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  014_message_hidden.sql · 留言删除（软删）:message_hidden 表
--
--  顺序要求：必须在 025 之前（后者给它加策略）
--  依赖迁移：001（messages）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='message_hidden')
--  check: public.message_hidden 表已存在
-- ============================================================

-- 留言板改造：删除只对自己生效 + 各自独立隐藏
-- 说明：语音留言不再真删（TA 还要能听到），改用本表按人记录"我看不见了"

create table if not exists public.message_hidden (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- false = 隐藏（可恢复，出现在"已隐藏"里）；true = 删除（只对自己消失，不出现在已隐藏里）
  permanent boolean not null default false,
  created_at timestamptz not null default now(),
  unique (message_id, user_id)
);

alter table public.message_hidden enable row level security;
alter table public.message_hidden replica identity full;

-- 只能读写自己的那一份
drop policy if exists "message_hidden_own" on public.message_hidden;
create policy "message_hidden_own" on public.message_hidden
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and couple_id = public.current_couple_id());

-- 实时同步（已存在会被跳过，不报错）
do $$
begin
  begin
    alter publication supabase_realtime add table public.message_hidden;
  exception when others then
    raise notice '跳过 realtime 表 message_hidden（可到后台手动开启）';
  end;
end;
$$;

-- ------------------------------------------------------------
--  015_trash.sql · public.trash_bin 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  015_trash.sql · 最近删除 ①：trash_bin + 日记软删
--
--  顺序要求：无特殊要求
--  依赖迁移：001, 004
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='trash_bin')
--  check: public.trash_bin 表已存在
-- ============================================================

-- 最近删除（回收站）：删掉的日记 / 留言先在这里躺 3 天，期间可恢复，到期自动清除
-- 日记：软删除（deleted_at 标记，双人都看不到，但数据还在，评论也保留）
-- 留言：删除本来就只对自己生效，这里记一条回收站条目；音频保留给 TA 听

alter table public.diary_entries add column if not exists deleted_at timestamptz;

create table if not exists public.trash_bin (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  kind text not null check (kind in ('diary', 'message')),
  ref_id uuid not null,
  deleted_by uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 days'
);

create index if not exists idx_trash_bin_ref on public.trash_bin(ref_id);

alter table public.trash_bin enable row level security;
alter table public.trash_bin replica identity full;

-- 日记型：双方都看得到（删掉对两个人都生效）
-- 留言型：删除只对自己生效，所以只有自己能看见这条回收站记录
drop policy if exists "trash_select" on public.trash_bin;
create policy "trash_select" on public.trash_bin
  for select using (couple_id = public.current_couple_id() and (kind = 'diary' or deleted_by = auth.uid()));

drop policy if exists "trash_insert" on public.trash_bin;
create policy "trash_insert" on public.trash_bin
  for insert with check (couple_id = public.current_couple_id() and deleted_by = auth.uid());

drop policy if exists "trash_delete" on public.trash_bin;
create policy "trash_delete" on public.trash_bin
  for delete using (couple_id = public.current_couple_id());

-- 已进回收站的日记（deleted_at 非空）允许双方彻底清除；
-- 否则按原策略只有作者能删，对方那边 3 天后就清不掉
drop policy if exists "diary_delete_trashed" on public.diary_entries;
create policy "diary_delete_trashed" on public.diary_entries
  for delete using (couple_id = public.current_couple_id() and deleted_at is not null);

-- 实时同步（已存在会被跳过，不报错）
do $$
begin
  begin
    alter publication supabase_realtime add table public.trash_bin;
  exception when others then
    raise notice '跳过 realtime 表 trash_bin（可到后台手动开启）';
  end;
end;
$$;

-- ------------------------------------------------------------
--  016_trash_purge.sql · message_hidden.purged_at 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  016_trash_purge.sql · 最近删除 ②：语音彻底删除标记
--
--  顺序要求：必须在 014 之后
--  依赖迁移：014
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_hidden' and column_name='purged_at')
--  check: message_hidden.purged_at 列已存在
-- ============================================================

-- 最近删除 v2：不再依赖 trash_bin 表
-- 日记的回收站状态直接用 diary_entries.deleted_at 推导（软删除本身就是记录）
-- 语音的回收站状态直接用 message_hidden 推导，这里只需加一个「提前彻底删除」的标记列

alter table public.message_hidden add column if not exists purged_at timestamptz;

-- ------------------------------------------------------------
--  017_message_comments.sql · public.message_comments 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  017_message_comments.sql · 留言评论表
--
--  顺序要求：必须在 021 之前（021 会把它加进 realtime publication）
--  依赖迁移：001（messages）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='message_comments')
--  check: public.message_comments 表已存在
-- ============================================================

-- 语音留言的评论：双方都能看到、都能写，只能删自己发的
-- 说明：留言本身的删除/隐藏/恢复都是「只对自己生效」的个人行为（写在 message_hidden 里），
--       评论属于双方共享的内容，所以单独一张表，按 couple 维度共享。

-- ---------- 1. 建表 ----------

create table if not exists public.message_comments (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_message_comments_message on public.message_comments(message_id);

-- ---------- 2. 实时同步（DELETE 事件需要完整旧行才能带 filter） ----------

alter table public.message_comments replica identity full;

-- ---------- 3. 行级安全 ----------

alter table public.message_comments enable row level security;

drop policy if exists "message_comments_select" on public.message_comments;
drop policy if exists "message_comments_insert" on public.message_comments;
drop policy if exists "message_comments_delete" on public.message_comments;

-- 同一空间内双方都能看到所有评论
create policy "message_comments_select" on public.message_comments
  for select using (couple_id = public.current_couple_id());

-- 只能以自己的名义发
create policy "message_comments_insert" on public.message_comments
  for insert with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

-- 只能删自己发的评论
create policy "message_comments_delete" on public.message_comments
  for delete using (author_user_id = auth.uid());

-- ---------- 4. 实时订阅 ----------

do $$
begin
  alter publication supabase_realtime add table public.message_comments;
exception when others then
  raise notice '跳过 realtime（可到后台 Database → Replication 手动开启 message_comments）';
end;
$$;

-- ------------------------------------------------------------
--  018_photo_original.sql · photos.original_path 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  018_photo_original.sql · 照片原图：photos.original_path
--
--  顺序要求：无特殊要求
--  依赖迁移：001（photos）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='original_path')
--  check: photos.original_path 列已存在
-- ============================================================

-- 照片原图：浏览用压缩图（快），额外存一份原图供双方下载保存
-- 用法：Supabase Dashboard → SQL Editor → 粘贴执行（可重复执行，不会报错）

alter table public.photos add column if not exists original_path text;

-- 说明：
-- 1) 不用新建存储桶：原图存在同一个 public 桶 photos 里，路径前缀为 originals/
-- 2) 老照片 original_path 为空，界面上会自动回退到 storage_path（压缩图）来保存
-- 3) 想看看哪些照片有原图：
--    select id, storage_path, original_path from public.photos order by created_at desc limit 20;

-- ------------------------------------------------------------
--  019_photo_delete.sql · public.delete_requests 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  019_photo_delete.sql · 双人确认删除：软删列 + delete_requests
--
--  顺序要求：必须在 006 之后（给 albums 加 deleted_at）
--  依赖迁移：001, 006
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='delete_requests')
--  check: public.delete_requests 表已存在
-- ============================================================

-- 照片 / 图集：删除需双方同意 + 最近删除保存 30 天
-- 用法：Supabase Dashboard → SQL Editor → 粘贴执行（可重复执行）

-- ---------- 1. 软删除字段（进「最近删除」用） ----------

alter table public.photos add column if not exists deleted_at timestamptz;
alter table public.photos add column if not exists deleted_by uuid references auth.users(id) on delete set null;
alter table public.albums add column if not exists deleted_at timestamptz;
alter table public.albums add column if not exists deleted_by uuid references auth.users(id) on delete set null;

create index if not exists idx_photos_deleted on public.photos(deleted_at) where deleted_at is not null;

-- ---------- 2. 删除请求表 ----------

create table if not exists public.delete_requests (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  -- photo = 照片，album = 图集
  kind text not null check (kind in ('photo', 'album')),
  -- 目标 id 列表（批量删照片用得到）
  ref_ids uuid[] not null default '{}',
  -- 展示用：图集名 / 照片备注
  label text,
  -- true = 从「最近删除」里彻底删除，false = 普通删除（先进最近删除躺 30 天）
  purge boolean not null default false,
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  responder_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_delete_requests_couple on public.delete_requests(couple_id, status);

-- ---------- 3. 权限 ----------

alter table public.delete_requests enable row level security;

drop policy if exists "delete_requests_read" on public.delete_requests;
create policy "delete_requests_read" on public.delete_requests
  for select using (couple_id = public.current_couple_id());

-- 只能以自己名义发起
drop policy if exists "delete_requests_insert" on public.delete_requests;
create policy "delete_requests_insert" on public.delete_requests
  for insert with check (
    couple_id = public.current_couple_id()
    and requester_user_id = auth.uid()
    and status = 'pending'
  );

-- 只有「对方」能回应，且只能把 pending 改成 approved / rejected（发起者不能自己批准）
drop policy if exists "delete_requests_respond" on public.delete_requests;
create policy "delete_requests_respond" on public.delete_requests
  for update using (
    couple_id = public.current_couple_id()
    and requester_user_id <> auth.uid()
    and status = 'pending'
  )
  with check (
    couple_id = public.current_couple_id()
    and requester_user_id <> auth.uid()
    and status in ('approved', 'rejected')
  );

-- 发起者可以撤回自己还没被处理的请求
drop policy if exists "delete_requests_revoke" on public.delete_requests;
create policy "delete_requests_revoke" on public.delete_requests
  for delete using (
    couple_id = public.current_couple_id()
    and requester_user_id = auth.uid()
  );

-- ---------- 4. 实时同步（请求要能立刻推给对方） ----------

alter table public.delete_requests replica identity full;
alter table public.albums             replica identity full;

do $$
declare t text;
begin
  foreach t in array array['delete_requests'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 参考查询 ----------
-- 看看有没有待处理的请求：
--   select kind, label, ref_ids, purge, status, created_at from public.delete_requests order by created_at desc;
-- 看看最近删除里躺了什么：
--   select id, storage_path, deleted_at from public.photos where deleted_at is not null order by deleted_at desc;
--   select id, name, deleted_at from public.albums where deleted_at is not null order by deleted_at desc;

-- ------------------------------------------------------------
--  020_period.sql · public.period_logs 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  020_period.sql · 生理期：period_logs / period_settings
--
--  顺序要求：必须在 022 之前
--  依赖迁移：001
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='period_logs')
--  check: public.period_logs 表已存在
-- ============================================================

-- ============================================================
-- 生理期追踪：period_logs（每次经期开始日） + period_settings（周期配置）
-- 双方共享可见，都能记录/修改；在 SQL Editor 执行。
-- ============================================================

-- 1. 经期记录：每次生理期开始那天插一行
create table if not exists public.period_logs (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  start_date date not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_period_logs_couple on public.period_logs(couple_id, start_date);

-- 2. 周期设置：每个空间一行（周期长度 / 经期天数）
create table if not exists public.period_settings (
  couple_id uuid primary key references public.couples(id) on delete cascade,
  cycle_len int not null default 28 check (cycle_len between 15 and 60),
  period_len int not null default 5 check (period_len between 1 and 14),
  updated_at timestamptz not null default now()
);

-- 3. RLS：空间内双方全权（同 photos_all 模式）
drop policy if exists "period_logs_all" on public.period_logs;
create policy "period_logs_all" on public.period_logs
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "period_settings_all" on public.period_settings;
create policy "period_settings_all" on public.period_settings
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- 4. 实时同步
alter table public.period_logs replica identity full;
alter table public.period_settings replica identity full;

do $$
declare
  t text;
begin
  foreach t in array array['period_logs','period_settings']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台手动开启）', t;
    end;
  end loop;
end;
$$;

-- ------------------------------------------------------------
--  021_notify_publication.sql · pokes 已进入 supabase_realtime publication
-- ------------------------------------------------------------

-- ============================================================
--  021_notify_publication.sql · 通知栏：把 7 张表收进 realtime publication
--
--  顺序要求：必须在这些表各自建完（002/004/013/017/019）之后跑，否则会跳过并提示缺表
--  依赖迁移：002, 004, 013, 017, 019
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='pokes')
--  check: pokes 已进入 supabase_realtime publication
-- ============================================================

-- 消息提醒（Notifier）依赖补齐脚本 —— 跑这一个文件即可
-- 背景：Notifier 组件实时监听 6 张表的 INSERT，任何一张缺席 publication 对应提醒就不响。
--       本脚本 ① 补建可能缺失的 message_comments 表（幂等）
--              ② 把监听表全部幂等加入 supabase_realtime publication（缺表只跳过不中断）
--              ③ 最后自查：列出仍未就位的表，方便核对

-- ---------- 1. 补建 message_comments（留言评论，双方共享、只能删自己发的） ----------

create table if not exists public.message_comments (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_message_comments_message on public.message_comments(message_id);

alter table public.message_comments replica identity full;

alter table public.message_comments enable row level security;

drop policy if exists "message_comments_select" on public.message_comments;
drop policy if exists "message_comments_insert" on public.message_comments;
drop policy if exists "message_comments_delete" on public.message_comments;

-- 同一空间内双方都能看到所有评论
create policy "message_comments_select" on public.message_comments
  for select using (couple_id = public.current_couple_id());

-- 只能以自己的名义发
create policy "message_comments_insert" on public.message_comments
  for insert with check (couple_id = public.current_couple_id() and author_user_id = auth.uid());

-- 只能删自己发的评论
create policy "message_comments_delete" on public.message_comments
  for delete using (author_user_id = auth.uid());

-- ---------- 2. 幂等加入 realtime publication（表不存在则跳过并提示，不中断） ----------

do $$
declare t text;
begin
  foreach t in array array[
    'messages','message_comments','photos','diary_entries','diary_comments',
    'delete_requests','pokes'
  ] loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      raise notice '表 public.% 不存在，跳过（请先跑对应功能迁移）', t;
    elsif not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 3. 自查：应该还查不到任何行；查到了就说明有表仍未就位 ----------

select t.missing_table
from unnest(array[
  'messages','message_comments','photos','diary_entries','diary_comments',
  'delete_requests','pokes'
]) as t(missing_table)
where not exists (
  select 1 from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename = t.missing_table
);

-- ------------------------------------------------------------
--  022_period_daily.sql · public.period_daily_logs 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  022_period_daily.sql · 生理期每日记录
--
--  顺序要求：必须在 020 之后
--  依赖迁移：020
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='period_daily_logs')
--  check: public.period_daily_logs 表已存在
-- ============================================================

-- 生理期每日打卡（对标 Flo/美柚 的每日症状记录，情侣双方共享）
-- 每人每天最多一条（couple_id + user_id + log_date 唯一），可反复更新

-- ---------- 1. 建表 ----------
create table if not exists public.period_daily_logs (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  log_date date not null,
  -- 流量：none 没来 / light 少量 / medium 适中 / heavy 量多
  flow text check (flow in ('none','light','medium','heavy')),
  -- 痛经程度 0-3（不痛/轻微/中度/严重）
  pain int check (pain between 0 and 3),
  -- 情绪：happy/calm/irritable/low/sensitive
  mood text,
  -- 症状多选（预设标签）
  symptoms text[] not null default '{}',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (couple_id, user_id, log_date)
);

create index if not exists idx_period_daily_couple_date
  on public.period_daily_logs(couple_id, log_date);

-- ---------- 2. 行级安全（couple 内双方全权，与 period_logs 一致） ----------
alter table public.period_daily_logs enable row level security;

drop policy if exists "period_daily_all" on public.period_daily_logs;
create policy "period_daily_all" on public.period_daily_logs
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- ---------- 3. 实时同步 ----------
alter table public.period_daily_logs replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'period_daily_logs'
  ) then
    alter publication supabase_realtime add table public.period_daily_logs;
  end if;
end $$;

-- ------------------------------------------------------------
--  023_member_gender.sql · members.gender 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  023_member_gender.sql · 成员性别字段
--
--  顺序要求：无特殊要求
--  依赖迁移：001（members）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='members' and column_name='gender')
--  check: members.gender 列已存在
-- ============================================================

-- 成员资料支持设置性别（male / female；未设置时为 null）
-- 在 SQL Editor 中执行一次即可，幂等可重复执行。

alter table public.members
  add column if not exists gender text
  check (gender in ('male', 'female'));

-- RLS 无需改动：members_update_own 策略本来就允许本人更新自己的整行，
-- 新列自动被覆盖（只能改自己的性别，对方改不了）。

-- ------------------------------------------------------------
--  024_photo_thumb.sql · photos.thumb_path 列已存在
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
--  025_message_hidden_policy.sql · message_hidden.permanent 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  025_message_hidden_policy.sql · 留言彻底删除 + 永久隐藏
--
--  顺序要求：必须在 014 之后
--  依赖迁移：014
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_hidden' and column_name='permanent')
--  check: message_hidden.permanent 列已存在
-- ============================================================

-- 修复：语音留言「彻底删除」失败：Could not find the 'purged_at' column
--
-- 线上库 message_hidden 缺 purged_at 列（016_trash_purge.sql 从未执行过），
-- 且旧版权限缺 UPDATE（RLS 静默过滤）。本脚本自包含、幂等，可重复执行，
-- 把彻底删除功能需要的表结构 + 权限一次补齐。
--
-- 在 Supabase SQL Editor 里跑一次即可。

-- 1) 补列：彻底删除的标记列 + 永久隐藏标记（幂等）
alter table public.message_hidden add column if not exists purged_at timestamptz;
alter table public.message_hidden add column if not exists permanent boolean not null default false;

-- 2) 补唯一约束：App 的 upsert 依赖 onConflict 'message_id,user_id'，没有它 upsert 会报错
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'message_hidden_message_id_user_id_key'
      and conrelid = 'public.message_hidden'::regclass
  ) then
    alter table public.message_hidden
      add constraint message_hidden_message_id_user_id_key
      unique (message_id, user_id);
  end if;
end $$;

-- 3) 修权限：旧版策略缺 UPDATE，RLS 会把「写 purged_at 标记」静默过滤成 0 行
drop policy if exists "message_hidden_own" on public.message_hidden;

create policy "message_hidden_own" on public.message_hidden
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and couple_id = public.current_couple_id());

-- 4) 刷新 PostgREST 的 schema cache：让新加的列对 API 立即可见
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
--  026_push.sql · public.push_subscriptions 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  026_push.sql · Web Push：订阅表 + pg_net + 触发 8 类事件
--
--  顺序要求：必须在 002/004/013/017/019/022 之后（触发器依赖这些表）
--  依赖迁移：002, 004, 013, 017, 019, 022
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='push_subscriptions')
--  check: public.push_subscriptions 表已存在
-- ============================================================

-- ============================================================
--  消息推送（Web Push）· 一次跑完：订阅表 + 8 张表的推送触发器
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）
--
--  原理：任一张表有新插入 → pg_net（Supabase 自带的数据库→HTTP 网关）
--  自动调用 push-send 边缘函数 → 函数校验密钥、找到情侣里的另一位、
--  查 TA 的推送订阅 → 用 Web Push 协议推到 TA 的手机（App 关了也能收到）
--
--  为什么不用 supabase_functions.http_request：那是老版数据库 Webhook
--  的机制，新项目默认没有这个 schema（报 3F000 就是它）。pg_net 是
--  新版标准方案，全部项目可用，且异步发送不阻塞写入。
-- ============================================================

-- ---------- 0. 启用 pg_net（新项目一般已预装；没有就装到默认 net schema） ----------
create extension if not exists pg_net;

-- ---------- 1. 推送订阅表：每人每个浏览器一条 ----------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_select" on public.push_subscriptions;
drop policy if exists "push_subscriptions_insert" on public.push_subscriptions;
drop policy if exists "push_subscriptions_update" on public.push_subscriptions;
drop policy if exists "push_subscriptions_delete" on public.push_subscriptions;

create policy "push_subscriptions_select" on public.push_subscriptions
  for select using (auth.uid() = user_id);
create policy "push_subscriptions_insert" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);
create policy "push_subscriptions_update" on public.push_subscriptions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "push_subscriptions_delete" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

-- ---------- 2. 通用触发函数：新动态 → 调 push-send ----------
-- 函数侧会校验 x-push-secret，并只提醒同一 couple 的另一位（自己动的不推）
-- ⚠ 2026-10-17：这里的 x-push-secret 曾经是明文密钥（已轮换、视为已泄露）。
--   密钥不再进代码 —— 038_push_secrets.sql 会用同一个函数名覆盖它，
--   改成从 Vault 读 `push_secret`。本文件保留原来的骨架（迁移是有序历史），
--   但**不要再往这里填真实密钥**。
create or replace function public.fn_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
begin
  perform net.http_post(
    url := 'https://wengwenilnywpijuraqn.supabase.co/functions/v1/push-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- 真实密钥见 038_push_secrets.sql（Vault: push_secret）；这里刻意留空。
      -- 留空而不是直接调 push_secret()：026 跑在 038 之前，那时函数还不存在，
      -- 会让所有 INSERT 因为「函数不存在」整个失败（宁可推送失败，也不能写不进数据）。
      'x-push-secret', ''
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'record', to_jsonb(NEW)
    ),
    timeout_milliseconds := 5000
  );
  return NEW;
end;
$$;

-- ---------- 3. 7 张表挂触发器 ----------
drop trigger if exists push_notify_messages on public.messages;
create trigger push_notify_messages after insert on public.messages
  for each row execute function public.fn_push_notify();

drop trigger if exists push_notify_photos on public.photos;
create trigger push_notify_photos after insert on public.photos
  for each row execute function public.fn_push_notify();

drop trigger if exists push_notify_diary on public.diary_entries;
create trigger push_notify_diary after insert on public.diary_entries
  for each row execute function public.fn_push_notify();

drop trigger if exists push_notify_diary_comments on public.diary_comments;
create trigger push_notify_diary_comments after insert on public.diary_comments
  for each row execute function public.fn_push_notify();

drop trigger if exists push_notify_message_comments on public.message_comments;
create trigger push_notify_message_comments after insert on public.message_comments
  for each row execute function public.fn_push_notify();

drop trigger if exists push_notify_delete_requests on public.delete_requests;
create trigger push_notify_delete_requests after insert on public.delete_requests
  for each row execute function public.fn_push_notify();

drop trigger if exists push_notify_period_logs on public.period_daily_logs;
create trigger push_notify_period_logs after insert on public.period_daily_logs
  for each row execute function public.fn_push_notify();

-- 戳一戳家族（戳一戳/摸摸头/想聊聊）——想聊聊是高优先级提醒，App 关了也要能收到
drop trigger if exists push_notify_pokes on public.pokes;
create trigger push_notify_pokes after insert on public.pokes
  for each row execute function public.fn_push_notify();

-- ---------- 4. 让新表立刻可被客户端访问（刷新 PostgREST 缓存） ----------
notify pgrst, 'reload schema';

-- ---------- 5. 自查：确认 8 个触发器都建好了 ----------
select tgrelid::regclass as 表, tgname as 触发器
from pg_trigger
where tgname like 'push_notify_%' and not tgisinternal
order by 1;

-- ------------------------------------------------------------
--  027_messages_enrich.sql · public.message_reactions 表已存在
-- ------------------------------------------------------------

-- ============================================================
--  027_messages_enrich.sql · 留言增强：配图 / 回复 / 表情回应
--
--  顺序要求：无特殊要求
--  依赖迁移：001（messages）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_tables where schemaname='public' and tablename='message_reactions')
--  check: public.message_reactions 表已存在
-- ============================================================

-- ============================================================
--  留言板升级为「混合时间流」· 一次跑完：messages 加列 + 表情回应表
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）；不影响已有数据
--
--  改动：
--    1. messages 加 image_path（图片留言）、reply_to（回复某条留言）
--    2. 新表 message_reactions（表情回应，一条消息一个 emoji 一人一次）
--  前端 Messages.jsx 依赖以上结构；表情回应实时同步依赖 realtime 订阅。
--
--  ⚠️ 如果报 40P01 deadlock detected：App 页面开着时 Realtime/PostgREST 连接
--  正持有表锁，与 ALTER TABLE 互等。先关掉所有 App 页面（线上+dev）再重跑；
--  仍不行就 Restart project 后立刻跑。全部语句幂等，重跑安全。
-- ============================================================

-- 拿不到锁 8 秒就快速报错退出（整文件一个隐式事务，自动回滚），避免长时间挂住
set lock_timeout = '8s';

-- ---------- 1. messages 加列 ----------

-- 图片留言：存 photos bucket 里的对象路径（复用现有 bucket，公开读、登录可传）
alter table public.messages add column if not exists image_path text;

-- 回复某条留言：指向被回复的 messages.id；对方删/隐藏不影响本条，引用渲染时按需降级
alter table public.messages add column if not exists reply_to uuid references public.messages(id) on delete set null;

create index if not exists idx_messages_reply_to on public.messages(reply_to);

-- ---------- 2. 表情回应表 ----------

-- 一条消息 × 一个 emoji × 一个人 = 一行（重复点按 = 取消，由前端 delete）
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

create index if not exists idx_message_reactions_message on public.message_reactions(message_id);

-- ---------- 3. 实时同步 ----------

alter table public.message_reactions replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.message_reactions;
exception when others then
  raise notice '跳过 realtime（可到后台 Database → Replication 手动开启 message_reactions）';
end;
$$;

-- ---------- 4. 行级安全 ----------

alter table public.message_reactions enable row level security;

drop policy if exists "message_reactions_select" on public.message_reactions;
drop policy if exists "message_reactions_insert" on public.message_reactions;
drop policy if exists "message_reactions_delete" on public.message_reactions;

-- 同一空间内双方都能看到所有回应
create policy "message_reactions_select" on public.message_reactions
  for select using (couple_id = public.current_couple_id());

-- 只能以自己的名义回应
create policy "message_reactions_insert" on public.message_reactions
  for insert with check (couple_id = public.current_couple_id() and user_id = auth.uid());

-- 只能取消自己的回应
create policy "message_reactions_delete" on public.message_reactions
  for delete using (user_id = auth.uid());

-- ---------- 5. 通知 PostgREST 重载 schema（新表立即可写，否则会 schema cache 404） ----------

notify pgrst, 'reload schema';

-- ---------- 6. 自查 ----------

select 'messages.image_path' as item, count(*) as ok from information_schema.columns
  where table_schema = 'public' and table_name = 'messages' and column_name = 'image_path'
union all
select 'messages.reply_to', count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'messages' and column_name = 'reply_to'
union all
select 'message_reactions 表', count(*) from information_schema.tables
  where table_schema = 'public' and table_name = 'message_reactions'
union all
select 'message_reactions RLS', count(*) from pg_policies
  where schemaname = 'public' and tablename = 'message_reactions';

-- ------------------------------------------------------------
--  028_photos_memory_desc.sql · albums.description 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  028_photos_memory_desc.sql · 记忆空间 ①：图集简介
--
--  顺序要求：两步（028 → 029）按序执行；必须在 006 之后
--  依赖迁移：006
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='albums' and column_name='description')
--  check: albums.description 列已存在
-- ============================================================

-- ============================================================
--  相册「记忆空间」升级 · 第 1 步（共 2 步）：图集简介
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。两步依次跑完：a -> b
--
--  为什么拆成两个小文件：SQL Editor 把整个脚本放进一个事务执行，
--  一次性跑多条 DDL 持锁时间长，容易被 App 的实时连接堵住，
--  触发 40P01 deadlock detected（教训见 （图集三步：006_albums_table.sql → 007_albums_photo_ref.sql → 008_albums_rls.sql） 拆分说明）。
-- ============================================================

-- ---------- 1. 图集简介（展示用，双方都可编辑） ----------
alter table public.albums add column if not exists description text;

notify pgrst, 'reload schema';

-- ---------- 自查（应返回 1） ----------
select count(*) as description_ok
from information_schema.columns
where table_schema = 'public' and table_name = 'albums' and column_name = 'description';

-- ------------------------------------------------------------
--  029_photos_memory_pin.sql · photos.pinned_at 列已存在
-- ------------------------------------------------------------

-- ============================================================
--  029_photos_memory_pin.sql · 记忆空间 ②：照片置顶
--
--  顺序要求：必须在 028 之后
--  依赖迁移：006, 028
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='pinned_at')
--  check: photos.pinned_at 列已存在
-- ============================================================

-- ============================================================
--  相册「记忆空间」升级 · 第 2 步（共 2 步）：置顶照片
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）。先跑 a 再跑本步。
-- ============================================================

-- ---------- 1. 置顶时间戳：null = 未置顶；置顶的照片在网格里排最前、优先当图集封面 ----------
-- 注意：pinned_at 存在照片行上，是情侣共同状态（双方看到同一个置顶效果），不是个人偏好
alter table public.photos add column if not exists pinned_at timestamptz;

notify pgrst, 'reload schema';

-- ---------- 自查（应返回 1） ----------
select count(*) as pinned_at_ok
from information_schema.columns
where table_schema = 'public' and table_name = 'photos' and column_name = 'pinned_at';

-- ------------------------------------------------------------
--  030_storage_private.sql · photos 桶已转为私有
-- ------------------------------------------------------------

-- ============================================================
--  030_storage_private.sql · 存储安全：photos/voice 转私有桶 + 按空间隔离
--
--  顺序要求：⚠️ 必须先发布「签名 URL 版」前端再跑本迁移，否则旧前端的图片全部 403
--  依赖迁移：001, 013
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from storage.buckets where id='photos' and public = false)
--  check: photos 桶已转为私有
-- ============================================================

-- ============================================================
--  存储安全升级：photos / voice 转私有桶 + 按情侣空间隔离的读写删策略
--  用法：SQL Editor -> 新建查询 -> 全选粘贴 -> Run
--  可重复运行（幂等）
--
--  ⚠️ 执行顺序：先发布新版前端，再跑本迁移！
--  新前端一律用签名 URL（公开桶/私有桶都能加载）；旧前端用的是公开 URL，
--  桶一转私有就会全部 403。
--
--  路径约定（策略依赖此格式，改路径格式必须同步改策略）：
--    photos 桶：photos/<coupleId>/…、originals/<coupleId>/…、thumbs/<coupleId>/…、diary/<coupleId>/…
--    voice  桶：<coupleId>/…
--    avatars 桶：保持公开读——路径不含 coupleId 没法按空间隔离，且头像低敏感；
--               上传/删除仍是「登录即可」（与之前一致）
--
--  收益：拿到文件 URL 的陌生人在未登录时 403；A 空间用户访问/删除 B 空间的文件也 403。
-- ============================================================

set lock_timeout = '8s';

-- ---------- 1. 路径 → coupleId 解析（photos 桶取第 2 段，voice 桶取第 1 段；非法路径返回 null 不抛错） ----------
create or replace function public.storage_couple_id(bucket text, name text)
returns uuid
language plpgsql
stable
as $$
declare
  seg text[] := storage.foldername(name);
begin
  if bucket = 'voice' and array_length(seg, 1) >= 1 then
    return seg[1]::uuid;
  elsif bucket = 'photos' and array_length(seg, 1) >= 2 then
    return seg[2]::uuid;
  end if;
  return null;
exception when others then
  return null;
end $$;

grant execute on function public.storage_couple_id(text, text) to anon, authenticated;

-- ---------- 2. 空间成员判定（security definer：判定时不受 members 自身 RLS 干扰） ----------
create or replace function public.is_couple_member(uid uuid, cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.members m where m.user_id = uid and m.couple_id = cid)
$$;

revoke all on function public.is_couple_member(uuid, uuid) from public, anon;
grant execute on function public.is_couple_member(uuid, uuid) to authenticated;

-- ---------- 3. 撤掉旧的宽松策略（公开读 / 只判登录的写删） ----------
drop policy if exists "photos_read" on storage.objects;
drop policy if exists "photos_insert" on storage.objects;
drop policy if exists "photos_delete" on storage.objects;
drop policy if exists "photos_select" on storage.objects;
drop policy if exists "photos_update" on storage.objects;
drop policy if exists "voice_read" on storage.objects;
drop policy if exists "voice_insert" on storage.objects;
drop policy if exists "voice_delete" on storage.objects;
drop policy if exists "voice_select" on storage.objects;
drop policy if exists "voice_update" on storage.objects;

-- ---------- 4. photos：读（含签名）/传/改/删都要求「对象路径里的 coupleId 是自己所在空间」 ----------
create policy "photos_select" on storage.objects
  for select
  using (bucket_id = 'photos' and public.is_couple_member(auth.uid(), public.storage_couple_id('photos', name)));

create policy "photos_insert" on storage.objects
  for insert
  with check (bucket_id = 'photos' and public.is_couple_member(auth.uid(), public.storage_couple_id('photos', name)));

create policy "photos_update" on storage.objects
  for update
  using (bucket_id = 'photos' and public.is_couple_member(auth.uid(), public.storage_couple_id('photos', name)))
  with check (bucket_id = 'photos' and public.is_couple_member(auth.uid(), public.storage_couple_id('photos', name)));

create policy "photos_delete" on storage.objects
  for delete
  using (bucket_id = 'photos' and public.is_couple_member(auth.uid(), public.storage_couple_id('photos', name)));

-- ---------- 5. voice 同构 ----------
create policy "voice_select" on storage.objects
  for select
  using (bucket_id = 'voice' and public.is_couple_member(auth.uid(), public.storage_couple_id('voice', name)));

create policy "voice_insert" on storage.objects
  for insert
  with check (bucket_id = 'voice' and public.is_couple_member(auth.uid(), public.storage_couple_id('voice', name)));

create policy "voice_update" on storage.objects
  for update
  using (bucket_id = 'voice' and public.is_couple_member(auth.uid(), public.storage_couple_id('voice', name)))
  with check (bucket_id = 'voice' and public.is_couple_member(auth.uid(), public.storage_couple_id('voice', name)));

create policy "voice_delete" on storage.objects
  for delete
  using (bucket_id = 'voice' and public.is_couple_member(auth.uid(), public.storage_couple_id('voice', name)));

-- ---------- 6. 转私有（存量文件无需搬家，签名 URL 照常工作） ----------
update storage.buckets set public = false where id in ('photos', 'voice');

-- ---------- 自查 ----------
-- 1) 两个桶都应为 false：
select id, public from storage.buckets where id in ('photos', 'voice');
-- 2) 应列出 8 条新策略（photos_/voice_ 各 4 条）：
select policyname from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and (policyname like 'photos_%' or policyname like 'voice_%')
order by policyname;

-- ------------------------------------------------------------
--  031_delete_approve_rpc.sql · public.approve_delete_request(uuid) 函数已存在
-- ------------------------------------------------------------

-- ============================================================
--  031_delete_approve_rpc.sql · 删除审批事务 RPC：approve_delete_request
--
--  顺序要求：⚠️ 必须在 019 之后；前端「同意删除」依赖此函数，函数不在时会提示但功能不可用
--  依赖迁移：019
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='approve_delete_request')
--  check: public.approve_delete_request(uuid) 函数已存在
-- ============================================================

-- ============================================================
-- 删除审批事务化：批准 + 软删除 + 更新状态 在一个数据库事务里完成
--
-- 解决的问题：前端原来分两步（先 update 请求为 approved，再逐条软删除照片/图集），
-- 第二步失败时会出现「请求已同意、照片还在」的不一致状态。
--
-- 用法：Supabase Dashboard → SQL Editor → 粘贴执行（可重复执行）
-- 幂等：请求已是 approved 时直接返回（前端重试安全）
-- ============================================================

create or replace function public.approve_delete_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req     public.delete_requests%rowtype;
  v_uid     uuid := auth.uid();
  v_couple  uuid := public.current_couple_id();
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;
  if v_couple is null then
    raise exception '你还没有加入情侣空间';
  end if;

  -- 锁定请求行：并发批准同一条时，第二个事务会等锁，醒来后走幂等分支
  select * into v_req from public.delete_requests where id = p_request_id for update;
  if not found then
    raise exception '删除请求不存在（可能已被撤回）';
  end if;
  if v_req.couple_id <> v_couple then
    raise exception '无权处理其他空间的请求';
  end if;
  if v_req.requester_user_id = v_uid then
    raise exception '不能批准自己发起的请求';
  end if;
  -- 幂等：已经批准过就直接返回（对方重复点击 / 前端重试都安全）
  if v_req.status = 'approved' then
    return;
  end if;
  if v_req.status <> 'pending' then
    raise exception '该请求已被处理（当前状态：%）', v_req.status;
  end if;

  -- 软删除（与前端 softDelete 同语义）：
  --   图集 = 先把照片移出图集（照片本体保留），再标记图集；
  --   照片 = 标记 deleted_at 进「最近删除」躺 30 天。
  -- 「and deleted_at is null」守卫：已躺在回收站里的不重复标记。
  -- 注：purge 字段与前端行为保持一致——审批通过一律先进最近删除，
  --     彻底删除是回收站里的个人操作，不走这条审批链。
  if v_req.kind = 'album' then
    update public.photos set album_id = null
      where album_id = any(v_req.ref_ids);
    update public.albums
      set deleted_at = now(), deleted_by = v_uid
      where id = any(v_req.ref_ids) and deleted_at is null;
  else
    update public.photos
      set deleted_at = now(), deleted_by = v_uid
      where id = any(v_req.ref_ids) and deleted_at is null;
  end if;

  update public.delete_requests
    set status = 'approved', responder_user_id = v_uid, resolved_at = now()
    where id = p_request_id;
end;
$$;

-- 权限：只给登录用户执行（security definer 函数默认会授给 public，收掉）
revoke all on function public.approve_delete_request(uuid) from public;
grant execute on function public.approve_delete_request(uuid) to authenticated;

-- ---------- 自查（应返回 1 行 + 3 条授权） ----------
-- select proname, prosecdef from pg_proc where proname = 'approve_delete_request';

-- ------------------------------------------------------------
--  032_paged_indexes.sql · photos_couple_created_idx 索引已存在
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
--  033_bootstrap_space.sql · public.bootstrap_space(date) 函数已存在
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
--  034_photo_thumb_guard.sql · public.photos_missing_thumb() 函数已存在
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
--  035_list_query_indexes.sql · moods_couple_date_idx 索引已存在
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
--  036_period_rls.sql · period_logs / period_settings 的 relrowsecurity 均为 true
-- ------------------------------------------------------------

-- ============================================================
--  036_period_rls.sql · 补开 period_logs / period_settings 的行级安全（P0）
--
--  顺序要求：必须在 020 之后（两张表是 020 建的）
--  依赖迁移：001, 020
--  幂等：是，可重复执行（enable 本身幂等；policy 走 drop if exists + create）
--
--  fingerprint: (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname in ('period_logs', 'period_settings'))
--  check: period_logs / period_settings 的 relrowsecurity 均为 true
-- ============================================================

-- ⚠ 这是一个真实的越权漏洞，不是洁癖：
--   020 里已经写好了「按 couple_id 隔离」的 policy，但**漏了 enable row level security**。
--   RLS 关闭时 policy 完全不参与过滤 —— 表还在、policy 也在，等于没锁门。
--   只要角色有表权限（Supabase 默认把 public schema 的权限给了 anon / authenticated），
--   调用方就能跨空间读到所有人的经期记录、也能改别人的周期设置。
--   022 的 period_daily_logs 明确开了 RLS，对比之下更说明 020 这两张是漏的。
--
-- 只补开关，不改语义：policy 与 020 里的一字不变，空间内双方照旧可读可写。
alter table public.period_logs enable row level security;
alter table public.period_settings enable row level security;

-- 策略顺手重建一遍（幂等）：万一哪台库上 policy 被手工改过，这里把它拉回正轨
drop policy if exists "period_logs_all" on public.period_logs;
create policy "period_logs_all" on public.period_logs
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

drop policy if exists "period_settings_all" on public.period_settings;
create policy "period_settings_all" on public.period_settings
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- 让 PostgREST 立刻看见新状态（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
--  037_conflict_rooms.sql · public.conflict_rooms 表已存在
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
--  038_push_secrets.sql · public.push_secret() 函数已存在
-- ------------------------------------------------------------

-- ============================================================
--  038_push_secrets.sql · 推送密钥出仓：数据库侧改从 Vault 读
--
--  顺序要求：必须在 026 之后（覆盖它建的 fn_push_notify）
--  依赖迁移：026
--  幂等：是，可重复执行（create or replace）
--
--  fingerprint: exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='push_secret')
--  check: public.push_secret() 函数已存在
-- ============================================================

-- ============================================================
-- 为什么要这一条迁移：
--   026 把共享密钥（x-push-secret）**明文写进了函数体**，而函数体就是仓库里的
--   一个 .sql 文件；Edge Function 那边同样把 VAPID 私钥硬编码在源码里。
--   只要仓库或部署包曾被外人看到，这两个值就该视为**已泄露**：
--     · 拿到共享密钥 = 可以自己构造请求让云函数给对方推任何内容；
--     · 拿到 VAPID 私钥 = 可以冒充本站给已订阅的用户推消息。
--   所以做两件事（本迁移负责第 ① 件，第 ② 件在 Edge Function / Secrets 那边）：
--     ① 数据库里的密钥不再进代码：改从 Supabase Vault 读；
--     ② 密钥本身轮换：见 PUSH_SETUP.md 的「密钥轮换」一节。
--
-- 配置方式（只需一次）：
--   select vault.create_secret('新的共享密钥', 'push_secret');
--   -- 以后轮换：select vault.update_secret(<id>, '新值') 或删了重建
-- 没配会怎样：push_secret() 返回 null → 触发器记一条 warning 并跳过推送，
--   **不会**带着空密钥去请求云函数（那只会换来一堆 403）。
-- ============================================================

-- ---------- 1. 读密钥的小函数 ----------
create or replace function public.push_secret()
returns text
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  -- ⚠ Vault 没启用时 `select ... from vault.decrypted_secrets` 会在语义分析阶段
  --   就炸（42P01，用 CASE 也包不住）→ 先用 to_regclass() 探测，没有就返回 null。
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = ''push_secret'' limit 1'
    into v_secret;

  return nullif(v_secret, '');
end;
$$;

-- ⚠⚠ 这个函数返回的是**明文共享密钥**，绝不能让客户端角色调得到：
--    拿到它 = 可以自己构造请求，让 push-send 给任意订阅者推任意内容。
--
--    两个必须知道的事实（都是踩出来的）：
--    · ⚠ **只写 `revoke ... from public` 是挡不住的**。Supabase 在 public schema 上
--      设了 `alter default privileges ... grant all on functions to
--      postgres, anon, authenticated, service_role` —— 函数**一创建**就自动被授予
--      anon / authenticated。这种授权是逐角色的（不是走 PUBLIC），revoke PUBLIC
--      碰不到它。实测：线上 `GET /rest/v1/rpc/push_secret` 用匿名 key 直接 200，
--      响应体就是那段共享密钥（PostgREST 把 public schema 的函数都暴露成 RPC）。
--    · 曾经额外写过 `grant execute ... to authenticated`，那句话等于把密钥直接
--      发给所有登录用户。
--      → 结论：必须显式 revoke anon + authenticated，客户端角色一个都不给。
--
--    那触发器怎么调得到？fn_push_notify() 是 security definer，以**函数所有者**
--    的身份执行，所有者天然拥有自己函数的执行权（不需要任何 grant）。
--    两个函数是同一条迁移、同一个角色建的 → 所有者相同，链路成立。
revoke all on function public.push_secret() from public;
revoke all on function public.push_secret() from anon, authenticated;

-- 验证（期望两个都 false，在 SQL Editor 里跑）：
--   select has_function_privilege('anon', 'public.push_secret()', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.push_secret()', 'EXECUTE');

-- ---------- 2. 触发函数：密钥来自 Vault，不再是代码里的字面量 ----------
create or replace function public.fn_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_secret text;
begin
  v_secret := public.push_secret();
  if v_secret is null then
    -- 没配密钥就明确跳过：宁可停推，也不要拿空值去撞云函数的鉴权
    raise warning '[push] 未配置 Vault 密钥 push_secret，本次推送已跳过（见 038_push_secrets.sql）';
    return NEW;
  end if;

  perform net.http_post(
    url := 'https://wengwenilnywpijuraqn.supabase.co/functions/v1/push-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_secret
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'record', to_jsonb(NEW)
    ),
    timeout_milliseconds := 5000
  );
  return NEW;
end;
$$;

-- ---------- 3. 轮换后：清掉用旧 VAPID 登记的订阅 ----------
-- 换了 VAPID 密钥对，旧订阅一律推不动（403）。云函数已经会把 403 的订阅删掉，
-- 这里再给一次「一次性清空」的选择（想立刻让所有人重新登记就解开注释执行）：
-- delete from public.push_subscriptions;

-- 让 PostgREST 立刻看见新对象（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';
