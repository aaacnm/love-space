-- 修复：语音留言「彻底删除」失败：Could not find the 'purged_at' column
--
-- 线上库 message_hidden 缺 purged_at 列（migration_trash_v2.sql 从未执行过），
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
