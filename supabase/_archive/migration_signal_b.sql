-- ============================================================
--  「和好」轻量版 · 第 2 步（共 2 步）：实时同步 + 删除事件完整化
--  在 migration_signal_a.sql 成功后运行
-- ============================================================

alter table public.signals replica identity full;
alter table public.steps replica identity full;
alter table public.conflict_checkins replica identity full;

do $$
declare
  pub text;
  t text;
begin
  select pubname into pub from pg_publication where pubname = 'supabase_realtime';
  if pub is null then
    raise notice 'no supabase_realtime publication, skip';
    return;
  end if;

  foreach t in array array['signals', 'steps', 'conflict_checkins']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = pub and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication %I add table public.%I', pub, t);
    else
      raise notice 'table % already in publication', t;
    end if;
  end loop;
end $$;
