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
