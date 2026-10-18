/**
 * 图片链路：三档各管一段 + 签名 URL 跨会话复用 + 首图优先级 + 灯箱 srcset
 *
 * 三档的分工（谁越界就是流量事故）：
 *   480  → 列表 / 卡片 / 封面（一屏十几张，必须小）
 *   1280 → 灯箱（一屏一张，可以大一点；上传时就把主图压到 1280，不必再麻烦服务端变换）
 *   原图 → 保存 / 下载 / 导出，平时绝不出现在 <img> 的加载路径里
 *
 * 跨会话复用是最关键的一条：签名 URL 的 token 带过期时间，同一文件每次签出来的 URL
 * 都不一样，而浏览器缓存按完整 URL 当 key —— URL 一变就是 miss，图得重新下载。
 * 让 URL 能被复用，缓存才谈得上有用。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { StoreProvider } from '../src/lib/store.jsx'
import { signedMediaUrl, clearSignedUrlCache } from '../src/lib/storage.js'
import { THUMB_TF } from '../src/lib/mediaUrls.js'
import { writeLocalSession } from './helpers/local-session.js'
import Messages from '../src/views/Messages.jsx'
import PhotoGrid from '../src/views/photos/PhotoGrid.jsx'

const USER = { id: 'u1', is_anonymous: true }
const ME = { id: 'mb1', couple_id: 'c1', user_id: 'u1', nickname: '我', city: '上海', timezone: 'Asia/Shanghai' }
const TA = { id: 'mb2', couple_id: 'c1', user_id: 'u2', nickname: 'TA', city: '北京', timezone: 'Asia/Shanghai' }
const COUPLE = { id: 'c1', code: 'ABC234' }
const nowIso = () => new Date().toISOString()
const todayIso = (hour) => {
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

const photo = (id, over = {}) => ({
  id,
  couple_id: 'c1',
  author_user_id: 'u1',
  storage_path: `photos/c1/${id}.jpg`,
  thumb_path: `thumbs/c1/${id}.jpg`,
  created_at: nowIso(),
  ...over,
})
const msg = (id, over = {}) => ({
  id,
  couple_id: 'c1',
  author_user_id: 'u1',
  content: '',
  created_at: nowIso(),
  ...over,
})

function seedSpace() {
  window.localStorage.setItem(
    'love.space.v1',
    JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      userId: USER.id,
      user: USER,
      coupleId: COUPLE.id,
      couple: COUPLE,
      members: [ME, TA],
      milestones: [],
      derived: { anniversary: null, nextMeetup: null },
    }),
  )
  writeLocalSession(USER.id) // 本机会话确认后 store 才会认领这份空间缓存
}

function boot(extraDb = {}) {
  resetSupabase({ db: { couples: [COUPLE], members: [ME, TA], ...extraDb } })
  sbApi.setUser(USER)
  sbApi.onRpc('bootstrap_space', async () => ({
    data: { user: USER, couple: COUPLE, members: [ME, TA], milestones: [], anniversary: null, next_meetup: null },
    error: null,
  }))
}

const STORE_KEY = 'love.sign.v1'
const store = () => JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}')
const signCount = () => stub.log.sign.length

beforeEach(() => {
  window.localStorage.clear()
  seedSpace()
})

describe('签名 URL 跨会话复用', () => {
  it('同一路径只签一次：第二次直接走缓存', async () => {
    boot()
    const a = await signedMediaUrl('photos', 'photos/c1/a.jpg')
    expect(a).toContain('https://sign.test/')
    expect(signCount()).toBe(1)

    const b = await signedMediaUrl('photos', 'photos/c1/a.jpg')
    expect(b).toBe(a) // URL 完全一致 —— 这才是浏览器缓存能命中的前提
    expect(signCount()).toBe(1)
  })

  it('带上变换是另一份缓存（480 缩略图与大图不互相顶掉）', async () => {
    boot()
    const full = await signedMediaUrl('photos', 'photos/c1/a.jpg')
    const thumb = await signedMediaUrl('photos', 'photos/c1/a.jpg', THUMB_TF)
    expect(signCount()).toBe(2)
    expect(thumb).not.toBe(full)
  })

  it('关页面时落盘：下次打开直接可用，不用再签', async () => {
    boot()
    const url = await signedMediaUrl('photos', 'photos/c1/a.jpg')

    // 浏览器切后台/关页面：立刻落盘（不等 300ms 的合并写）
    window.dispatchEvent(new Event('pagehide'))

    const saved = store()
    const key = 'photos|photos/c1/a.jpg|'
    expect(Object.keys(saved)).toHaveLength(1)
    expect(saved[key].url).toBe(url)
    // 过期时间一定要跟着存：不然 token 失效了还在复用，就是一堆 403
    expect(saved[key].exp).toBeGreaterThan(Date.now())
  })

  it('落盘的内容不会无限长：超过上限就丢最旧的', async () => {
    boot()
    for (let i = 0; i < 305; i += 1) await signedMediaUrl('photos', `photos/c1/p${i}.jpg`)
    window.dispatchEvent(new Event('pagehide'))
    expect(Object.keys(store()).length).toBe(300)
  })

  it('清空缓存（换空间/测试隔离）后要重新签', async () => {
    boot()
    await signedMediaUrl('photos', 'photos/c1/a.jpg')
    clearSignedUrlCache()
    expect(store()).toEqual({})
    await signedMediaUrl('photos', 'photos/c1/a.jpg')
    expect(signCount()).toBe(2)
  })

  it('绝不把签名 URL 交给 Service Worker 缓存', () => {
    const sw = require('node:fs').readFileSync('public/sw.js', 'utf8')
    // 跨域（Supabase Storage）在 fetch 处理的最前面就被挡掉了
    expect(sw).toMatch(/url\.origin !== location\.origin[\s\S]{0,80}return/)
    // 缓存里只留同源的两个，也不存在把图片存进 SW 的路径
    expect(sw).not.toMatch(/storage|signedUrl|token=/)
  })
})

describe('留言配图：卡片只下 480 缩略图', () => {
  it('卡片上的图走 480 cover 变换，不是直接签 1280 的原文件', async () => {
    boot({
      messages: [
        msg('m1', { image_path: 'messages/c1/a.jpg', created_at: todayIso(10) }),
        msg('m2', { image_path: 'messages/c1/b.jpg', created_at: todayIso(9) }),
      ],
    })
    render(
      <StoreProvider>
        <Messages />
      </StoreProvider>,
    )
    await waitFor(() => expect(stub.log.sign.length).toBeGreaterThan(0))

    const thumbs = stub.log.sign.filter(
      (s) => s.opts?.transform?.width === 480 && s.opts?.transform?.resize === 'cover',
    )
    expect(thumbs.length).toBeGreaterThanOrEqual(2)
    // 语音仍是批量签（音频没有变换可用）
    expect(stub.log.sign.some((s) => Array.isArray(s.paths))).toBe(false)
  })

  it('首屏只有第一张图是 high 优先级，其余保持 lazy', async () => {
    boot({
      messages: [
        msg('m1', { image_path: 'messages/c1/a.jpg', created_at: todayIso(10) }),
        msg('m2', { image_path: 'messages/c1/b.jpg', created_at: todayIso(9) }),
      ],
    })
    render(
      <StoreProvider>
        <Messages />
      </StoreProvider>,
    )
    const imgs = await waitFor(() => {
      const found = document.querySelectorAll('img[alt="图片留言"]')
      expect(found.length).toBe(2)
      return found
    })

    expect(imgs[0].getAttribute('fetchpriority')).toBe('high')
    expect(imgs[0].getAttribute('loading')).toBe('eager')
    // 全标 high 等于全没标
    expect(imgs[1].getAttribute('fetchpriority')).toBeNull()
    expect(imgs[1].getAttribute('loading')).toBe('lazy')
  })

  it('灯箱给两档 srcset，让手机只取 1280', async () => {
    boot({ messages: [msg('m1', { image_path: 'messages/c1/a.jpg' })] })
    render(
      <StoreProvider>
        <Messages />
      </StoreProvider>,
    )
    const cards = await waitFor(() => {
      const found = document.querySelectorAll('img[alt="图片留言"]')
      expect(found.length).toBe(1)
      return found
    })
    fireEvent.click(cards[0])

    const big = await waitFor(() => {
      const el = document.querySelector('img[alt="图片留言"][srcset]')
      expect(el).toBeTruthy()
      return el
    })
    const srcset = big.getAttribute('srcset')
    expect(srcset).toContain('1280w')
    expect(srcset).toContain('1600w')
    expect(big.getAttribute('sizes')).toBe('92vw')
  })
})

describe('照片墙：首屏第一张才抢优先级', () => {
  const grid = (list) =>
    render(
      <PhotoGrid
        active={{ kind: 'unfiled' }}
        list={list}
        loading={false}
        browseMode="grid"
        setBrowseMode={() => {}}
        selectMode={false}
        setSelectMode={() => {}}
        setSelected={() => {}}
        selected={[]}
        dragPhoto={null}
        setDragPhoto={() => {}}
        setDragOverAlbum={() => {}}
        toggleSelect={() => {}}
        setView={() => {}}
        timelineGroups={[]}
        pinnedFirst={(l) => l}
        thumbSrcOf={() => 'https://sign.test/x.jpg'}
        liveAlbums={[]}
        pendingPhotoIds={new Set()}
        hasMore={false}
        loadingMore={false}
        loadMore={() => {}}
      />,
    )

  it('第一张 eager + fetchpriority=high，第二张起 lazy', () => {
    grid([photo('p1'), photo('p2'), photo('p3'), photo('p4')])
    const imgs = document.querySelectorAll('img')
    expect(imgs.length).toBe(4)
    expect(imgs[0].getAttribute('fetchpriority')).toBe('high')
    expect(imgs[0].getAttribute('loading')).toBe('eager')
    for (const el of [...imgs].slice(1)) {
      expect(el.getAttribute('fetchpriority')).toBeNull()
      expect(el.getAttribute('loading')).toBe('lazy')
    }
  })
})
