// 生理期的纯计算与常量：日期工具、周期推算、分期样式与关怀文案。
// 从 Period.jsx 整块搬出——无任何组件依赖，可单独单测。
export const pad = (n) => String(n).padStart(2, '0')
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const parseDay = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const diffDays = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000)
export const addDaysKey = (s, n) => {
  const d = parseDay(s)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
export const fmtMD = (s) => {
  const d = parseDay(s)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
export const fmtFull = (s) => {
  const d = parseDay(s)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

// ---------- 打卡选项（对标 Flo/美柚 的精简版） ----------
export const FLOWS = [
  { key: 'none', label: '没来', emoji: '⚪' },
  { key: 'light', label: '少量', emoji: '🩸' },
  { key: 'medium', label: '适中', emoji: '🩸🩸' },
  { key: 'heavy', label: '量多', emoji: '🩸🩸🩸' },
]
export const PAINS = [
  { v: 0, label: '不痛', emoji: '😌' },
  { v: 1, label: '轻微', emoji: '😕' },
  { v: 2, label: '中度', emoji: '😣' },
  { v: 3, label: '严重', emoji: '😖' },
]
export const MOODS = [
  { key: 'happy', emoji: '😄', label: '开心' },
  { key: 'calm', emoji: '😌', label: '平静' },
  { key: 'irritable', emoji: '😤', label: '烦躁' },
  { key: 'low', emoji: '😔', label: '低落' },
  { key: 'sensitive', emoji: '🥺', label: '敏感' },
]
export const SYMPTOMS = ['腹痛', '腰酸', '胸胀', '头痛', '疲惫', '失眠', '长痘', '想吃甜的', '腹泻', '怕冷']

export const flowLabel = (key) => FLOWS.find((f) => f.key === key) || null
export const painLabel = (v) => PAINS.find((p) => p.v === v) || null
export const moodLabel = (key) => MOODS.find((m) => m.key === key) || null

export function checkinSummary(r) {
  const parts = []
  const f = flowLabel(r.flow)
  if (f) parts.push(`${f.emoji}${f.label}`)
  const p = painLabel(r.pain)
  if (p) parts.push(`${p.emoji}${p.label}`)
  const m = moodLabel(r.mood)
  if (m) parts.push(m.emoji)
  if (r.symptoms && r.symptoms.length) parts.push(r.symptoms.join('·'))
  return parts.join(' · ') || '记了状态'
}

// ---------- 周期计算 ----------
// logs: [{ start_date }]，settings: { cycle_len, period_len }，todayKey: 'YYYY-MM-DD'
export function computeCycle(logs, settings, todayKey) {
  const starts = [...new Set((logs || []).map((l) => l.start_date).filter(Boolean))].sort()
  const periodLen = clamp(settings?.period_len || 5, 1, 14)

  // 周期样本：相邻两次开始的间隔（15~60 天算合理，滤掉补记/误记）
  const samples = []
  for (let i = 1; i < starts.length; i++) {
    const d = diffDays(starts[i - 1], starts[i])
    if (d >= 15 && d <= 60) samples.push(d)
  }
  const recent = samples.slice(-6)
  const cycleLen = recent.length
    ? Math.round(recent.reduce((s, x) => s + x, 0) / recent.length)
    : clamp(settings?.cycle_len || 28, 15, 60)

  const last = starts[starts.length - 1] || null
  if (!last) return { starts, samples, cycleLen, periodLen, last: null }

  const dayNo = diffDays(last, todayKey) + 1 // 周期第几天（1 起）
  const nextStart = addDaysKey(last, cycleLen)
  const delay = diffDays(nextStart, todayKey) // >0 = 推迟天数
  const ovuDay = addDaysKey(nextStart, -14) // 排卵日 = 下次开始前 14 天（黄体期固定法，Flo/Clue 同款默认算法）

  // 六期分期（对齐 Flo/Clue 医学分期 + 美柚的中文习惯）：
  //   月经期 → 卵泡期 → 易孕期（排卵日前5天起）→ 排卵日 → 黄体期（→ 下次月经）
  //   易孕窗口 = 排卵日前 5 ~ 后 1（精子存活约 5 天 + 卵子约 24h）
  //   短周期时经期可能与易孕窗口重叠，显示上经期优先（经期是确定事实）
  let phase
  let title
  if (dayNo >= 1 && dayNo <= periodLen) {
    phase = 'period'
    title = `🌸 经期第 ${dayNo} 天`
  } else if (dayNo <= 0) {
    // 今天还没到最近一次记录的经期（比如提前记了明天的经期）→ 属于上一周期的黄体期末尾
    phase = 'luteal'
    title = '🌙 黄体期'
  } else if (todayKey === ovuDay) {
    phase = 'ovulation'
    title = '🌟 排卵日'
  } else if (todayKey >= addDaysKey(ovuDay, -5) && todayKey <= addDaysKey(ovuDay, 1)) {
    phase = 'fertile'
    title = '💞 易孕期'
  } else if (delay > 0) {
    phase = 'late'
    title = `⏳ 已推迟 ${delay} 天`
  } else if (todayKey < ovuDay) {
    phase = 'follicular'
    title = '🌱 卵泡期'
  } else {
    phase = 'luteal'
    title = '🌙 黄体期'
  }

  return { starts, samples, cycleLen, periodLen, last, nextStart, dayNo, delay, ovuDay, phase, title }
}

// 日历标注：实际经期 / 预测经期 / 易孕窗口 / 排卵日 / 卵泡期 / 黄体期
// 卵泡期/黄体期铺满整个可见范围（Flo/美柚样式：整月满色）——
// 往前按平均周期推导 6 个、往后推 monthsAhead 个周期，每一天都能归入某个分期
export function buildMarks(C, monthsAhead = 12) {
  const actual = new Set()
  const predicted = new Set()
  const fertile = new Set()
  const ovulation = new Set()
  const follicular = new Set()
  const luteal = new Set()
  if (!C?.last) return { actual, predicted, fertile, ovulation, follicular, luteal }

  const first = C.starts[0]
  const cycleStarts = [...C.starts]
  for (let k = 1; k <= 6; k++) cycleStarts.unshift(addDaysKey(first, -k * C.cycleLen))
  for (let k = 1; k <= monthsAhead; k++) cycleStarts.push(addDaysKey(C.last, k * C.cycleLen))
  const realSet = new Set(C.starts)

  for (let i = 0; i < cycleStarts.length; i++) {
    const s = cycleStarts[i]
    const nextS = cycleStarts[i + 1] || addDaysKey(s, C.cycleLen)
    const isReal = realSet.has(s)
    const ovu = addDaysKey(s, C.cycleLen - 14)
    // 经期：真实记录 → actual；未来推导的 → predicted；过去推导的不画（没记录过的"过去经期"不显示）
    if (isReal) for (let j = 0; j < C.periodLen; j++) actual.add(addDaysKey(s, j))
    else if (s > C.last) for (let j = 0; j < C.periodLen; j++) predicted.add(addDaysKey(s, j))
    ovulation.add(ovu)
    for (let j = -5; j <= 1; j++) fertile.add(addDaysKey(ovu, j))
    // 经期结束 → 下一周期开始：排卵日前是卵泡期、之后是黄体期（跳过经期/易孕/排卵日）
    let k = addDaysKey(s, C.periodLen)
    while (k < nextS) {
      if (!actual.has(k) && !predicted.has(k) && !ovulation.has(k) && !fertile.has(k)) {
        if (k < ovu) follicular.add(k)
        else luteal.add(k)
      }
      k = addDaysKey(k, 1)
    }
  }
  return { actual, predicted, fertile, ovulation, follicular, luteal }
}

// 当月 6 周网格（周日起始）
export function monthGrid(year, month) {
  const first = new Date(year, month, 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return dayKey(d)
  })
}

export const PHASE_STYLES = {
  period: 'bg-rosy/25 border-rosy/50',
  follicular: 'bg-matchaDeep/30 border-matchaDeep/70',
  fertile: 'bg-peachDeep/35 border-peachDeep',
  ovulation: 'bg-lilac/30 border-lilac/70',
  luteal: 'bg-peachDeep/30 border-peachDeep/60',
  late: 'bg-blush/25 border-blush/50',
}

// 分期说明：名称 + 一句医学描述（详情弹窗用）
export const PHASE_INFO = {
  period: {
    label: '🌸 月经期',
    cls: 'bg-rosy/30 text-rosy',
    desc: '子宫内膜脱落排出。注意保暖、多休息，生冷辛辣少碰；痛经明显可以用热水袋',
  },
  follicular: {
    label: '🌱 卵泡期',
    cls: 'bg-matchaDeep/70 text-cocoa',
    desc: '卵泡正在发育、雌激素回升，通常是状态最好的阶段。受孕几率低（俗称安全期）',
  },
  fertile: {
    label: '💞 易孕期',
    cls: 'bg-peachDeep/80 text-cocoa',
    desc: '排卵前后几天，受孕几率明显升高；没有备孕计划的话这几天要特别注意',
  },
  ovulation: {
    label: '🌟 排卵日',
    cls: 'bg-lilac text-white',
    desc: '卵子排出的日子，受孕几率最高（排卵可能因压力、熬夜提前或推迟）',
  },
  luteal: {
    label: '🌙 黄体期',
    cls: 'bg-butterDeep/50 text-cocoa',
    desc: '黄体分泌孕激素为受孕做准备；若未受孕，内膜准备脱落，经前综合征常出现在这段。受孕几率低（俗称安全期）',
  },
  late: {
    label: '⏳ 已推迟',
    cls: 'bg-blush/60 text-rosy',
    desc: '比预测来得晚。偶尔推迟很常见（压力/熬夜/换季都会影响）；超过一周建议验一下或咨询医生',
  },
}

// 关怀卡文案：按阶段给两个人都提个醒（对标 Flo for Partners 的「分享与关怀」）
export function careCard(C) {
  if (!C?.last) return null
  if (C.phase === 'period')
    return {
      icon: '🌸',
      title: '经期关怀',
      text: '提醒 TA 多喝温水、注意保暖，生冷辛辣先放一放；痛经的话一个热水袋很管用。情绪波动是正常的，多点耐心 🫂',
    }
  if (C.phase === 'ovulation' || C.phase === 'fertile')
    return {
      icon: '💞',
      title: '易孕小知识',
      text: `这几天受孕几率较高（排卵日 ${fmtMD(C.ovuDay)} 前后），做好你们的计划 😉`,
    }
  if (C.phase === 'late')
    return {
      icon: '⏳',
      title: '已推迟',
      text: `已推迟 ${C.delay} 天。偶尔推迟很常见（压力大、熬夜、换季都会影响）；超过一周建议验一下或咨询医生`,
    }
  const daysTo = -C.delay
  if (daysTo <= 2)
    return {
      icon: '⏰',
      title: '生理期将至',
      text: `预计 ${fmtMD(C.nextStart)} 来，提前备好卫生巾和爱吃的零食；这几天 TA 可能有点敏感烦躁，多点耐心 🍬`,
    }
  return null
}

// 男生关怀视角：结合「她今天打卡的身体状态 + 当前周期阶段」给出具体可做的行动
// （对标 Flo for Partners：不只告诉男生"她怎么了"，而是告诉他"现在该做什么"）
export function partnerCareActions(C, herToday) {
  const acts = []
  if (herToday) {
    if ((herToday.pain ?? 0) >= 2) acts.push('🫖 她痛经明显：热水袋、温红糖水先备上，问一句要不要躺着歇会儿')
    else if (herToday.pain === 1) acts.push('🫖 她有点不舒服：别安排太累的事，让她多歇歇')
    if (herToday.mood === 'irritable') acts.push('😌 她有点烦躁：顺着点，今天不讲道理')
    if (herToday.mood === 'low') acts.push('🫂 她情绪低落：一个拥抱比道理有用')
    if (herToday.mood === 'sensitive') acts.push('🥺 她今天比较敏感：说话注意语气')
    if (herToday.flow === 'heavy') acts.push('🩸 她量比较大：提醒她勤换卫生巾、多休息')
    const syms = herToday.symptoms || []
    if (syms.includes('怕冷')) acts.push('🧣 她说怕冷：暖宝宝或小毯子安排上')
    if (syms.includes('疲惫')) acts.push('😴 她很累：今天的事你多担待')
    if (syms.includes('失眠')) acts.push('🌙 她没睡好：今晚早点陪她休息')
  }
  if (C?.last) {
    if (C.phase === 'period') acts.push('🍲 经期头两天最难熬：生冷辛辣先收起来，递的水和水果都换成温的')
    else if (C.phase === 'late') acts.push(`⏳ 已推迟 ${C.delay} 天：别追问「怎么还没来」，多陪伴少给压力；超一周陪她验一下`)
    else if (C.phase === 'ovulation' || C.phase === 'fertile') acts.push(`💞 易孕窗口（排卵日 ${fmtMD(C.ovuDay)} 前后）：做好你们的计划 😉`)
    else if (-C.delay <= 2) acts.push(`⏰ 预计 ${fmtMD(C.nextStart)} 来：提前备好卫生巾和她爱吃的零食`)
  }
  return acts
}
