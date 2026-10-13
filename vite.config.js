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
  },
})
