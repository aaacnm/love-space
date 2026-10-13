import { useMemo, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { useCollection } from '../lib/hooks.js'
import { Button, Modal, Field, TextInput, EmptyState, Spinner, SectionTitle, ConfirmModal } from '../components/ui.jsx'
import { useToast } from '../lib/toast.jsx'
import {
  FLOWS,
  MOODS,
  PAINS,
  PHASE_INFO,
  PHASE_STYLES,
  SYMPTOMS,
  buildMarks,
  careCard,
  checkinSummary,
  clamp,
  computeCycle,
  dayKey,
  diffDays,
  fmtFull,
  fmtMD,
  monthGrid,
  partnerCareActions,
} from './period/periodCalc.js'
// 周期计算已迁到 period/periodCalc.js：这两个是转出，既有测试通过 bundle 具名导入它们
export { computeCycle, buildMarks, partnerCareActions }

// ---------- 日期工具（全部本地时区，'YYYY-MM-DD' 字符串运算） ----------
export default function Period() {
  const { coupleId, user, members, myMember } = useStore()
  const { rows: logs, loading, reload } = useCollection('period_logs', coupleId, {
    orderBy: 'start_date',
    ascending: false,
  })
  const { rows: settingRows, reload: reloadSettings } = useCollection('period_settings', coupleId, {
    orderBy: 'updated_at',
    ascending: false,
  })
  const { rows: dailyRows, reload: reloadDaily } = useCollection('period_daily_logs', coupleId, {
    orderBy: 'log_date',
    ascending: false,
  })
  const settings = settingRows[0] || null

  const memberMap = useMemo(() => Object.fromEntries((members || []).map((m) => [m.user_id, m])), [members])
  const partnerName = members?.find((m) => m.user_id !== user?.id)?.nickname || 'TA'

  const todayKey = dayKey(new Date())
  const C = useMemo(() => computeCycle(logs, settings, todayKey), [logs, settings, todayKey])
  const marks = useMemo(() => buildMarks(C), [C])
  const care = useMemo(() => careCard(C), [C])

  // 周期分析
  const stats = useMemo(() => {
    const s = C.samples || []
    const avg = s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null
    const fluct = s.length >= 2 ? Math.max(...s) - Math.min(...s) : null
    const count = {}
    for (const r of dailyRows) for (const sym of r.symptoms || []) count[sym] = (count[sym] || 0) + 1
    const top = Object.entries(count)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
    return { avg, fluct, count: C.starts.length, top }
  }, [C, dailyRows])

  const myToday = dailyRows.find((r) => r.log_date === todayKey && r.user_id === user?.id) || null
  const partnerToday = dailyRows.find((r) => r.log_date === todayKey && r.user_id !== user?.id) || null

  // 男生关怀视角：看的是「她的周期」，主打了解与照顾；打卡/设置/删除留给女生自己管理
  const isCare = myMember?.gender === 'male'
  const careActs = useMemo(() => (isCare ? partnerCareActions(C, partnerToday) : []), [isCare, C, partnerToday])

  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const [logOpen, setLogOpen] = useState(false)
  const [logDate, setLogDate] = useState(todayKey)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cycleLen, setCycleLen] = useState('28')
  const [periodLen, setPeriodLen] = useState('5')
  const [saving, setSaving] = useState(false)
  const toast = useToast() // 统一提示；flash 是它在本页的薄封装
  const [pendingDelete, setPendingDelete] = useState(null)
  const [checkinOpen, setCheckinOpen] = useState(false)
  const [checkinDate, setCheckinDate] = useState(todayKey)
  const [form, setForm] = useState({ flow: null, pain: null, mood: null, symptoms: [], note: '' })
  const [editId, setEditId] = useState(null)
  const [detailDate, setDetailDate] = useState(null)

  // 统一走 Toast：type 决定颜色与停留时长（success / error / warning）
  const flash = (msg, type = 'success') => {
    ;(toast[type] || toast.success)(msg)
  }

  const grid = monthGrid(cursor.y, cursor.m)
  const inMonth = (k) => Number(k.slice(5, 7)) === cursor.m + 1

  const cellCls = (k) => {
    const base = 'mx-auto flex h-9 w-9 items-center justify-center rounded-full text-[13px]'
    const today = k === todayKey ? 'ring-2 ring-cocoa/50' : ''
    const dim = inMonth(k) ? '' : 'opacity-30'
    if (marks.actual.has(k)) return `${base} ${today} ${dim} bg-rosy font-bold text-white`
    if (marks.predicted.has(k)) return `${base} ${today} ${dim} bg-blush/60 font-bold text-rosy`
    if (marks.ovulation.has(k)) return `${base} ${today} ${dim} bg-lilac font-bold text-white`
    if (marks.fertile.has(k)) return `${base} ${today} ${dim} bg-peachDeep/80 font-bold text-cocoa`
    if (marks.luteal.has(k)) return `${base} ${today} ${dim} bg-butterDeep/50 font-bold text-cocoa`
    if (marks.follicular.has(k)) return `${base} ${today} ${dim} bg-matchaDeep/70 font-bold text-cocoa`
    return `${base} ${today} ${dim} text-cocoa/80`
  }

  // 日历详情的分期标签：预测经期单独标注，其余按六期给名称+说明
  const dayPhase = (k) => {
    if (marks.actual.has(k)) return PHASE_INFO.period
    if (marks.predicted.has(k)) return { label: '🔮 预测经期', cls: 'bg-blush/60 text-rosy', desc: '按你们的周期规律预测的下次经期' }
    if (marks.ovulation.has(k)) return PHASE_INFO.ovulation
    if (marks.fertile.has(k)) return PHASE_INFO.fertile
    if (marks.luteal.has(k)) return PHASE_INFO.luteal
    if (marks.follicular.has(k)) return PHASE_INFO.follicular
    return { label: '🌙 普通一天', cls: 'bg-cream text-cocoaSoft', desc: '在记录的周期范围之外' }
  }

  // 记录一次生理期开始
  const saveLog = async () => {
    if (!logDate) return
    if (logDate > todayKey) {
      flash('生理期还没来呢，选今天或过去的日期 🙈', 'warning')
      return
    }
    if (logs.some((l) => l.start_date === logDate)) {
      flash('这一天已经记过了，不用重复记录 ✅', 'warning')
      return
    }
    setSaving(true)
    const { error } = await supabase.from('period_logs').insert({
      couple_id: coupleId,
      start_date: logDate,
      created_by: user?.id || null,
    })
    setSaving(false)
    if (error) {
      flash('保存失败：' + error.message, 'error')
      if (/period_logs|relation/i.test(error.message || '')) {
        flash('还没有执行 supabase/migrations/020_period.sql，请在 Supabase 的 SQL Editor 里跑一下', 'warning')
      }
      return
    }
    setLogOpen(false)
    reload()
    flash('已记录 🌸 预测会自动更新')
  }

  // ---------- 每日打卡 ----------
  const openCheckin = (date) => {
    const mine = dailyRows.find((r) => r.log_date === date && r.user_id === user?.id)
    setCheckinDate(date)
    setEditId(mine?.id || null)
    setForm({
      flow: mine?.flow || null,
      pain: mine?.pain ?? null,
      mood: mine?.mood || null,
      symptoms: mine?.symptoms || [],
      note: mine?.note || '',
    })
    setDetailDate(null) // 从详情弹窗进入时收起详情
    setCheckinOpen(true)
  }

  const saveCheckin = async () => {
    setSaving(true)
    const { error } = await supabase
      .from('period_daily_logs')
      .upsert(
        {
          couple_id: coupleId,
          user_id: user.id,
          log_date: checkinDate,
          flow: form.flow,
          pain: form.pain,
          mood: form.mood,
          symptoms: form.symptoms,
          note: form.note || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'couple_id,user_id,log_date' },
      )
    setSaving(false)
    if (error) {
      flash('保存失败：' + error.message, 'error')
      if (/period_daily|relation/i.test(error.message || '')) {
        flash('还没有执行 supabase/migrations/022_period_daily.sql，请在 SQL Editor 里跑一下', 'warning')
      }
      return
    }
    setCheckinOpen(false)
    reloadDaily()
    flash('记好啦 🌸 TA 也会看到')
  }

  const deleteCheckin = async () => {
    if (!editId) return
    setSaving(true)
    const { error } = await supabase.from('period_daily_logs').delete().eq('id', editId)
    setSaving(false)
    if (error) {
      flash('删除失败：' + error.message, 'error')
      return
    }
    setCheckinOpen(false)
    reloadDaily()
    flash('已删除这条打卡')
  }

  const saveSettings = async () => {
    const c = clamp(Number(cycleLen) || 28, 15, 60)
    const p = clamp(Number(periodLen) || 5, 1, 14)
    setSaving(true)
    const { error } = await supabase
      .from('period_settings')
      .upsert({ couple_id: coupleId, cycle_len: c, period_len: p, updated_at: new Date().toISOString() }, { onConflict: 'couple_id' })
    setSaving(false)
    if (error) {
      flash('保存失败：' + error.message, 'error')
      return
    }
    setSettingsOpen(false)
    reloadSettings()
    flash('已保存，预测按新周期来算 🌸')
  }

  const removeLog = async (id) => {
    const { error } = await supabase.from('period_logs').delete().eq('id', id)
    if (error) toast.error('删除生理期记录失败：' + error.message)
    else reload()
    setPendingDelete(null)
  }

  const openSettings = () => {
    setCycleLen(String(C.cycleLen || 28))
    setPeriodLen(String(C.periodLen || 5))
    setSettingsOpen(true)
  }

  // 副标题：距下次 / 推迟
  const subtitle = !C.last
    ? '记下最近一次开始的日子，我来帮你算'
    : C.delay > 0
      ? isCare
        ? `预计 ${fmtMD(C.nextStart)} 来，已推迟 ${C.delay} 天 · 多陪伴，别催促`
        : `预计 ${fmtMD(C.nextStart)} 来，已推迟 ${C.delay} 天，记得补记哦`
      : C.delay === 0
        ? `预计今天来 🌸`
        : `距下次生理期还有 ${-C.delay} 天 · 预计 ${fmtMD(C.nextStart)} 来`

  return (
    <div>
      <SectionTitle
        right={
          isCare ? null : (
            <Button variant="ghost" onClick={openSettings}>
              ⚙ 设置
            </Button>
          )
        }
      >
        {isCare ? '💗 她的周期' : '🌸 生理期'}
      </SectionTitle>

      {loading ? (
        <Spinner />
      ) : (
        <>
          {/* 状态卡 */}
          <div className={`mb-3 rounded-3xl border-2 px-5 py-5 text-center ${PHASE_STYLES[C.phase] || PHASE_STYLES.safe} animate-pop`}>
            {C.last ? (
              <>
                <p className="font-display text-2xl text-cocoa">{C.title}</p>
                <p className="mt-1.5 text-xs font-bold text-cocoaSoft">{subtitle}</p>
                <p className="mt-2 text-[10px] text-cocoaSoft/70">
                  周期约 {C.cycleLen} 天 · 经期约 {C.periodLen} 天
                  {C.phase === 'period' ? '' : C.phase === 'late' ? '' : ` · 排卵日 ${fmtMD(C.ovuDay)}`}
                </p>
              </>
            ) : (
              <>
                <p className="text-4xl">🌸</p>
                <p className="mt-2 font-display text-lg text-cocoa">{isCare ? '她还没有记录' : '还没有记录'}</p>
                <p className="mt-1 text-xs text-cocoaSoft">
                  {isCare ? '先帮她记一笔最近一次开始的日子；以后她自己记的打卡也会同步给你' : subtitle}
                </p>
              </>
            )}
          </div>

          {/* 关怀提示：男生看「行动清单」，女生看「阶段提醒」 */}
          {isCare ? (
            careActs.length > 0 && (
              <div className="mb-3 rounded-3xl bg-white p-4 shadow-soft animate-floatIn">
                <p className="text-sm font-bold text-cocoa">💗 今天这样照顾她</p>
                <ul className="mt-2 space-y-1.5">
                  {careActs.map((a, i) => (
                    <li key={i} className="text-xs leading-relaxed text-cocoaSoft">
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            care && (
              <div className="mb-3 rounded-3xl bg-white p-4 shadow-soft animate-floatIn">
                <p className="text-sm font-bold text-cocoa">
                  {care.icon} {care.title}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-cocoaSoft">{care.text}</p>
              </div>
            )
          )}

          {/* 今日状态：男生看她的（关怀视角），女生记自己的 */}
          {isCare ? (
            <div className="mb-3 rounded-3xl bg-white p-4 shadow-soft">
              <p className="text-sm font-bold text-cocoa">💗 她今天的状态</p>
              {partnerToday ? (
                <p className="mt-1.5 text-xs text-cocoaSoft">
                  {checkinSummary(partnerToday)}
                  {partnerToday.note ? ` · ${partnerToday.note}` : ''}
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-cocoaSoft/70">她今天还没打卡 · 轻轻提醒她记一下，你就知道怎么照顾她啦</p>
              )}
            </div>
          ) : (
            <div className="mb-3 rounded-3xl bg-white p-4 shadow-soft">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-cocoa">📝 今天的状态</p>
                <Button variant="ghost" onClick={() => openCheckin(todayKey)}>
                  {myToday ? '编辑' : '去打卡'}
                </Button>
              </div>
              {myToday ? (
                <p className="mt-1.5 text-xs text-cocoaSoft">我：{checkinSummary(myToday)}</p>
              ) : (
                <p className="mt-1.5 text-xs text-cocoaSoft/70">流量、痛经、心情…花 10 秒记一下，TA 都能看到</p>
              )}
              {partnerToday && (
                <p className="mt-1 text-xs text-rosy">
                  {partnerName}：{checkinSummary(partnerToday)}
                </p>
              )}
            </div>
          )}

          {/* 日历 */}
          <div className="mb-3 rounded-3xl bg-white p-4 shadow-soft">
            <div className="mb-2 flex items-center justify-between">
              <button
                onClick={() => setCursor(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}
                className="flex h-8 w-8 items-center justify-center rounded-full text-cocoaSoft hover:bg-cream"
              >
                ‹
              </button>
              <p className="text-sm font-bold text-cocoa">
                {cursor.y} 年 {cursor.m + 1} 月
              </p>
              <button
                onClick={() => setCursor(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}
                className="flex h-8 w-8 items-center justify-center rounded-full text-cocoaSoft hover:bg-cream"
              >
                ›
              </button>
            </div>

            <div className="grid grid-cols-7 gap-y-1 text-center text-[10px] font-bold text-cocoaSoft">
              {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>

            <div className="mt-1 grid grid-cols-7 gap-y-1">
              {grid.map((k) => (
                <div key={k} className="py-0.5">
                  <button onClick={() => setDetailDate(k)} className={cellCls(k)}>
                    {Number(k.slice(8))}
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] font-bold text-cocoaSoft">
              <span className="flex items-center gap-1">
                <i className="inline-block h-2.5 w-2.5 rounded-full bg-rosy" /> 月经期
              </span>
              <span className="flex items-center gap-1">
                <i className="inline-block h-2.5 w-2.5 rounded-full bg-blush/60" /> 预测经期
              </span>
              <span className="flex items-center gap-1">
                <i className="inline-block h-2.5 w-2.5 rounded-full bg-matchaDeep/70" /> 卵泡期
              </span>
              <span className="flex items-center gap-1">
                <i className="inline-block h-2.5 w-2.5 rounded-full bg-peachDeep/80" /> 易孕期
              </span>
              <span className="flex items-center gap-1">
                <i className="inline-block h-2.5 w-2.5 rounded-full bg-lilac" /> 排卵日
              </span>
              <span className="flex items-center gap-1">
                <i className="inline-block h-2.5 w-2.5 rounded-full bg-butterDeep/50" /> 黄体期
              </span>
              <span className="flex items-center gap-1">点日子看详情 👆</span>
            </div>
          </div>

          {/* 周期分析 */}
          {stats.avg && (
            <div className="mb-3 rounded-3xl bg-white p-4 shadow-soft animate-floatIn">
              <p className="text-sm font-bold text-cocoa">📊 周期分析</p>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-cream px-2 py-3">
                  <p className="font-display text-xl leading-none text-rosy">{stats.avg}</p>
                  <p className="mt-1 text-[10px] text-cocoaSoft">平均周期（天）</p>
                </div>
                <div className="rounded-2xl bg-cream px-2 py-3">
                  <p className="font-display text-xl leading-none text-rosy">{stats.fluct ?? '—'}</p>
                  <p className="mt-1 text-[10px] text-cocoaSoft">波动幅度（天）</p>
                </div>
                <div className="rounded-2xl bg-cream px-2 py-3">
                  <p className="font-display text-xl leading-none text-rosy">{stats.count}</p>
                  <p className="mt-1 text-[10px] text-cocoaSoft">累计记录（次）</p>
                </div>
              </div>
              {stats.top.length > 0 && (
                <p className="mt-2 text-center text-[11px] text-cocoaSoft">
                  常见症状：{stats.top.map(([s, n]) => `${s} ×${n}`).join(' · ')}
                </p>
              )}
            </div>
          )}

          {/* 记录入口 */}
          <Button
            className="w-full"
            onClick={() => {
              setLogDate(todayKey)
              setLogOpen(true)
            }}
          >
            {isCare ? '🌸 帮她记一笔' : '🌸 记录这次生理期'}
          </Button>
          <p className="mt-2 text-center text-[10px] text-cocoaSoft/60">
            {isCare
              ? '她忘了记的时候你来补上 · 数据你们两人共享'
              : '记录的是「这次生理期开始的那天」· 数据你们两人共享，TA 也能看到和补记'}
          </p>

          {/* 历史 */}
          <div className="mt-4">
            <p className="mb-2 text-xs font-bold text-cocoaSoft">
              🕘 历史记录（{logs.length} 次）
            </p>
            {logs.length === 0 ? (
              <EmptyState emoji="🌸" text="还没有记录" />
            ) : (
              <div className="space-y-2">
                {logs.map((l, i) => {
                  const prev = C.starts[C.starts.length - 1 - i - 1] // 按时间倒序的上一次
                  const gap = prev ? diffDays(prev, l.start_date) : null
                  return (
                    <div key={l.id} className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-soft animate-floatIn">
                      <span className="text-lg">🌸</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-cocoa">{fmtFull(l.start_date)} 开始</p>
                        <p className="text-[10px] text-cocoaSoft/70">
                          {gap ? `与上次间隔 ${gap} 天` : '最早的一条记录'}
                        </p>
                      </div>
                      {!isCare && (
                        <button onClick={() => setPendingDelete(l.id)} className="text-xs font-bold text-rosy/70">
                          删除
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* 记录弹窗 */}
      <Modal open={logOpen} onClose={() => setLogOpen(false)} title="记录生理期">
        <div className="space-y-4">
          <Field label="这次开始的那天">
            <TextInput type="date" value={logDate} max={todayKey} onChange={(e) => setLogDate(e.target.value)} />
          </Field>
          <p className="rounded-2xl bg-cream px-3 py-2 text-xs text-cocoaSoft">
            记下开始日就行；如果和上次间隔超过 60 天或不满 15 天，预测会改用设置里的固定周期。
          </p>
          <Button className="w-full" onClick={saveLog} disabled={saving || !logDate}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </Modal>

      {/* 每日打卡弹窗 */}
      <Modal open={checkinOpen} onClose={() => setCheckinOpen(false)} title={checkinDate === todayKey ? '今天的状态' : `${fmtMD(checkinDate)} 的状态`}>
        <div className="space-y-4">
          <Field label="流量">
            <div className="grid grid-cols-4 gap-1.5">
              {FLOWS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setForm((s) => ({ ...s, flow: s.flow === f.key ? null : f.key }))}
                  className={`rounded-2xl px-1 py-2 text-center text-[11px] font-bold transition active:scale-95 ${
                    form.flow === f.key ? 'bg-rosy text-white shadow-card' : 'bg-cream text-cocoaSoft'
                  }`}
                >
                  <span className="block text-sm">{f.emoji}</span>
                  {f.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="痛经程度">
            <div className="grid grid-cols-4 gap-1.5">
              {PAINS.map((p) => (
                <button
                  key={p.v}
                  onClick={() => setForm((s) => ({ ...s, pain: s.pain === p.v ? null : p.v }))}
                  className={`rounded-2xl px-1 py-2 text-center text-[11px] font-bold transition active:scale-95 ${
                    form.pain === p.v ? 'bg-blush text-white shadow-card' : 'bg-cream text-cocoaSoft'
                  }`}
                >
                  <span className="block text-sm">{p.emoji}</span>
                  {p.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="心情">
            <div className="flex flex-wrap gap-1.5">
              {MOODS.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setForm((s) => ({ ...s, mood: s.mood === m.key ? null : m.key }))}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition active:scale-95 ${
                    form.mood === m.key ? 'bg-butter text-cocoa shadow-card' : 'bg-cream text-cocoaSoft'
                  }`}
                >
                  {m.emoji} {m.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="身体症状（可多选）">
            <div className="flex flex-wrap gap-1.5">
              {SYMPTOMS.map((sym) => {
                const on = form.symptoms.includes(sym)
                return (
                  <button
                    key={sym}
                    onClick={() =>
                      setForm((s) => ({
                        ...s,
                        symptoms: on ? s.symptoms.filter((x) => x !== sym) : [...s.symptoms, sym],
                      }))
                    }
                    className={`rounded-full px-3 py-1.5 text-xs font-bold transition active:scale-95 ${
                      on ? 'bg-peach text-cocoa shadow-card' : 'bg-cream text-cocoaSoft'
                    }`}
                  >
                    {sym}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="备注">
            <TextInput
              value={form.note}
              placeholder="想记点什么…（可留空）"
              onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))}
            />
          </Field>

          <Button className="w-full" onClick={saveCheckin} disabled={saving}>
            {saving ? '保存中…' : editId ? '更新' : '保存'}
          </Button>
          {editId && (
            <button onClick={deleteCheckin} disabled={saving} className="w-full text-center text-xs font-bold text-rosy/70">
              删除这条打卡
            </button>
          )}
        </div>
      </Modal>

      {/* 日历详情弹窗 */}
      <Modal open={!!detailDate} onClose={() => setDetailDate(null)} title={detailDate ? fmtFull(detailDate) : ''}>
        {detailDate && (
          <div className="space-y-3">
            <span className={`inline-block rounded-full px-3 py-1 text-xs font-bold ${dayPhase(detailDate).cls}`}>
              {dayPhase(detailDate).label}
            </span>
            <p className="rounded-2xl bg-cream px-3 py-2 text-xs leading-relaxed text-cocoaSoft">{dayPhase(detailDate).desc}</p>

            {dailyRows.filter((r) => r.log_date === detailDate).length ? (
              dailyRows
                .filter((r) => r.log_date === detailDate)
                .map((l) => (
                  <div key={l.id} className="rounded-2xl bg-cream px-3 py-2.5">
                    <p className="text-xs font-bold text-cocoa">
                      {l.user_id === user?.id ? '我' : memberMap[l.user_id]?.nickname || partnerName}
                    </p>
                    <p className="mt-0.5 text-xs text-cocoaSoft">
                      {checkinSummary(l)}
                      {l.note ? ` · ${l.note}` : ''}
                    </p>
                  </div>
                ))
            ) : (
              <p className="text-xs text-cocoaSoft/70">这一天还没人打卡</p>
            )}

            {!isCare && detailDate <= todayKey && (
              <Button variant="soft" className="w-full" onClick={() => openCheckin(detailDate)}>
                📝 {dailyRows.some((r) => r.log_date === detailDate && r.user_id === user?.id) ? '编辑我这一天的状态' : '记一下这天的状态'}
              </Button>
            )}
          </div>
        )}
      </Modal>

      {/* 设置弹窗 */}
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="周期设置">
        <div className="space-y-4">
          <Field label="周期长度（天，15–60）">
            <TextInput
              type="number"
              min={15}
              max={60}
              value={cycleLen}
              onChange={(e) => setCycleLen(e.target.value)}
            />
          </Field>
          <Field label="经期天数（天，1–14）">
            <TextInput
              type="number"
              min={1}
              max={14}
              value={periodLen}
              onChange={(e) => setPeriodLen(e.target.value)}
            />
          </Field>
          <p className="rounded-2xl bg-cream px-3 py-2 text-xs text-cocoaSoft">
            有 2 次以上记录后，周期会按最近几次的实际间隔自动修正；这里的设置用于记录不足时的兜底。
          </p>
          <Button className="w-full" onClick={saveSettings} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => removeLog(pendingDelete)}
        message="确定删除这条生理期记录吗？预测会重新计算。"
      />
    </div>
  )
}
