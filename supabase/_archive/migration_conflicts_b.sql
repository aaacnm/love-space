-- ============================================================
--  「和好」栏目 · 第 2 步（共 2 步）：实时同步
-- ============================================================

-- ---------- 加入 realtime 推送 ----------

do $$
declare
  t text;
begin
  foreach t in array array['makeups','conflicts','conflict_reviews','promises']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice '跳过 realtime 表 %（可到后台 Database -> Replication 手动开启）', t;
    end;
  end loop;
end;
$$;

-- 让 DELETE / UPDATE 带上完整旧记录，否则对方必须刷新才能看到变化
alter table public.makeups          replica identity full;
alter table public.conflicts        replica identity full;
alter table public.conflict_reviews replica identity full;
alter table public.promises         replica identity full;
