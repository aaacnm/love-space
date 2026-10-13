import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { lookupCity, distanceKm } from '../lib/cities.js'
import { todayStr } from '../lib/hooks.js'
import { Card, Button, Modal, Field, TextInput } from './ui.jsx'

const MAP_KEY = import.meta.env.VITE_TENCENT_MAP_KEY || ''

let tmapPromise = null
function loadTMap(key) {
  if (window.TMap) return Promise.resolve(window.TMap)
  if (!tmapPromise) {
    tmapPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = `https://map.qq.com/api/gljs?v=1.exp&key=${key}`
      s.onload = () => resolve(window.TMap)
      s.onerror = () => reject(new Error('腾讯地图 SDK 加载失败'))
      document.head.appendChild(s)
    })
  }
  return tmapPromise
}

const pin = (color) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="9" fill="${color}" stroke="#fff" stroke-width="3"/></svg>`,
  )}`

function zoomFor(km) {
  if (km > 2500) return 4
  if (km > 1200) return 5
  if (km > 600) return 6
  if (km > 300) return 7
  if (km > 150) return 8
  return 9
}

function daysSince(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const then = new Date(y, m - 1, d).getTime()
  const now = new Date().setHours(0, 0, 0, 0)
  return Math.max(0, Math.floor((now - then) / 86400000))
}

// bare = true 时用在弹窗内部（不套外层 Card）
export default function DistanceCard({ bare = false }) {
  const { coupleId, myMember, partner, milestones, refresh } = useStore()
  const mapRef = useRef(null)
  const [showMeet, setShowMeet] = useState(false)
  const [meetDate, setMeetDate] = useState('')
  const [saving, setSaving] = useState(false)

  const me = useMemo(() => lookupCity(myMember?.city), [myMember?.city])
  const ta = useMemo(() => lookupCity(partner?.city), [partner?.city])
  const km = me && ta ? distanceKm(me, ta) : null

  const today = todayStr()
  const lastMeetup = useMemo(
    () =>
      milestones
        .filter((m) => m.type === 'meetup' && m.date < today)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null,
    [milestones, today],
  )
  const apartDays = lastMeetup ? daysSince(lastMeetup.date) : null

  // 腾讯地图渲染（未配置 key 时自动降级为示意图）
  useEffect(() => {
    if (!MAP_KEY || !me || !ta || !mapRef.current) return
    let map = null
    let cancelled = false
    loadTMap(MAP_KEY)
      .then((TMap) => {
        if (cancelled || !mapRef.current) return
        map = new TMap.Map(mapRef.current, {
          center: new TMap.LatLng((me.lat + ta.lat) / 2, (me.lng + ta.lng) / 2),
          zoom: zoomFor(km),
        })
        new TMap.MultiMarker({
          map,
          styles: {
            a: new TMap.MarkerStyle({ width: 28, height: 28, anchor: { x: 14, y: 14 }, src: pin('#E97B92') }),
            b: new TMap.MarkerStyle({ width: 28, height: 28, anchor: { x: 14, y: 14 }, src: pin('#F6A6B4') }),
          },
          geometries: [
            { id: 'me', styleId: 'a', position: new TMap.LatLng(me.lat, me.lng) },
            { id: 'ta', styleId: 'b', position: new TMap.LatLng(ta.lat, ta.lng) },
          ],
        })
        new TMap.MultiPolyline({
          map,
          styles: { line: new TMap.PolylineStyle({ color: '#E97B92', width: 4, borderWidth: 0 }) },
          geometries: [
            {
              styleId: 'line',
              paths: [new TMap.LatLng(me.lat, me.lng), new TMap.LatLng(ta.lat, ta.lng)],
            },
          ],
        })
      })
      .catch((e) => console.error('地图加载失败，已降级为示意图', e))
    return () => {
      cancelled = true
      if (map) map.destroy()
    }
  }, [me, ta, km])

  const openMeet = () => {
    setMeetDate(lastMeetup?.date || '')
    setShowMeet(true)
  }

  const saveMeet = async () => {
    if (!meetDate) return
    setSaving(true)
    const { error } = await supabase.from('milestones').upsert(
      { id: lastMeetup?.id, couple_id: coupleId, type: 'meetup', title: '上次见面', date: meetDate },
      { onConflict: 'id' },
    )
    setSaving(false)
    if (!error) {
      setShowMeet(false)
      refresh()
    }
  }

  if (!me || !ta) {
    const tip = (
      <>
        <p className="text-sm font-bold text-cocoaSoft">我们之间</p>
        <p className="mt-2 text-sm text-cocoaSoft">
          两个人都要填好城市才会显示距离。去首页「编辑我的资料」里把城市写成具体地名（如 杭州 / 成都 / 北京）。
        </p>
      </>
    )
    return bare ? <div className="rounded-card bg-white p-4 shadow-soft">{tip}</div> : <Card>{tip}</Card>
  }

  const body = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-bold text-cocoaSoft">我们之间</p>
        <button onClick={openMeet} className="text-xs font-bold text-rosy">
          {lastMeetup ? '改上次见面' : '记录上次见面'}
        </button>
      </div>

      <div className="relative h-56 w-full overflow-hidden rounded-2xl bg-cream">
        {MAP_KEY ? (
          <>
            <div ref={mapRef} className="h-full w-full" />
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1 text-sm font-bold text-rosy shadow-soft">
              直线距离 {km} km
            </div>
          </>
        ) : (
          <Schematic me={me} ta={ta} km={km} myName={myMember?.nickname} taName={partner?.nickname} />
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-cream px-3 py-3 text-center">
          <div className="font-display text-2xl leading-none text-rosy">{km}</div>
          <div className="mt-1 text-xs text-cocoaSoft">公里（直线）</div>
        </div>
        <div className="rounded-2xl bg-cream px-3 py-3 text-center">
          <div className="font-display text-2xl leading-none text-blush">
            {apartDays === null ? '--' : apartDays}
          </div>
          <div className="mt-1 text-xs text-cocoaSoft">已分开（天）</div>
        </div>
      </div>

      <p className="mt-2 text-center text-xs text-cocoaSoft/70">
        {me.region === me.name ? me.name : `${me.region}·${me.name}`} ↔{' '}
        {ta.region === ta.name ? ta.name : `${ta.region}·${ta.name}`}
      </p>

      {apartDays === null && (
        <p className="mt-1 text-center text-xs text-cocoaSoft/70">
          点右上角记录上次见面的日子，这里就开始数「分开多少天」了
        </p>
      )}
    </>
  )

  const meetModal = (
    <Modal open={showMeet} onClose={() => setShowMeet(false)} title="上次见面的日子">
      <div className="space-y-4">
        <Field label="日期">
          <TextInput type="date" value={meetDate} onChange={(e) => setMeetDate(e.target.value)} />
        </Field>
        <Button className="w-full" onClick={saveMeet} disabled={saving || !meetDate}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </Modal>
  )

  if (bare) {
    return (
      <div className="rounded-card bg-white p-4 shadow-soft">
        {body}
        {meetModal}
      </div>
    )
  }

  return (
    <Card>
      {body}
      {meetModal}
    </Card>
  )
}

// 未配置地图 key 时的示意图（纯 SVG，不依赖任何地图服务）
function Schematic({ me, ta, km, myName, taName }) {
  return (
    <div className="flex h-full items-center justify-center px-4">
      <svg viewBox="0 0 320 140" className="h-full w-full">
        <path
          d="M60 92 Q160 22 260 92"
          fill="none"
          stroke="#E97B92"
          strokeWidth="2"
          strokeDasharray="6 6"
        />
        <circle cx="60" cy="92" r="12" fill="#E97B92" />
        <circle cx="260" cy="92" r="12" fill="#F6A6B4" />
        <text x="60" y="122" textAnchor="middle" className="fill-cocoa" fontSize="13" fontWeight="bold">
          {me.name}
        </text>
        <text x="260" y="122" textAnchor="middle" className="fill-cocoa" fontSize="13" fontWeight="bold">
          {ta.name}
        </text>
        <text x="160" y="46" textAnchor="middle" className="fill-rosy" fontSize="15" fontWeight="bold">
          {km} km
        </text>
        <text x="160" y="64" textAnchor="middle" className="fill-cocoaSoft" fontSize="11">
          {myName || '我'} ↔ {taName || 'TA'}
        </text>
      </svg>
    </div>
  )
}
