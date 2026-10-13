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
