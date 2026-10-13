// 上传相关的网络操作：传一份文件、以及入库失败时整批撤回（防孤儿文件）。
// 从 Photos.jsx 抽出，纯逻辑、可单测。
import { supabase } from '../../lib/supabase.js'
import { toast } from '../../lib/toast.jsx'
import { removeUploads } from '../../lib/storage.js'

// 原图存在同一个桶里，用前缀区分：浏览图 photos/…，原图 originals/…
export const uploadOne = async (coupleId, file, prefix = 'photos') => {
  const ext = file.type === 'image/png' ? 'png' : 'jpg'
  const path = `${prefix}/${coupleId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('photos').upload(path, file, {
    cacheControl: '31536000',
    contentType: file.type || 'image/jpeg',
    upsert: false,
  })
  if (error) {
    toast.error('照片上传失败：' + error.message)
    return null
  }
  return path
}

// 孤儿文件清理：数据库没写进去时，本批已经传成功的文件统一撤回（导出便于测试）。
// 真正的实现在 lib/storage.js 的 removeUploads（桶不限，日记/留言也用它）；
// 这里保留单参旧签名：照片走 photos 桶，既有测试与 Photos.jsx 的转出都依赖它。
// Storage 的 remove 对不存在的路径不报错，重复调用安全。
export const rollbackUploads = async (paths) => removeUploads('photos', paths)
