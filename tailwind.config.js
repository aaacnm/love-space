/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#FFF6F0',
        // 主色用 CSS 变量承载：男生账号（html.theme-male）整体换蓝调，见 index.css。
        // <alpha-value> 让 bg-blush/10 这类透明度变体继续可用
        blush: 'rgb(var(--c-blush) / <alpha-value>)',
        rosy: 'rgb(var(--c-rosy) / <alpha-value>)',
        peach: '#FBD3C4',
        matcha: '#BFD8B8',
        butter: '#FBE9C8',
        // 深一档的变体：生理期日历格子专用（浅色版在浅纸底上叠透明度后看不清）
        peachDeep: '#F2A87F',
        matchaDeep: '#9CC493',
        butterDeep: '#F3CE7B',
        lilac: '#A88BDC',
        cocoa: '#5C4A45',
        cocoaSoft: '#8A726C',
      },
      fontFamily: {
        display: ['"ZCOOL KuaiLe"', '"Baloo 2"', 'cursive'],
        body: ['Nunito', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'sans-serif'],
      },
      boxShadow: {
        card: '0 6px 20px -6px rgba(233, 123, 146, 0.25)',
        soft: '0 2px 12px -2px rgba(92, 74, 69, 0.12)',
      },
      borderRadius: {
        card: '1.5rem',
      },
      keyframes: {
        floatIn: {
          '0%': { opacity: '0', transform: 'translateY(10px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        pop: {
          '0%': { transform: 'scale(0.6)' },
          '60%': { transform: 'scale(1.1)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        floatIn: 'floatIn 0.4s ease-out both',
        pop: 'pop 0.3s ease-out both',
      },
    },
  },
  plugins: [],
}
