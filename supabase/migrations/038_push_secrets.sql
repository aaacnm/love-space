-- ============================================================
--  038_push_secrets.sql · 推送密钥出仓：数据库侧改从 Vault 读
--
--  顺序要求：必须在 026 之后（覆盖它建的 fn_push_notify）
--  依赖迁移：026
--  幂等：是，可重复执行（create or replace）
--
--  fingerprint: exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='push_secret')
--  check: public.push_secret() 函数已存在
-- ============================================================

-- ============================================================
-- 为什么要这一条迁移：
--   026 把共享密钥（x-push-secret）**明文写进了函数体**，而函数体就是仓库里的
--   一个 .sql 文件；Edge Function 那边同样把 VAPID 私钥硬编码在源码里。
--   只要仓库或部署包曾被外人看到，这两个值就该视为**已泄露**：
--     · 拿到共享密钥 = 可以自己构造请求让云函数给对方推任何内容；
--     · 拿到 VAPID 私钥 = 可以冒充本站给已订阅的用户推消息。
--   所以做两件事（本迁移负责第 ① 件，第 ② 件在 Edge Function / Secrets 那边）：
--     ① 数据库里的密钥不再进代码：改从 Supabase Vault 读；
--     ② 密钥本身轮换：见 PUSH_SETUP.md 的「密钥轮换」一节。
--
-- 配置方式（只需一次）：
--   select vault.create_secret('新的共享密钥', 'push_secret');
--   -- 以后轮换：select vault.update_secret(<id>, '新值') 或删了重建
-- 没配会怎样：push_secret() 返回 null → 触发器记一条 warning 并跳过推送，
--   **不会**带着空密钥去请求云函数（那只会换来一堆 403）。
-- ============================================================

-- ---------- 1. 读密钥的小函数 ----------
create or replace function public.push_secret()
returns text
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  -- ⚠ Vault 没启用时 `select ... from vault.decrypted_secrets` 会在语义分析阶段
  --   就炸（42P01，用 CASE 也包不住）→ 先用 to_regclass() 探测，没有就返回 null。
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = ''push_secret'' limit 1'
    into v_secret;

  return nullif(v_secret, '');
end;
$$;

-- ⚠⚠ 这个函数返回的是**明文共享密钥**，绝不能让客户端角色调得到：
--    拿到它 = 可以自己构造请求，让 push-send 给任意订阅者推任意内容。
--
--    两个必须知道的事实（都是踩出来的）：
--    · ⚠ **只写 `revoke ... from public` 是挡不住的**。Supabase 在 public schema 上
--      设了 `alter default privileges ... grant all on functions to
--      postgres, anon, authenticated, service_role` —— 函数**一创建**就自动被授予
--      anon / authenticated。这种授权是逐角色的（不是走 PUBLIC），revoke PUBLIC
--      碰不到它。实测：线上 `GET /rest/v1/rpc/push_secret` 用匿名 key 直接 200，
--      响应体就是那段共享密钥（PostgREST 把 public schema 的函数都暴露成 RPC）。
--    · 曾经额外写过 `grant execute ... to authenticated`，那句话等于把密钥直接
--      发给所有登录用户。
--      → 结论：必须显式 revoke anon + authenticated，客户端角色一个都不给。
--
--    那触发器怎么调得到？fn_push_notify() 是 security definer，以**函数所有者**
--    的身份执行，所有者天然拥有自己函数的执行权（不需要任何 grant）。
--    两个函数是同一条迁移、同一个角色建的 → 所有者相同，链路成立。
revoke all on function public.push_secret() from public;
revoke all on function public.push_secret() from anon, authenticated;

-- 验证（期望两个都 false，在 SQL Editor 里跑）：
--   select has_function_privilege('anon', 'public.push_secret()', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.push_secret()', 'EXECUTE');

-- ---------- 2. 触发函数：密钥来自 Vault，不再是代码里的字面量 ----------
create or replace function public.fn_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_secret text;
begin
  v_secret := public.push_secret();
  if v_secret is null then
    -- 没配密钥就明确跳过：宁可停推，也不要拿空值去撞云函数的鉴权
    raise warning '[push] 未配置 Vault 密钥 push_secret，本次推送已跳过（见 038_push_secrets.sql）';
    return NEW;
  end if;

  perform net.http_post(
    url := 'https://wengwenilnywpijuraqn.supabase.co/functions/v1/push-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_secret
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

-- ---------- 3. 轮换后：清掉用旧 VAPID 登记的订阅 ----------
-- 换了 VAPID 密钥对，旧订阅一律推不动（403）。云函数已经会把 403 的订阅删掉，
-- 这里再给一次「一次性清空」的选择（想立刻让所有人重新登记就解开注释执行）：
-- delete from public.push_subscriptions;

-- 让 PostgREST 立刻看见新对象（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';
