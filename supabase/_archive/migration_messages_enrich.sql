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
