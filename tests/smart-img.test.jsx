/**
 * 空 src 的 <img> 是隐蔽的性能/体验坑：浏览器会把当前页面地址当图片再请求一次，
 * 多一个无谓请求还会让页面闪一下。私有桶签名 URL 没回来时 src 就是空的。
 *
 * 守住两条：
 * 1. 任何情况下都不渲染 src 为空字符串的 <img>；
 * 2. URL 就绪后才渲染 <img>，之前只出骨架（skeleton）或什么都不出（默认，向后兼容）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SmartImg from '../src/components/SmartImg.jsx'
import { MessageBody } from '../src/views/messages/MessageCard.jsx'

const container = () => document.body

describe('SmartImg · 空 src 不渲染 img', () => {
  it('src 为空且未开骨架：容器里没有任何 img（也就没有 src=""）', () => {
    render(<SmartImg src="" alt="图片留言" />)
    expect(container().querySelector('img')).toBeNull()
  })

  it('src 为 undefined 同理不渲染 img', () => {
    render(<SmartImg src={undefined} alt="图片留言" />)
    expect(container().querySelector('img')).toBeNull()
  })

  it('开骨架后渲染占位块，但仍然没有 img', () => {
    render(<SmartImg src="" skeleton className="h-16 w-16" />)
    expect(container().querySelector('[data-skeleton="true"]')).not.toBeNull()
    expect(container().querySelector('img')).toBeNull()
  })

  it('骨架占位不带 src 属性，且对读屏隐藏', () => {
    render(<SmartImg src="" skeleton className="h-16 w-16" />)
    const sk = container().querySelector('[data-skeleton="true"]')
    expect(sk.hasAttribute('src')).toBe(false)
    expect(sk.getAttribute('aria-hidden')).toBe('true')
  })

  it('骨架可单独指定尺寸类（图片本身没有固定高度时用）', () => {
    render(<SmartImg src="" skeleton className="w-full object-cover" skeletonClass="aspect-[4/3] w-full" />)
    expect(container().querySelector('[data-skeleton="true"]').className).toContain('aspect-[4/3]')
  })
})

describe('SmartImg · URL 就绪后才渲染', () => {
  it('src 就绪：渲染 img 且带真实地址', () => {
    render(<SmartImg src="https://cdn.test/a.jpg?token=1" alt="图片留言" />)
    const img = screen.getByAltText('图片留言')
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toBe('https://cdn.test/a.jpg?token=1')
  })

  it('从空到就绪：rerender 后骨架换成 img', () => {
    const { rerender } = render(<SmartImg src="" skeleton alt="图片留言" />)
    expect(container().querySelector('img')).toBeNull()
    rerender(<SmartImg src="https://cdn.test/a.jpg" skeleton alt="图片留言" />)
    expect(container().querySelector('img')).not.toBeNull()
    expect(container().querySelector('[data-skeleton="true"]')).toBeNull()
  })

  it('onClick 透传给 img（留言图点开大图依赖它）', () => {
    const onClick = vi.fn()
    render(<SmartImg src="https://cdn.test/a.jpg" alt="图片留言" onClick={onClick} />)
    fireEvent.click(screen.getByAltText('图片留言'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('留言图片（回归点：这里原来渲染 src=""）', () => {
  const m = { id: 'm1', image_path: 'messages/a.jpg', content: '', voice_path: null }

  it('签名未返回：只出骨架，不产生 img', () => {
    render(<MessageBody m={m} voiceSrcs={{}} imgSrcs={{}} onOpenImage={() => {}} />)
    expect(container().querySelector('img')).toBeNull()
    expect(container().querySelector('[data-skeleton="true"]')).not.toBeNull()
  })

  it('签名返回后渲染真实图片的 img', () => {
    render(
      <MessageBody
        m={m}
        voiceSrcs={{}}
        imgSrcs={{ 'messages/a.jpg': 'https://cdn.test/a.jpg?token=1' }}
        onOpenImage={() => {}}
      />,
    )
    const img = container().querySelector('img')
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('https://cdn.test/a.jpg?token=1')
  })
})

describe('SmartImg · 降级重试不回归', () => {
  it('三次失败后出可重试占位，换 src 后回到图片', () => {
    const { rerender } = render(<SmartImg src="https://cdn.test/a.jpg?w=100" alt="图片留言" />)
    for (let i = 0; i < 3; i++) fireEvent.error(screen.getByAltText('图片留言'))
    expect(screen.getByTitle('加载失败，点击重试')).toBeTruthy()
    expect(container().querySelector('img')).toBeNull()

    rerender(<SmartImg src="https://cdn.test/b.jpg?w=100" alt="图片留言" />)
    expect(container().querySelector('img')).not.toBeNull()
    expect(container().querySelector('img').getAttribute('src')).toBe('https://cdn.test/b.jpg?w=100')
  })
})
