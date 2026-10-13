-- ============================================================
--  图集功能 · 第 3 步（共 3 步）：权限 + 实时同步
-- ============================================================

-- ---------- 行级安全 ----------

alter table public.albums enable row level security;

drop policy if exists "albums_all" on public.albums;

create policy "albums_all" on public.albums
  for all using (couple_id = public.current_couple_id())
  with check (couple_id = public.current_couple_id());

-- photos 沿用已有的 photos_all 策略（本空间可读写），无需改动

-- ---------- 实时同步 ----------

do $$
begin
  begin
    alter publication supabase_realtime add table public.albums;
  exception when others then
    raise notice '跳过 realtime 表 albums（可到后台 Database -> Replication 手动开启）';
  end;
end;
$$;

-- 让 DELETE / UPDATE 事件带上完整旧记录（否则对方删除不同步）
alter table public.photos replica identity full;
alter table public.albums  replica identity full;
