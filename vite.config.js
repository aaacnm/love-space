import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 发布沙箱会注入 PORT 环境变量（默认 3000）并探测该端口；
// 本地开发没有 PORT，仍用 5173
const port = Number(process.env.PORT) || 5173

export default defineConfig({
  plugins: [react()],
  server: {
    // strictPort：Vite 端口被占用时会静默换端口，换端口后浏览器里的匿名身份
    //（localStorage 里 sb-xxx-auth-token 按 origin 隔离）会丢失，空间就找不到了
    port,
    strictPort: true,
    // host: true → 监听 0.0.0.0，同 WiFi 的手机可用 http://<局域网IP>:5173 打开
    host: true,
    // 允许发布域名（app.workbuddy.host）反向代理访问，避免 Vite 拒绝宿主
    allowedHosts: true,
    // YouTube 嵌入播放器要求收到站点的来源信息（HTTP Referer），否则直接报错误 153
    //（表现就是「出了点问题。请稍后重试。」）。服务器响应头优先级高于页面的
    // <meta name="referrer">，而线上跑的就是这个 dev server，所以必须在这里设：
    // strict-origin-when-cross-origin = 跨站只发站点源（https://域名），不泄漏路径与参数。
    // vercel.json 里也配了同一条，走 Vercel 部署时由它接管。
    headers: {
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  },
  // `npm run preview`（本地跑 dist 的静态预览）走的是 preview，不是 server，
  // 同一条头也要给上；发布沙箱用的是上面的 server，这两段互不影响。
  preview: {
    headers: {
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  },
})
