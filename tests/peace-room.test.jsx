/**
 * 矛盾处理室（037 + src/views/peace/**）
 *
 * 守的是这份设计文档里**不能被绕过**的几条：
 *   1. 严格轮流：不是「把按钮置灰」就算了 —— 发言权由服务端判定，
 *      所以前端**只能**通过 send_conflict_room_message 落库，绝不能直接 insert；
 *   2. 内容门槛：至少 10 字、不能是纯标点，明显辱骂词要拦；
 *      但「我很生气 / 我不同意 / 这让我受伤」这类真实感受必须放行；
 *   3. 发送失败保留输入内容、不切换发言权（发言权在服务端，失败就是没变）；
 *   4. 提前结束必须双方点头：一方申请只是「待确认」，不能自己把房间结束掉；
 *   5. 结束 ≠ 和好：结束态里不能出现「已和好」，只给双方各自记录感受。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import PeaceRoom from '../src/views/peace/PeaceRoom.jsx'
import Peace from '../src/views/Peace.jsx'
import { StoreProvider } from '../src/lib/store.jsx'
import { BLOCKED_TIP, validateBody } from '../src/views/peace/constants.js'
import { writeLocalSession } from './helpers/local-session.js'
import { toast } from '../src/lib/toast.jsx'

const ME = { id: 'u1' }
const TA = { id: 'u2' }
const ROOM_ID = 'r1'
const COUPLE = 'c1'

const room = (over = {}) => ({
  id: ROOM_ID,
  couple_id: COUPLE,
  created_by: ME.id,
  invited_user_id: TA.id,
  status: 'active',
  turn_user_id: ME.id,
  duration_seconds: 1200,
  invite_note: null,
  invite_expires_at: null,
  started_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  end_requested_by: null,
  ended_at: null,
  created_at: new Date().toISOString(),
  ...over,
})

const msg = (id, sender, body, at = new Date().toISOString()) => ({
  id,
  room_id: ROOM_ID,
  couple_id: COUPLE,
  sender_user_id: sender,
  body,
  client_msg_id: null,
  created_at: at,
})

const seed = (rooms = [], messages = []) =>
  resetSupabase({
    db: {
      conflict_rooms: rooms,
      conflict_room_messages: messages,
      conflict_room_feedback: [],
      conflict_room_blocked_words: [{ word: '傻逼' }, { word: '去死' }],
    },
  })

// ⚠ 默认给 send 挂一个成功 handler：RPC 返回空（data=null）在业务上表示
//   「服务端刚把房间判超时」，不是成功。桩默认返回 { data: null }，会走错分支。
const onSendOk = () =>
  sbApi.onRpc('send_conflict_room_message', async (args) => ({
    data: {
      id: 'm-new',
      room_id: ROOM_ID,
      couple_id: COUPLE,
      sender_user_id: ME.id,
      body: args.p_body,
      client_msg_id: args.p_client_msg_id,
      created_at: new Date().toISOString(),
    },
    error: null,
  }))

const renderRoom = (r, messages = []) => {
  seed([r], messages)
  onSendOk()
  return render(
    <PeaceRoom room={r} coupleId={COUPLE} user={ME} active partnerName="TA" onBack={() => {}} />,
  )
}

const settle = async (ms = 10) => {
  await act(async () => {
    await new Promise((res) => setTimeout(res, ms))
  })
}

const textarea = () => document.querySelector('textarea')

beforeEach(() => {
  seed()
})

describe('发言内容校验：保护表达，不保护情绪', () => {
  const WORDS = ['傻逼', '去死']

  it('少于 10 个字不让发', () => {
    expect(validateBody('我生气了', WORDS).ok).toBe(false)
    expect(validateBody('我生气了', WORDS).reason).toContain('至少 10 个字')
  })

  it('空白与纯标点不算内容', () => {
    expect(validateBody('            ', WORDS).ok).toBe(false)
    expect(validateBody('。。。。。。。。。。', WORDS).ok).toBe(false)
    expect(validateBody('！！！！！！！！！！', WORDS).reason).toContain('标点')
  })

  it('辱骂词命中 → 拦截，并提示平复情绪', () => {
    const r = validateBody('你就是个傻逼吧，我真的受够了', WORDS)
    expect(r.ok).toBe(false)
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe(BLOCKED_TIP)
  })

  it('负面感受、拒绝与边界必须放行（不能把情绪本身删掉）', () => {
    for (const text of [
      '我现在真的很生气，也很失望',
      '我不同意你这个说法，别再这样了',
      '你刚才那句话让我很受伤',
      '我需要一个人待一会儿',
    ]) {
      expect(validateBody(text, WORDS).ok, text).toBe(true)
    }
  })
})

describe('房间内：发言权与输入锁定', () => {
  it('轮到对方时输入框锁定，并显示「给对方一点时间」', async () => {
    renderRoom(room({ turn_user_id: TA.id }))
    await settle()
    expect(textarea().disabled).toBe(true)
    expect(textarea().placeholder).toContain('给对方一点时间')
    expect(screen.getByText('等 TA 说完')).toBeTruthy()
  })

  it('轮到自己时才能输入，提示是「慢慢说想法」', async () => {
    renderRoom(room({ turn_user_id: ME.id }))
    await settle()
    expect(textarea().disabled).toBe(false)
    expect(textarea().placeholder).toContain('慢慢说想法')
  })

  it('消息按时间正序排列，自己的在右、对方的在左', async () => {
    const t0 = new Date('2026-10-17T10:00:00').toISOString()
    const t1 = new Date('2026-10-17T10:01:00').toISOString()
    renderRoom(room(), [msg('m1', TA.id, '我先说说我的想法', t0), msg('m2', ME.id, '好的，我听你说完', t1)])
    await settle()
    const bodies = [...document.querySelectorAll('.whitespace-pre-wrap')].map((n) => n.textContent)
    expect(bodies).toEqual(['我先说说我的想法', '好的，我听你说完'])
  })
})

describe('发言：走 RPC、失败保留内容、重试幂等', () => {
  it('发送走 send_conflict_room_message 并带上幂等 ID', async () => {
    renderRoom(room())
    await settle()
    fireEvent.change(textarea(), { target: { value: '我想和你好好说说刚才那件事' } })
    await act(async () => {
      fireEvent.click(screen.getByText('发送'))
    })
    const call = stub.log.rpc.find((c) => c.name === 'send_conflict_room_message')
    expect(call).toBeTruthy()
    expect(call.args.p_room_id).toBe(ROOM_ID)
    expect(call.args.p_body).toBe('我想和你好好说说刚才那件事')
    expect(call.args.p_client_msg_id).toMatch(/^m-\d+-/)
    // 成功后清空输入框（发言权已由服务端切走）
    expect(textarea().value).toBe('')
  })

  it('发送失败：输入内容原样保留（不切换发言权、不吞掉用户写的字）', async () => {
    renderRoom(room())
    await settle()
    const text = '这段话我写了很久，不能因为网络问题就没了'
    fireEvent.change(textarea(), { target: { value: text } })
    sbApi.failRpc('send_conflict_room_message', '还没轮到你发言')
    await act(async () => {
      fireEvent.click(screen.getByText('发送'))
    })
    expect(textarea().value).toBe(text)
    expect(screen.getByText(/还没轮到你发言/)).toBeTruthy()
  })

  it('失败后重试用同一个幂等 ID（不会插出两条）', async () => {
    renderRoom(room())
    await settle()
    fireEvent.change(textarea(), { target: { value: '我再说一次刚才那句话' } })
    sbApi.failRpc('send_conflict_room_message', '网络抖动', true)
    await act(async () => {
      fireEvent.click(screen.getByText('发送'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('发送'))
    })
    const calls = stub.log.rpc.filter((c) => c.name === 'send_conflict_room_message')
    expect(calls.length).toBe(2)
    expect(calls[0].args.p_client_msg_id).toBe(calls[1].args.p_client_msg_id)
  })

  // 服务端把房间判超时时会「更新状态后正常返回空」，不再抛异常
  //（在 RPC 里「更新完再 raise」会被整个事务回滚，房间会一直停在 active）
  it('房间刚好超时：提示时间到，输入内容保留', async () => {
    renderRoom(room())
    await settle()
    sbApi.onRpc('send_conflict_room_message', async () => ({ data: null, error: null }))
    const warn = vi.spyOn(toast, 'warning')
    fireEvent.change(textarea(), { target: { value: '我想把刚才那件事说清楚' } })
    await act(async () => {
      fireEvent.click(screen.getByText('发送'))
    })
    await settle(20)
    expect(warn.mock.calls.flat().join(' ')).toContain('时间到了')
    expect(textarea().value).toBe('我想把刚才那件事说清楚')
    warn.mockRestore()
  })

  it('本地校验不通过时不发请求', async () => {
    renderRoom(room())
    await settle()
    // 断言 toast 调用而不是 DOM：兜底 viewport 是模块级单例，会被上一个用例的
    // cleanup 卸载掉，跨用例断言 DOM 会时好时坏（这里要验的是「有没有提示」）
    const warn = vi.spyOn(toast, 'warning')
    fireEvent.change(textarea(), { target: { value: '气死我了' } }) // 4 个字
    await act(async () => {
      fireEvent.click(screen.getByText('发送'))
    })
    await settle(30)
    expect(stub.log.rpc.some((c) => c.name === 'send_conflict_room_message')).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toContain('至少 10 个字')
    warn.mockRestore()
  })
})

describe('提前结束：必须双方点头', () => {
  it('我发起申请 → 只显示「等对方确认」，房间仍是沟通中', async () => {
    renderRoom(room({ end_requested_by: ME.id }))
    await settle()
    expect(screen.getByText(/等 TA 确认/)).toBeTruthy()
    expect(screen.getByText('沟通中')).toBeTruthy()
  })

  it('对方发起申请 → 我才看到「同意结束 / 还想继续聊」', async () => {
    renderRoom(room({ end_requested_by: TA.id }))
    await settle()
    expect(screen.getByText('同意结束')).toBeTruthy()
    expect(screen.getByText('还想继续聊')).toBeTruthy()
  })

  it('点「同意结束」走 respond_conflict_room_end(true)', async () => {
    renderRoom(room({ end_requested_by: TA.id }))
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByText('同意结束'))
    })
    const call = stub.log.rpc.find((c) => c.name === 'respond_conflict_room_end')
    expect(call.args).toEqual({ p_room_id: ROOM_ID, p_approve: true })
  })

  it('点「还想继续聊」= 不同意，房间继续', async () => {
    renderRoom(room({ end_requested_by: TA.id }))
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByText('还想继续聊'))
    })
    expect(stub.log.rpc.find((c) => c.name === 'respond_conflict_room_end').args.p_approve).toBe(false)
    expect(screen.getByText('沟通中')).toBeTruthy()
  })
})

describe('结束之后：记录保留，但绝不自动和好', () => {
  it('时间到：显示保存记录的文案，没有输入框', async () => {
    renderRoom(room({ status: 'timed_out', ended_at: new Date().toISOString(), turn_user_id: null }))
    await settle()
    expect(screen.getByText(/记录已保存/)).toBeTruthy()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('⚠ 结束态里不能出现「已和好」——结束只代表这次沟通停了', async () => {
    renderRoom(room({ status: 'ended_agreed', ended_at: new Date().toISOString(), turn_user_id: null }))
    await settle()
    expect(document.body.textContent).not.toContain('已和好')
    expect(screen.getByText('双方已结束本次沟通')).toBeTruthy()
  })

  it('双方各自记录感受，四个选项都在', async () => {
    renderRoom(room({ status: 'ended_agreed', ended_at: new Date().toISOString(), turn_user_id: null }))
    await settle()
    for (const label of ['已解决', '有所缓和', '还需要继续沟通', '暂时不想评价']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    await act(async () => {
      fireEvent.click(screen.getByText('还需要继续沟通'))
    })
    expect(stub.log.rpc.find((c) => c.name === 'set_conflict_room_feedback').args.p_status).toBe('need_more')
  })
})

describe('入口页：一次只开一个房间', () => {
  it('已有进行中的房间时，「发起沟通」按钮不可用', async () => {
    writeLocalSession(ME.id)
    window.localStorage.setItem(
      'love.space.v1',
      JSON.stringify({
        userId: ME.id,
        coupleId: COUPLE,
        couple: { id: COUPLE, code: 'ABC234' },
        members: [
          { id: 'mb1', couple_id: COUPLE, user_id: ME.id, nickname: '我' },
          { id: 'mb2', couple_id: COUPLE, user_id: TA.id, nickname: 'TA' },
        ],
      }),
    )
    seed([room()])
    // ⚠ resetSupabase() 会清掉之前注册的 RPC handler，每次 reset 后要重新挂：
    //   否则首屏 bootstrap 回退路径查不到 couples → 判定「不在空间」→ 把空间缓存清掉
    sbApi.onRpc('bootstrap_space', async () => ({
      data: {
        user: ME,
        couple: { id: COUPLE, code: 'ABC234' },
        members: [
          { id: 'mb1', couple_id: COUPLE, user_id: ME.id, nickname: '我' },
          { id: 'mb2', couple_id: COUPLE, user_id: TA.id, nickname: 'TA' },
        ],
        milestones: [],
      },
      error: null,
    }))
    render(
      <StoreProvider>
        <Peace />
      </StoreProvider>,
    )
    await settle()
    expect(screen.getByText('发起沟通').disabled).toBe(true)
  })
})

// ---------- 源码扫描：发言只能走服务端 RPC ----------
describe('防绕过：前端不允许直接写房间消息', () => {
  const read = (p) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8')
  const peaceFiles = ['src/views/Peace.jsx', 'src/views/peace/PeaceRoom.jsx', 'src/views/peace/usePeaceRoom.js', 'src/views/peace/usePeaceRooms.js']

  it('消息只能经 send_conflict_room_message 落库（不许 insert 绕过轮流规则）', () => {
    const hook = read('src/views/peace/usePeaceRoom.js')
    expect(hook).toContain("'send_conflict_room_message'")
    expect(hook).toMatch(/supabase\.rpc\(/) // 走 RPC，不是直接写表
    for (const f of peaceFiles) {
      const text = read(f)
      expect(text, `${f} 直接 insert 了消息表`).not.toMatch(/from\('conflict_room_messages'\)\s*\.insert/)
    }
  })

  it('⚠ 客户端拿不到房间表与消息表的写权限：策略只开 select，并且表级 revoke', () => {
    const sql = read('supabase/migrations/037_conflict_rooms.sql')
    // 策略里不能出现 for all（for all = 参与者可直接改 turn_user_id / status，绕过轮流规则）
    // ⚠ 五张表一张都不能漏：词表也一样，客户端只能读、不能改
    for (const t of [
      'conflict_rooms',
      'conflict_room_messages',
      'conflict_room_feedback',
      'conflict_room_blocked_words',
      'conflict_room_filter_hits',
    ]) {
      const policies = [...sql.matchAll(new RegExp(`create policy "\\w+" on public\\.${t}\\s*\\n?\\s*for (\\w+)`, 'g'))]
      expect(policies.length, `${t} 没有任何读策略`).toBeGreaterThan(0)
      for (const p of policies) expect(p[1], `${t} 的策略不能是 ${p[1]}`).toBe('select')
    }
    // 表级权限要收回写权限：光靠策略挡不住 Supabase 默认的 public schema 授权
    expect(sql).toMatch(/revoke all on table public\.%I from anon, authenticated/)
    expect(sql).toMatch(/grant select on table public\.%I to authenticated/)
  })

  it('邀请能送达：全局通知与推送都覆盖了新表', () => {
    const notifier = read('src/components/Notifier.jsx')
    expect(notifier).toContain("table: 'conflict_rooms'")
    expect(notifier).toContain("tab: 'peace'")
    const push = read('supabase/functions/push-send/index.ts')
    expect(push).toContain("conflict_rooms: 'created_by'")
    // 通知文案不能带矛盾内容
    expect(push).toContain('邀请你加入矛盾处理室')
    expect(push).not.toMatch(/case 'conflict_room_messages':[\s\S]{0,120}r\.(body|content)/)
  })

  it('新表已登记 Realtime 总线与字段清单（否则会退化成 select('*') / 收不到刷新）', () => {
    const bus = read('src/lib/realtimeBus.js')
    for (const t of ['conflict_rooms', 'conflict_room_messages', 'conflict_room_feedback']) {
      expect(bus).toContain(`'${t}'`)
    }
    const cols = read('src/lib/tableColumns.js')
    for (const t of ['conflict_rooms', 'conflict_room_messages', 'conflict_room_feedback']) {
      expect(cols).toContain(`${t}:`)
    }
  })
})

// sbApi 在本文件用于失败注入的可读性，避免被当作未使用
void sbApi
