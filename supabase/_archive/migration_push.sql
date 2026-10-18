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
      -- ⚠ 旧密钥已轮换并视为泄露，此处抹除（见 supabase/migrations/038_push_secrets.sql）
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
