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
