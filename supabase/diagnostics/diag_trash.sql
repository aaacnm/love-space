-- 最近删除排查脚本：三条查询从上到下依次看结果
-- 全部是只读查询，随便跑，不会改数据

-- ① 回收站里到底有没有记录？
--    有行 = 删除动作被正确记录；空 = 删除发生时功能还没上线（或写入失败）
select id, kind, ref_id, deleted_by, deleted_at, expires_at, now() as "现在"
from public.trash_bin
order by deleted_at desc
limit 20;

-- ② 有没有「被软删除、但回收站里没有」的日记（功能上线前删的就会这样）
select id, author_user_id, deleted_at, left(content, 20) as 摘要
from public.diary_entries
where deleted_at is not null
order by deleted_at desc
limit 20;

-- ③ 有没有「只对自己删除、但回收站里没有」的语音
select mh.message_id, mh.user_id, mh.created_at
from public.message_hidden mh
where mh.permanent = true
  and not exists (
    select 1 from public.trash_bin t
    where t.kind = 'message' and t.ref_id = mh.message_id and t.deleted_by = mh.user_id
  );


-- ============ 下面这段是「补救」，确认上面 ②/③ 有结果、且你想把它们捞回来时再取消注释执行 ============
-- 作用：给这些漏记录的删除补一条回收站记录，之后它们就会出现在「最近删除」里，可以恢复

-- insert into public.trash_bin (couple_id, kind, ref_id, deleted_by, deleted_at, expires_at)
-- select d.couple_id, 'diary', d.id, d.author_user_id, coalesce(d.deleted_at, now()), now() + interval '3 days'
-- from public.diary_entries d
-- where d.deleted_at is not null
--   and not exists (select 1 from public.trash_bin t where t.kind = 'diary' and t.ref_id = d.id);

-- insert into public.trash_bin (couple_id, kind, ref_id, deleted_by, deleted_at, expires_at)
-- select m.couple_id, 'message', mh.message_id, mh.user_id, coalesce(mh.created_at, now()), now() + interval '3 days'
-- from public.message_hidden mh
-- join public.messages m on m.id = mh.message_id
-- where mh.permanent = true
--   and not exists (
--     select 1 from public.trash_bin t
--     where t.kind = 'message' and t.ref_id = mh.message_id and t.deleted_by = mh.user_id
--   );
