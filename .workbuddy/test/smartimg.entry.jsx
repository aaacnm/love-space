// smartimg 测试专用打包入口：把 react/react-dom 和组件打进同一个 bundle，
// 避免 Windows 盘符大小写（d: vs D:）导致 require 解析出两份 React 实例。
import React from 'react'
import { createRoot } from 'react-dom/client'
import SmartImg from '../../src/components/SmartImg.jsx'

export { React, createRoot, SmartImg }
