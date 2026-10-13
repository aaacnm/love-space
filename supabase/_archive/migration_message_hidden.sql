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
