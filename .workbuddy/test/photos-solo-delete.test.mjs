// 单人空间删除免审核：源码扫描防回归
// 规则：members.length <= 1（只有自己）时 requestDelete 直接软删除，
// 不写 delete_requests；两个确认弹窗的文案与按钮随 isSolo 切换。
import { photoSrc } from './photo-src.mjs'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name)
  }
}

// Photos.jsx 已拆成 src/views/photos/ 多模块，扫描要覆盖整个目录
const src = photoSrc()

// 1. isSolo 判定存在且基于成员数
ok(/const isSolo = members\.length <= 1/.test(src), 'isSolo = members.length <= 1（单人空间判定）')

// 2. requestDelete 里的单人直删分支：在防重逻辑之前、调用 softDelete 且不写 delete_requests
const reqFn = src.match(/const requestDelete = async [\s\S]*?\r?\n  \}\r?\n/)
ok(!!reqFn, 'requestDelete 函数可定位')
if (reqFn) {
  const body = reqFn[0]
  const soloIdx = body.indexOf('if (isSolo)')
  const dupIdx = body.indexOf('const dup =')
  const insertIdx = body.indexOf(".from('delete_requests').insert")
  ok(soloIdx > -1, 'requestDelete 含 isSolo 直删分支')
  ok(soloIdx > -1 && dupIdx > -1 && soloIdx < dupIdx, '单人分支在防重检查之前（单人无需防重）')
  ok(soloIdx > -1 && insertIdx > -1 && soloIdx < insertIdx, '单人分支在写申请表之前（不产生死申请）')
  ok(/if \(isSolo\)[\s\S]*?softDelete\(\{ kind, ref_ids: ids \}\)/.test(body), '单人分支直接软删除（进最近删除）')
  ok(/if \(isSolo\)[\s\S]*?reload\(\)/.test(body), '单人分支删除后刷新列表')
}

// 3. 两个确认弹窗：文案与按钮随 isSolo 切换
ok(/title=\{isSolo \? '删除图集？' : '申请删除图集？'\}/.test(src), '图集弹窗标题随 isSolo 切换')
ok(
  /isSolo\s*\?\s*'空间里暂时只有你一个人，无需 TA 审核：图集直接删除/.test(src),
  '图集弹窗文案含单人版',
)
ok(
  /isSolo\s*\?\s*'空间里暂时只有你一个人，无需 TA 审核：照片直接进入「最近删除」/.test(src),
  '照片弹窗文案含单人版',
)
const soloLabels = src.match(/confirmLabel=\{isSolo \? '删除' : '发给 TA'\}/g) || []
ok(soloLabels.length === 2, '两个弹窗按钮文案随 isSolo 切换（删除 / 发给 TA）')

// 4. 双人路径不受影响：申请、防重、提示原样保留
ok(/已发给 TA，等 TA 同意后才会删除 ⏳/.test(src), '双人路径提示保留')
ok(/const dup = pendingReqs\.find/.test(src), '双人路径防重保留')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
