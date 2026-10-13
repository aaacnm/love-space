// 和好 tab：功能暂时搁置，占位展示「待开发」
// 上一版实现（记冲突 / 调解 / 冲突记录）已移除，需要时从 git 历史恢复
export default function Peace() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 pt-24 text-center">
      <div className="text-5xl">🕊️</div>
      <p className="font-display text-2xl text-cocoa">待开发</p>
      <p className="max-w-[240px] text-sm leading-relaxed text-cocoaSoft">
        和好功能正在重新设计中
        <br />
        想到好点子随时告诉我
      </p>
    </div>
  )
}
