-- ============================================================
--  立即修复：push_secret() 不该被任何已登录用户调用（P1）
--
--  问题：038 曾经写了 `grant execute on function public.push_secret() to authenticated`。
--        push_secret() 返回的是 Vault 里的**明文共享密钥**（x-push-secret），
--        任何登录用户都能用 PostgREST 的 /rpc/push_secret 拿到它，
--        然后自己构造请求让 push-send 给任意订阅者推任意内容。
--
--  用法：Supabase 控制台 → SQL Editor → 整段粘贴 → Run。
--  幂等：是，重复执行无害。
-- ============================================================

-- ---------- ① 先看现状（两列都必须是 false 才安全） ----------
select has_function_privilege('anon', 'public.push_secret()', 'EXECUTE')          as anon能调用_必须false,
       has_function_privilege('authenticated', 'public.push_secret()', 'EXECUTE') as 登录用户能调用_必须false,
       has_function_privilege('postgres', 'public.push_secret()', 'EXECUTE')      as 所有者能调用_必须true;

-- 顺带列出这张函数上还挂着哪些授权（PUBLIC 那条尤其危险：anon 也属于 PUBLIC）
select coalesce(grantee, '—') as 被授权角色, string_agg(privilege_type, ', ') as 权限
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'push_secret'
group by 1
order by 1;

-- ---------- ② 修复：客户端角色一个都不给 ----------
revoke all on function public.push_secret() from public;
revoke all on function public.push_secret() from anon, authenticated;

-- ---------- ③ 复查（①②两列都应为 false，③仍为 true） ----------
select has_function_privilege('anon', 'public.push_secret()', 'EXECUTE')          as anon能调用_期望false,
       has_function_privilege('authenticated', 'public.push_secret()', 'EXECUTE') as 登录用户能调用_期望false,
       has_function_privilege('postgres', 'public.push_secret()', 'EXECUTE')      as 所有者能调用_期望true;

-- ---------- ④ 为什么撤销之后触发器还能推得出去 ----------
-- fn_push_notify() 是 security definer，以**函数所有者**身份执行；
-- 所有者天然拥有自己函数的执行权，不需要任何 grant。
-- 两者是同一条迁移、同一角色创建的 → 所有者相同，链路成立。
select p.proname as 函数,
       pg_get_userbyid(p.proowner) as 所有者,
       p.prosecdef as security_definer,
       (p.proconfig::text like '%search_path%') as 固定了search_path
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('push_secret', 'fn_push_notify')
order by 1;

-- ---------- ⑤ 外部验证（本地终端，用 anon key 即可） ----------
-- 期望：HTTP 404 PGRST202（PostgREST 看不见这个函数 = 调不到）
--   curl -s -o /dev/null -w "%{http_code}\n" \
--     -X POST "https://<ref>.supabase.co/rest/v1/rpc/push_secret" \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
--
-- 只修完 ①② 还不够 —— PostgREST 有 schema cache，要让它立刻重载：
notify pgrst, 'reload schema';
