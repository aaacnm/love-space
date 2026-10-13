import { Component } from 'react'

// 页面级兜底：组件抛错时不再白屏/粉屏，直接把错误信息显示在页面上，方便排查
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('页面渲染出错', error, info)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="bg-paper flex min-h-screen items-center justify-center px-5 py-10">
        <div className="w-full max-w-md rounded-card bg-white p-5 shadow-card">
          <div className="mb-2 text-3xl">💔</div>
          <h1 className="font-display text-xl text-cocoa">页面出了点问题</h1>
          <p className="mt-2 break-words text-sm font-semibold text-rosy">
            {String(error?.message || error)}
          </p>
          <pre className="scroll-none mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-cream p-3 text-xs leading-relaxed text-cocoaSoft">
            {String(error?.stack || '').slice(0, 800)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 w-full rounded-full bg-blush py-2.5 text-sm font-bold text-white shadow-card transition active:scale-95"
          >
            重新加载
          </button>
        </div>
      </div>
    )
  }
}
