// ESLint 9 flat config
// 规则强度的选择：这是个 JS（非 TS）项目，先把「一定会出错」的规则设成 error，
// 风格类与 hooks 依赖数组设成 warn——CI 只卡 error，避免一次性几百条告警挡住提交。
import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.workbuddy/**', 'public/**', 'supabase/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...(reactHooks.configs?.recommended?.rules || {}),
      // 让 no-unused-vars 认得 JSX 里的引用（<PhotoGrid/> 算作使用），否则满屏误报
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off', // 新版 JSX 转换不需要 import React
      'react/prop-types': 'off', // JS 项目不写 propTypes
      // 组件文件里的非组件导出很常见（hooks、常量、工具函数），不卡
      'react-refresh/only-export-components': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-cond-assign': ['error', 'always'],
      // 浏览器里 console 是排查手段（toast.error 也会打一份），只提示不禁止
      'no-console': 'off',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    // 测试与脚本里可以随便用 describe/it/vi 等，并且允许未使用参数（占位）
    files: ['tests/**/*.{js,jsx}', 'scripts/**/*.{js,mjs}', '*.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
]
