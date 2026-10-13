# 消息推送（Web Push）开启指南

目标：TA 给你发留言/语音/日记/照片时，你的手机像微信一样弹通知——**App 在后台、甚至完全关闭都能收到**。

原理：App 里登记「这个浏览器的推送地址」→ 你一有新动态，数据库自动唤醒云函数 → 云函数把消息推到对方的手机系统（苹果/谷歌的推送服务器负责送达）。

---

## 第 1 步：跑数据库迁移（和以前跑迁移一样）

Supabase Dashboard → **SQL Editor** → New query → 打开本目录的 `supabase/migrations/026_push.sql`，全选粘贴 → **Run**。

会启用 pg_net 扩展（数据库→HTTP 网关，新版标准方案）+ 建 1 张表（push_subscriptions）+ 7 个触发器（留言/语音/照片/日记/评论/删图申请/生理期打卡，任何一张表有新内容就自动推送）。

> 若曾运行过**旧版**迁移文件报 `schema "supabase_functions" does not exist`：那是老版 Webhook 机制，新项目没有这个 schema，直接用现在这份新版即可，无需任何清理。

## 第 2 步：创建云函数（浏览器操作，无需命令行）

Supabase Dashboard → 左侧 **Edge Functions** → **Create a new function**：

1. 选择在**编辑器里写代码**的方式创建
2. 函数名必须填：`push-send`
3. 用本目录 `functions/push-send/index.ts` 的内容**整份替换**编辑器里的模板
4. 如果创建页有 **Verify JWT** 开关 → **关掉**（数据库触发器不带登录凭证，函数里另有密钥校验保护）
5. 点 **Deploy**

## 第 3 步：验证函数活着

浏览器直接打开（或 curl）：

```
https://wengwenilnywpijuraqn.supabase.co/functions/v1/push-send
```

看到 `{"ok":true,"hint":...}` 就说明部署成功（401/403 说明 Verify JWT 没关或没部署上）。

## 第 4 步：手机安装 + 开启通知（两台手机都要做）

**iPhone（iOS 16.4+）**：
1. Safari 打开 https://love-space-journal.app.workbuddy.host/
2. 点分享按钮 → **添加到主屏幕**（这步是苹果的硬性要求，不加收不到推送）
3. 从主屏幕图标打开 App（变成独立 App 样式，没有浏览器地址栏）
4. 首次进入会用**新的身份**，输入情侣码加入空间
   - ⚠️ 如果提示「空间已满员」：说明旧身份还占着位子，到 SQL Editor 跑：
     ```sql
     select id, nickname, user_id, created_at from public.members order by created_at;
     -- 找到旧的幽灵行（同一人重复加入的），然后：
     -- delete from public.members where id = '幽灵行的id';
     ```
5. 点「开启提醒」→ 允许通知

**Android（Chrome）**：
1. Chrome 打开网站 → 菜单 →「添加到主屏幕/安装应用」
2. 打开 App → 输入情侣码 → 点「开启提醒」→ 允许

## 第 5 步：测试

一台手机**完全划掉 App**（上滑关闭），另一台发一条留言 → 锁屏/通知栏应弹出「💗 对方昵称：给你留言：…」，点击直达留言板。

---

## 密钥说明（自用项目，已内嵌）

- VAPID 公钥：写在 `src/lib/push.js`（公开无妨）
- VAPID 私钥 + Webhook 密钥：内嵌在 `functions/push-send/index.ts`（只有你能看到 Dashboard 里的函数代码）
- 两者必须成对：换密钥时要同时改前端和函数

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 跑迁移报 `schema "supabase_functions" does not exist` | 用的是旧版迁移文件；换成现在这份（pg_net 方案）直接跑 |
| iPhone 点开启无反应 | 没加主屏幕 / iOS < 16.4；必须是主屏幕图标里打开 |
| 通知只在前台有 | 第 2 步函数没部署好或迁移没跑，按第 3 步验证 |
| 之前能收后来收不到 | iOS 会静默回收长期未用的订阅；打开一次 App 会自动补登记（自愈逻辑已内置） |
| 收到重复通知 | 页面横幅（App 内）和系统推送是同一件事的两条通道，前台时 SW 会吞掉推送；若重复请反馈 |
| 想关掉推送 | 手机系统设置 → 通知里关，或清浏览器数据 |
