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
