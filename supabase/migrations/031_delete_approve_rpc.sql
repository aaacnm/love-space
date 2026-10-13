-- ============================================================
--  031_delete_approve_rpc.sql · 删除审批事务 RPC：approve_delete_request
--
--  顺序要求：⚠️ 必须在 019 之后；前端「同意删除」依赖此函数，函数不在时会提示但功能不可用
--  依赖迁移：019
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='approve_delete_request')
--  check: public.approve_delete_request(uuid) 函数已存在
-- ============================================================

-- ============================================================
-- 删除审批事务化：批准 + 软删除 + 更新状态 在一个数据库事务里完成
--
-- 解决的问题：前端原来分两步（先 update 请求为 approved，再逐条软删除照片/图集），
-- 第二步失败时会出现「请求已同意、照片还在」的不一致状态。
--
-- 用法：Supabase Dashboard → SQL Editor → 粘贴执行（可重复执行）
-- 幂等：请求已是 approved 时直接返回（前端重试安全）
-- ============================================================

create or replace function public.approve_delete_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req     public.delete_requests%rowtype;
  v_uid     uuid := auth.uid();
  v_couple  uuid := public.current_couple_id();
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;
  if v_couple is null then
    raise exception '你还没有加入情侣空间';
  end if;

  -- 锁定请求行：并发批准同一条时，第二个事务会等锁，醒来后走幂等分支
  select * into v_req from public.delete_requests where id = p_request_id for update;
  if not found then
    raise exception '删除请求不存在（可能已被撤回）';
  end if;
  if v_req.couple_id <> v_couple then
    raise exception '无权处理其他空间的请求';
  end if;
  if v_req.requester_user_id = v_uid then
    raise exception '不能批准自己发起的请求';
  end if;
  -- 幂等：已经批准过就直接返回（对方重复点击 / 前端重试都安全）
  if v_req.status = 'approved' then
    return;
  end if;
  if v_req.status <> 'pending' then
    raise exception '该请求已被处理（当前状态：%）', v_req.status;
  end if;

  -- 软删除（与前端 softDelete 同语义）：
  --   图集 = 先把照片移出图集（照片本体保留），再标记图集；
  --   照片 = 标记 deleted_at 进「最近删除」躺 30 天。
  -- 「and deleted_at is null」守卫：已躺在回收站里的不重复标记。
  -- 注：purge 字段与前端行为保持一致——审批通过一律先进最近删除，
  --     彻底删除是回收站里的个人操作，不走这条审批链。
  if v_req.kind = 'album' then
    update public.photos set album_id = null
      where album_id = any(v_req.ref_ids);
    update public.albums
      set deleted_at = now(), deleted_by = v_uid
      where id = any(v_req.ref_ids) and deleted_at is null;
  else
    update public.photos
      set deleted_at = now(), deleted_by = v_uid
      where id = any(v_req.ref_ids) and deleted_at is null;
  end if;

  update public.delete_requests
    set status = 'approved', responder_user_id = v_uid, resolved_at = now()
    where id = p_request_id;
end;
$$;

-- 权限：只给登录用户执行（security definer 函数默认会授给 public，收掉）
revoke all on function public.approve_delete_request(uuid) from public;
grant execute on function public.approve_delete_request(uuid) to authenticated;

-- ---------- 自查（应返回 1 行 + 3 条授权） ----------
-- select proname, prosecdef from pg_proc where proname = 'approve_delete_request';
