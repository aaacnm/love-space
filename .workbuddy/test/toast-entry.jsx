// toast 测试专用打包入口：故意不挂 ToastProvider，
// 验证「没有 Provider 时提示也不会消失」的兜底挂载；同时导出 Provider 版本供对照。
import { toast, useToast, ToastProvider } from '../../src/lib/toast.jsx'

export { toast, ToastProvider }

function Panel() {
  const t = useToast()
  window.__api = {
    success: () => t.success('保存成功 ✓'),
    error: () => t.error('删除失败：boom'),
    warning: () => t.warning('请先执行迁移脚本'),
    loading: () => {
      window.__id = t.loading('正在上传…')
      return window.__id
    },
    finish: (type) => t.update(window.__id, { type, text: '上传完成' }),
    short: () => t.push('success', '一闪而过', { duration: 150 }),
    many: () => {
      for (let i = 1; i <= 6; i++) t.success('第 ' + i + ' 条')
    },
    dismiss: (id) => t.dismiss(id),
    clear: () => t.clear(),
    lastId: () => window.__id,
  }
  return <div id="probe">probe</div>
}

export default function Harness() {
  return <Panel />
}

export function HarnessWithProvider() {
  return (
    <ToastProvider>
      <Panel />
    </ToastProvider>
  )
}
