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

