import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 把 src/lib/supabase.js 换成内存替身：测试不连真库，也不用在每个文件里写 vi.mock
const supabaseStubModule = fileURLToPath(new URL('./tests/helpers/supabase-stub-module.js', import.meta.url))

// 测试配置独立于 vite.config.js：只服务于 vitest，不影响打包行为。
// 运行环境 jsdom（项目是纯前端 React 应用），每个测试文件跑前先加载 tests/setup.js。
export default defineConfig({
  plugins: [
    react(),
    // 源码里所有 `…/lib/supabase.js` 的导入都换成内存替身（只用相对路径导入，
    // 这里按导入串匹配最稳；生产构建不受影响，因为它只存在于 vitest.config.js）
    {
      name: 'stub-supabase-module',
      enforce: 'pre',
      resolveId(id, importer) {
        if (!/supabase\.js$/.test(id)) return null
        if (importer && !importer.replace(/\\/g, '/').includes('/src/')) return null
        return supabaseStubModule
      },
    },
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    // 组件源码里 import css 时不必真的处理（目前只有 index.css 由入口引入）
    css: false,
    clearMocks: true,
    restoreMocks: true,
    // 单个文件超时放宽：部分用例要等 toast 定时器与防抖
    testTimeout: 15000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      // 不清空报告目录：某些受限环境删不掉目录会让整轮测试挂掉，覆盖写更安全
      clean: false,
      // 只统计前端源码（supabase/ 下的云函数、入口文件都不算进来）
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/index.css'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
