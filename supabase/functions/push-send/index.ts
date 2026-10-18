// ============================================================
//  恋爱手账 · Web Push 发送端（push-send）
//
//  部署方式（全程浏览器操作，无需命令行）：
//    Supabase Dashboard → 左侧 Edge Functions → Create a new function
//    → 选「通过编辑器写代码」→ 函数名填 push-send → 用本文件内容替换模板
//    → 「Verify JWT」开关如果存在，关掉（本函数用 x-push-secret 自行校验，
//       数据库 Webhook 不带 JWT）→ Deploy
//
//  触发来源（两路，都要求带 x-push-secret 头）：
//    ① 数据库触发器（supabase/migrations/026_push.sql 建好）：7 张表 INSERT → 自动调用
//       请求体形如 { type:'INSERT', table:'messages', record:{...} }
//    ② 手动/客户端调用：{ target_user_id, title, body, tab }
//
//  行为：找到情侣里的另一位 → 查 TA 的 push_subscriptions → Web Push 送达
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

// ---------- 密钥：只从部署环境变量读，绝不写进仓库 ----------
// ⚠ 2026-10-17 轮换：原先这三个值硬编码在源码里，一旦仓库/部署包外泄就等于密钥外泄。
//   现在全部走 Supabase Secrets（部署 → Edge Functions → Secrets）：
//     supabase secrets set PUSH_SECRET=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...
//   数据库侧的 x-push-secret 由 038_push_secrets.sql 改成从 Vault 读同一个值。
//   配不齐就明确报 500，不带任何回退（宁可停推，也不要静默用错密钥）。
const PUSH_SECRET = Deno.env.get('PUSH_SECRET') || ''
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') || ''
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') || ''

const missingSecrets = () =>
  [
    !PUSH_SECRET ? 'PUSH_SECRET' : null,
    !VAPID_PUBLIC ? 'VAPID_PUBLIC_KEY' : null,
    !VAPID_PRIVATE ? 'VAPID_PRIVATE_KEY' : null,
  ].filter(Boolean) as string[]

if (!missingSecrets().length) {
  webpush.setVapidDetails('mailto:love-journal@example.com', VAPID_PUBLIC, VAPID_PRIVATE)
}

// 各表的「作者」字段：谁插入的行就通知另一个人
const AUTHOR_COLS: Record<string, string> = {
  messages: 'author_user_id',
  photos: 'author_user_id',
  diary_entries: 'author_user_id',
  diary_comments: 'author_user_id',
  message_comments: 'author_user_id',
  delete_requests: 'requester_user_id',
  period_daily_logs: 'user_id',
  pokes: 'from_user_id',
  // 矛盾处理室（037）：邀请按「发起者」推给另一位；房间消息按发送者推给另一位
  conflict_rooms: 'created_by',
  conflict_room_messages: 'sender_user_id',
}

// 通知文案（和 App 内横幅同款语气）
function excerpt(s: unknown, n = 26): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function buildText(table: string, r: Record<string, unknown>): string {
  switch (table) {
    case 'messages':
      return r.image_path
        ? '给你发来一张图片留言 🖼️'
        : r.voice_path
          ? `给你发来一条语音留言${r.voice_seconds ? `（${r.voice_seconds}″）` : ''}`
          : r.reply_to
            ? `回复了你的留言：${excerpt(r.content)}`
            : `给你留言：${excerpt(r.content)}`
    case 'photos':
      return '分享了一张新照片'
    case 'diary_entries':
      return `写了新日记：${excerpt(r.content)}`
    case 'diary_comments':
      return `评论了你的日记：${excerpt(r.content)}`
    case 'message_comments':
      return `回复了留言：${excerpt(r.content)}`
    case 'delete_requests':
      return '申请删除照片，等你确认'
    case 'period_daily_logs':
      return '更新了生理期打卡'
    case 'pokes':
      return r.kind === 'chat' ? '想和你聊聊，快来 💬' : r.kind === 'comfort' ? '摸了摸你的头 🫂' : '戳了戳你，想你了 💗'
    // ⚠ 矛盾处理室的通知绝不携带矛盾内容：只说「有邀请 / 有新消息」
    case 'conflict_rooms':
      return '邀请你加入矛盾处理室'
    case 'conflict_room_messages':
      return '在矛盾处理室说了新的话'
    default:
      return '有新动态啦，点开看看'
  }
}

function clickTab(table: string): string {
  if (table === 'photos' || table === 'delete_requests') return 'photos'
  if (table.startsWith('diary')) return 'diary'
  if (table === 'period_daily_logs') return 'period'
  if (table.startsWith('conflict_room')) return 'peace'
  return 'messages'
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-push-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // 配置自检：密钥没配齐就直说，不要用「forbidden」把配置问题伪装成鉴权问题
  const missing = missingSecrets()
  if (missing.length) {
    return json({ error: `Edge Function 缺少环境变量：${missing.join(', ')}`, hint: 'supabase secrets set …' }, 500)
  }

  if (req.method === 'GET') return json({ ok: true, hint: 'POST with x-push-secret header' })

  // 共享密钥校验：数据库触发器与手动调用都必须带上
  if ((req.headers.get('x-push-secret') || '') !== PUSH_SECRET) {
    return json({ error: 'forbidden' }, 403)
  }

  let body: Record<string, any> = {}
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // 解析目标用户：手动模式直接给 target_user_id；Webhook 模式从 record 里找情侣另一位
  let targetUserId: string | null = body.target_user_id ?? null
  let text: string | null = body.body ?? null
  let tab: string | null = body.tab ?? null
  let nickname = ''

  if (!targetUserId) {
    const table = String(body.table || '')
    const record = body.record || {}
    const authorCol = AUTHOR_COLS[table]
    const author = authorCol ? record[authorCol] : null
    const coupleId = record.couple_id
    if (!authorCol || !author || !coupleId) return json({ ok: true, skipped: 'no author/couple' })

    const { data: members, error } = await admin
      .from('members')
      .select('user_id, nickname')
      .eq('couple_id', coupleId)
    if (error) return json({ error: error.message }, 500)

    const target = (members || []).find((m) => m.user_id !== author)
    if (!target) return json({ ok: true, skipped: 'no partner' })
    targetUserId = target.user_id
    nickname = target.nickname || 'TA'
    text = buildText(table, record)
    tab = clickTab(table)
  }

  // 查对方的全部推送订阅
  const { data: subs, error: subErr } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', targetUserId)
  if (subErr) return json({ error: subErr.message }, 500)
  if (!subs || subs.length === 0) return json({ ok: true, sent: 0, note: 'no subscription' })

  const payload = JSON.stringify({
    title: `💗 ${nickname || 'TA'}`,
    body: text || '有新动态啦，点开看看',
    tab: tab || 'messages',
    tag: 'love-' + (tab || 'home'),
  })

  let sent = 0
  const dead: string[] = []
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        )
        sent++
      } catch (e) {
        const status = e?.statusCode || 0
        // 404/410 = 订阅已失效（浏览器卸载/长时间未用）
        // 403 = VAPID 密钥不匹配（换过密钥对后旧订阅会这样）→ 同样清掉，
        //       用户下次开 App 时 enablePush 会重新登记（见 src/lib/push.js）
        if (status === 404 || status === 410 || status === 403) dead.push(s.endpoint)
      }
    }),
  )
  if (dead.length) {
    await admin.from('push_subscriptions').delete().in('endpoint', dead)
  }

  return json({ ok: true, sent, removed: dead.length })
})
