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
