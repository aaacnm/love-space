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

// ↓↓↓ 与 supabase/migrations/026_push.sql 中的 x-push-secret 保持一致 ↓↓↓
const PUSH_SECRET = 'a8682cff87a9a282684fe7f294646de075d03730814965ee'

// ↓↓↓ VAPID 身份密钥对（公开钥也写在 src/lib/push.js 里） ↓↓↓
const VAPID_PUBLIC = 'BHmLah0l1s5-aQkrWFVRgZrcttzRehRIfcAm0iCi3QewAZ-X1HwuI0H_UzaD9Ty7t6IQLBxJW-pYl2hUKaUeDKE'
const VAPID_PRIVATE = 'Ul50lc97t2SJRXB7VNThX9g7Fuu8viTf9ubPQeTR_KM'

webpush.setVapidDetails('mailto:love-journal@example.com', VAPID_PUBLIC, VAPID_PRIVATE)

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
    default:
      return '有新动态啦，点开看看'
  }
}

function clickTab(table: string): string {
  if (table === 'photos' || table === 'delete_requests') return 'photos'
  if (table.startsWith('diary')) return 'diary'
  if (table === 'period_daily_logs') return 'period'
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
        // 404/410 = 订阅已失效（浏览器卸载/长时间未用），顺手清掉
        if (status === 404 || status === 410) dead.push(s.endpoint)
      }
    }),
  )
  if (dead.length) {
    await admin.from('push_subscriptions').delete().in('endpoint', dead)
  }

  return json({ ok: true, sent, removed: dead.length })
})
