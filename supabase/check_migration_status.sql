-- ============================================================
--  数据库版本自查 —— 自动生成，请勿手改（npm run db:sync）
--  用法：Supabase Dashboard → SQL Editor → 全选粘贴 → Run
--  输出：每个迁移一行，applied = false 的就是还没跑过的。
-- ============================================================

-- ---------- 1. 逐迁移核对 ----------
select v.version,
       v.file,
       v.expects,
       case when v.applied then '已执行' else '未执行 ← 需要补跑' end as status
from (
  select '001'::text as version, '001_initial.sql'::text as file, 'public.couples 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='couples')) as applied
union all
  select '002'::text as version, '002_pokes.sql'::text as file, 'public.pokes 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='pokes')) as applied
union all
  select '003'::text as version, '003_interactive.sql'::text as file, 'pokes.kind 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='pokes' and column_name='kind')) as applied
union all
  select '004'::text as version, '004_diary.sql'::text as file, 'diary_entries.images 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='diary_entries' and column_name='images')) as applied
union all
  select '005'::text as version, '005_realtime_replica.sql'::text as file, 'public.photos 已是 REPLICA IDENTITY FULL'::text as expects,
         (exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='photos' and c.relreplident='f')) as applied
union all
  select '006'::text as version, '006_albums_table.sql'::text as file, 'public.albums 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='albums')) as applied
union all
  select '007'::text as version, '007_albums_photo_ref.sql'::text as file, 'photos.album_id 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='album_id')) as applied
union all
  select '008'::text as version, '008_albums_rls.sql'::text as file, 'albums 的 albums_all 策略已存在'::text as expects,
         (exists (select 1 from pg_policies where schemaname='public' and tablename='albums' and policyname='albums_all')) as applied
union all
  select '009'::text as version, '009_conflicts_tables.sql'::text as file, 'public.conflicts 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='conflicts')) as applied
union all
  select '010'::text as version, '010_conflicts_realtime.sql'::text as file, 'public.conflicts 已是 REPLICA IDENTITY FULL'::text as expects,
         (exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='conflicts' and c.relreplident='f')) as applied
union all
  select '011'::text as version, '011_signal_tables.sql'::text as file, 'public.signals 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='signals')) as applied
union all
  select '012'::text as version, '012_signal_realtime.sql'::text as file, 'public.signals 已是 REPLICA IDENTITY FULL'::text as expects,
         (exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='signals' and c.relreplident='f')) as applied
union all
  select '013'::text as version, '013_voice.sql'::text as file, 'messages.voice_path 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='voice_path')) as applied
union all
  select '014'::text as version, '014_message_hidden.sql'::text as file, 'public.message_hidden 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='message_hidden')) as applied
union all
  select '015'::text as version, '015_trash.sql'::text as file, 'public.trash_bin 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='trash_bin')) as applied
union all
  select '016'::text as version, '016_trash_purge.sql'::text as file, 'message_hidden.purged_at 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_hidden' and column_name='purged_at')) as applied
union all
  select '017'::text as version, '017_message_comments.sql'::text as file, 'public.message_comments 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='message_comments')) as applied
union all
  select '018'::text as version, '018_photo_original.sql'::text as file, 'photos.original_path 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='original_path')) as applied
union all
  select '019'::text as version, '019_photo_delete.sql'::text as file, 'public.delete_requests 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='delete_requests')) as applied
union all
  select '020'::text as version, '020_period.sql'::text as file, 'public.period_logs 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='period_logs')) as applied
union all
  select '021'::text as version, '021_notify_publication.sql'::text as file, 'pokes 已进入 supabase_realtime publication'::text as expects,
         (exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='pokes')) as applied
union all
  select '022'::text as version, '022_period_daily.sql'::text as file, 'public.period_daily_logs 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='period_daily_logs')) as applied
union all
  select '023'::text as version, '023_member_gender.sql'::text as file, 'members.gender 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='members' and column_name='gender')) as applied
union all
  select '024'::text as version, '024_photo_thumb.sql'::text as file, 'photos.thumb_path 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='thumb_path')) as applied
union all
  select '025'::text as version, '025_message_hidden_policy.sql'::text as file, 'message_hidden.permanent 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_hidden' and column_name='permanent')) as applied
union all
  select '026'::text as version, '026_push.sql'::text as file, 'public.push_subscriptions 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='push_subscriptions')) as applied
union all
  select '027'::text as version, '027_messages_enrich.sql'::text as file, 'public.message_reactions 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='message_reactions')) as applied
union all
  select '028'::text as version, '028_photos_memory_desc.sql'::text as file, 'albums.description 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='albums' and column_name='description')) as applied
union all
  select '029'::text as version, '029_photos_memory_pin.sql'::text as file, 'photos.pinned_at 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='pinned_at')) as applied
union all
  select '030'::text as version, '030_storage_private.sql'::text as file, 'photos 桶已转为私有'::text as expects,
         (exists (select 1 from storage.buckets where id='photos' and public = false)) as applied
union all
  select '031'::text as version, '031_delete_approve_rpc.sql'::text as file, 'public.approve_delete_request(uuid) 函数已存在'::text as expects,
         (exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='approve_delete_request')) as applied
union all
  select '032'::text as version, '032_paged_indexes.sql'::text as file, 'photos_couple_created_idx 索引已存在'::text as expects,
         (exists (select 1 from pg_indexes where schemaname='public' and indexname='photos_couple_created_idx')) as applied
) v
order by v.version;

-- ---------- 2. 汇总：还差几个 ----------
select count(*) filter (where applied) as executed,
       count(*) filter (where not applied) as pending
from (
  select '001'::text as version, '001_initial.sql'::text as file, 'public.couples 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='couples')) as applied
union all
  select '002'::text as version, '002_pokes.sql'::text as file, 'public.pokes 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='pokes')) as applied
union all
  select '003'::text as version, '003_interactive.sql'::text as file, 'pokes.kind 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='pokes' and column_name='kind')) as applied
union all
  select '004'::text as version, '004_diary.sql'::text as file, 'diary_entries.images 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='diary_entries' and column_name='images')) as applied
union all
  select '005'::text as version, '005_realtime_replica.sql'::text as file, 'public.photos 已是 REPLICA IDENTITY FULL'::text as expects,
         (exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='photos' and c.relreplident='f')) as applied
union all
  select '006'::text as version, '006_albums_table.sql'::text as file, 'public.albums 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='albums')) as applied
union all
  select '007'::text as version, '007_albums_photo_ref.sql'::text as file, 'photos.album_id 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='album_id')) as applied
union all
  select '008'::text as version, '008_albums_rls.sql'::text as file, 'albums 的 albums_all 策略已存在'::text as expects,
         (exists (select 1 from pg_policies where schemaname='public' and tablename='albums' and policyname='albums_all')) as applied
union all
  select '009'::text as version, '009_conflicts_tables.sql'::text as file, 'public.conflicts 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='conflicts')) as applied
union all
  select '010'::text as version, '010_conflicts_realtime.sql'::text as file, 'public.conflicts 已是 REPLICA IDENTITY FULL'::text as expects,
         (exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='conflicts' and c.relreplident='f')) as applied
union all
  select '011'::text as version, '011_signal_tables.sql'::text as file, 'public.signals 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='signals')) as applied
union all
  select '012'::text as version, '012_signal_realtime.sql'::text as file, 'public.signals 已是 REPLICA IDENTITY FULL'::text as expects,
         (exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='signals' and c.relreplident='f')) as applied
union all
  select '013'::text as version, '013_voice.sql'::text as file, 'messages.voice_path 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='voice_path')) as applied
union all
  select '014'::text as version, '014_message_hidden.sql'::text as file, 'public.message_hidden 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='message_hidden')) as applied
union all
  select '015'::text as version, '015_trash.sql'::text as file, 'public.trash_bin 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='trash_bin')) as applied
union all
  select '016'::text as version, '016_trash_purge.sql'::text as file, 'message_hidden.purged_at 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_hidden' and column_name='purged_at')) as applied
union all
  select '017'::text as version, '017_message_comments.sql'::text as file, 'public.message_comments 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='message_comments')) as applied
union all
  select '018'::text as version, '018_photo_original.sql'::text as file, 'photos.original_path 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='original_path')) as applied
union all
  select '019'::text as version, '019_photo_delete.sql'::text as file, 'public.delete_requests 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='delete_requests')) as applied
union all
  select '020'::text as version, '020_period.sql'::text as file, 'public.period_logs 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='period_logs')) as applied
union all
  select '021'::text as version, '021_notify_publication.sql'::text as file, 'pokes 已进入 supabase_realtime publication'::text as expects,
         (exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='pokes')) as applied
union all
  select '022'::text as version, '022_period_daily.sql'::text as file, 'public.period_daily_logs 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='period_daily_logs')) as applied
union all
  select '023'::text as version, '023_member_gender.sql'::text as file, 'members.gender 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='members' and column_name='gender')) as applied
union all
  select '024'::text as version, '024_photo_thumb.sql'::text as file, 'photos.thumb_path 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='thumb_path')) as applied
union all
  select '025'::text as version, '025_message_hidden_policy.sql'::text as file, 'message_hidden.permanent 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_hidden' and column_name='permanent')) as applied
union all
  select '026'::text as version, '026_push.sql'::text as file, 'public.push_subscriptions 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='push_subscriptions')) as applied
union all
  select '027'::text as version, '027_messages_enrich.sql'::text as file, 'public.message_reactions 表已存在'::text as expects,
         (exists (select 1 from pg_tables where schemaname='public' and tablename='message_reactions')) as applied
union all
  select '028'::text as version, '028_photos_memory_desc.sql'::text as file, 'albums.description 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='albums' and column_name='description')) as applied
union all
  select '029'::text as version, '029_photos_memory_pin.sql'::text as file, 'photos.pinned_at 列已存在'::text as expects,
         (exists (select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='pinned_at')) as applied
union all
  select '030'::text as version, '030_storage_private.sql'::text as file, 'photos 桶已转为私有'::text as expects,
         (exists (select 1 from storage.buckets where id='photos' and public = false)) as applied
union all
  select '031'::text as version, '031_delete_approve_rpc.sql'::text as file, 'public.approve_delete_request(uuid) 函数已存在'::text as expects,
         (exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='approve_delete_request')) as applied
union all
  select '032'::text as version, '032_paged_indexes.sql'::text as file, 'photos_couple_created_idx 索引已存在'::text as expects,
         (exists (select 1 from pg_indexes where schemaname='public' and indexname='photos_couple_created_idx')) as applied
) v;

-- ---------- 3. CLI 视角：这个库有没有 Supabase CLI 的迁移记录 ----------
--         · 「尚未启用」= 以前全是手工在 SQL Editor 跑的，CLI 不知道跑到哪了；
--           想接入 CLI 就对已跑过的逐个 `supabase migration repair <版本号> --status applied`，
--           版本号就是文件名前三位（001、002 …）。
--         · 「CLI 已记录」= 这段会逐条列出已登记的版本，可以和上面的指纹结果对照：
--           · CLI true / 指纹 false —— 登记了但结构对不上，需要排查
--           · CLI false / 指纹 true —— 手工跑过忘登记，用 repair 补上即可
--         结果印在「Messages」标签页（raise notice），不在结果表格里。
--
--         ⚠️ 不能写成 `select ... from supabase_migrations.schema_migrations`：
--            没用 CLI 推过的库没有这个 schema，直接查会报 42P01relation does not exist，
--            所以这里先用 to_regclass 探测（不存在返回 null，不报错）再动态执行。
do $$
declare
  tbl regclass := to_regclass('supabase_migrations.schema_migrations');
  cnt int := 0;
  rec record;
begin
  if tbl is null then
    raise notice '本库尚未启用 Supabase CLI 迁移记录（无 supabase_migrations.schema_migrations）——迁移都是手工跑的，跳过 CLI 对照。';
    return;
  end if;
  for rec in execute format('select version, name from %s order by version', tbl) loop
    cnt := cnt + 1;
    raise notice 'CLI 已记录 % : %', rec.version, coalesce(rec.name, '-');
  end loop;
  raise notice 'CLI 共登记 % 条已应用迁移', cnt;
end $$;
