import { useEffect } from 'react'

// 注意：必须把 rest 透传，否则 onClick 之类会被静默丢弃（卡片点击失效的元凶）
export function Card({ children, className = '', ...rest }) {
  return (
    <div className={`rounded-card bg-white shadow-card p-5 ${className}`} {...rest}>
      {children}
    </div>
  )
}

export function Button({ children, onClick, variant = 'primary', type = 'button', className = '', disabled = false }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-full font-bold px-5 py-2.5 transition active:scale-95 disabled:opacity-40 disabled:active:scale-100'
  const variants = {
    primary: 'bg-blush text-white shadow-card hover:bg-rosy',
    ghost: 'bg-white text-rosy border-2 border-blush hover:bg-blush/10',
    soft: 'bg-peach/40 text-cocoa hover:bg-peach/70',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  )
}

export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-bold text-cocoaSoft">{label}</span>
      {children}
    </label>
  )
}

export function TextInput({ className = '', ...props }) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border-2 border-peach/60 bg-white px-4 py-2.5 text-cocoa outline-none placeholder:text-cocoaSoft/40 focus:border-blush ${className}`}
    />
  )
}

export function TextArea({ className = '', ...props }) {
  return (
    <textarea
      {...props}
      className={`w-full resize-none rounded-xl border-2 border-peach/60 bg-white px-4 py-2.5 text-cocoa outline-none placeholder:text-cocoaSoft/40 focus:border-blush ${className}`}
    />
  )
}

export function Spinner({ label = '加载中…' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-cocoaSoft">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-blush/30 border-t-blush" />
      <span className="text-sm font-semibold">{label}</span>
    </div>
  )
}

export function EmptyState({ emoji = '🌱', text = '还没有内容哦' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-4xl">{emoji}</div>
      <p className="text-sm font-semibold text-cocoaSoft">{text}</p>
    </div>
  )
}

// 底部抽屉式弹窗
export function Modal({ open, onClose, title, children }) {
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-cocoa/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 max-h-[88vh] w-full max-w-md overflow-y-auto scroll-none rounded-t-3xl bg-cream p-5 pb-8 shadow-card animate-floatIn">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-blush/40" />
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-xl text-cocoa">{title}</h3>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-cocoaSoft shadow-soft">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function SectionTitle({ children, right }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="font-display text-lg text-cocoa">{children}</h2>
      {right}
    </div>
  )
}

// 删除/危险操作的二次确认弹窗
export function ConfirmModal({ open, onClose, onConfirm, title = '确认删除？', message, confirmLabel = '删除', busy = false }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="mb-4 text-sm text-cocoaSoft">{message}</p>
      <div className="flex gap-3">
        <Button variant="ghost" className="flex-1" onClick={onClose}>取消</Button>
        <Button className="flex-1" onClick={onConfirm} disabled={busy}>{busy ? '删除中…' : confirmLabel}</Button>
      </div>
    </Modal>
  )
}
