# 💕 我们的恋爱手账

> 给两个人留一间安静的房间，记录相爱，也允许好好说完一次不开心。

一个面向情侣的私密关系空间。它不追求把生活做成公开动态流，而是把重要的日子、想说的话、共同的回忆和难以开口的情绪，留在只属于你们的地方。

[![CI](https://github.com/aaacnm/love-space/actions/workflows/ci.yml/badge.svg)](https://github.com/aaacnm/love-space/actions/workflows/ci.yml)

## 这里有什么不一样

### 🕊️ 矛盾处理室

争执发生时，先给关系留出一点秩序：一人一句、轮流表达、设定时间边界，结束也需要双方同意。它不替你判断谁对谁错，只负责让两个人都有机会把话说完。

### 📷 回忆不是相册列表

照片会按时间自然长成一条属于你们的记忆线。图集、置顶、随机回忆和批量保存，让“以前发生过什么”变成随时可以重新打开的一小段时间。

### 💌 留言可以慢一点到达

文字、语音、图片、回应和评论都在同一面留言墙上。对方不在线时，重要动态可以通过系统通知送达；重新打开时，未读内容会回到该出现的位置。

### 🌸 关系也需要被照顾

除了纪念日和见面倒计时，还可以记录经期、身体状态和心情。它不是数据面板，而是给另一半一个更具体的“今天该怎么陪伴”的提示。

## 适合谁

- 想把异地生活放进同一个小空间的两个人
- 想留下共同回忆，但不想把关系公开给所有人的情侣
- 想在情绪上来时，仍然给彼此一次完整表达机会的人

## 技术栈

React + Vite + Tailwind CSS · Supabase（Postgres + Auth + Storage + Realtime）· Vercel · PWA

> 这是一个真实可用的二次创作项目，保留原项目的基础思路，并加入了矛盾处理室、弱网首屏、图片缩略图和 Web Push 等方向的改进。

---

## 🚀 上线步骤（照做即可，全程约 10 分钟，都免费）

你需要准备两个免费账号：**Supabase**（数据库）和 **Vercel + GitHub**（部署网站）。不需要把任何密码/密钥发给我。

### 第一步：创建 Supabase 数据库

1. 打开 https://supabase.com ，点 **Start your project** 用 GitHub 或邮箱注册登录。
2. 进入控制台后点 **New project**：
   - Name 随便填，比如 `love-space`
   - Database Password 点 **Generate a password** 自动生成（记不记都行，之后用不到）
   - Region 选一个离你近的，比如 `Southeast Asia (Singapore)` 或 `East US`
   - 点 **Create new project**，等 1~2 分钟初始化完成。
3. 左侧菜单点 **SQL Editor** → **New query**，把本项目 `supabase/schema.sql` 文件里的**全部内容**复制粘贴进去，点 **Run**（或按 `Ctrl+Enter`）。
   - 看到 `Success. No rows returned` 即成功，表、权限、图片存储、实时同步就全部建好了。
   - 这个文件是 `supabase/migrations/` 自动生成的最新快照，等价于按编号跑完全部迁移；更稳妥的做法是按 [数据库迁移](#-数据库迁移) 一节按编号执行。

4. 开启匿名登录：左侧菜单 **Authentication** → **Providers**（或 **Sign In / Up**）→ 找到 **Anonymous** → 打开开关（**Enable anonymous sign-ins**）→ 保存。

5. 复制密钥：左侧菜单 **Settings** → **API**，你会看到：
   - **Project URL**（形如 `https://xxxx.supabase.co`）
   - **anon public** 那一串很长的 key
   把这两个值先记下来，下一步要用。

### 第二步：部署到 Vercel

1. 把本项目文件夹推到一个 **GitHub 仓库**：
   - 打开 https://github.com ，登录后点右上角 **+** → **New repository**，起个名（如 `love-space`），**不要**勾选初始化 README，点 **Create repository**。
   - 在你的电脑上本项目目录里执行（把地址换成你自己的仓库）：
     ```bash
     git init
     git add .
     git commit -m "init love space"
     git branch -M main
     git remote add origin https://github.com/你的用户名/love-space.git
     git push -u origin main
     ```

2. 打开 https://vercel.com ，点 **Sign Up**，选 **Continue with GitHub** 登录并授权。

3. 点 **Add New… → Project**，在列表里选中刚才那个 `love-space` 仓库，点 **Import**。

4. 在 **Environment Variables** 里添加两个变量（名字要完全一致，注意 `VITE_` 前缀）：
   - `VITE_SUPABASE_URL` = 第一步第 5 步的 Project URL
   - `VITE_SUPABASE_ANON_KEY` = 第一步第 5 步的 anon key

5. 点 **Deploy**，等一两分钟，出现 `Congratulations!` 和一个网址（形如 `https://love-space-xxx.vercel.app`），就是你们的网站了 🎉

### 第三步：开始使用

1. 打开那个网址 → 会自动匿名登录。
2. **第一个人**点「创建空间」：填昵称、选头像、选城市、填在一起的纪念日 → 生成一个 6 位**情侣码**。
3. 把情侣码发给对方（首页点一下情侣码即可复制）。
4. **第二个人**打开网址点「加入空间」，输入情侣码 + 自己的昵称/头像/城市 → 就进入了同一个空间。
5. 之后谁打开网址都会自动进入，两边发日记、传照片、打卡、留言都能**实时看到对方**。

---

## 💻 本地运行（可选，方便你自己先预览/改样式）

```bash
npm install
# 复制 .env.example 为 .env，填入 Supabase 的 URL 和 anon key
cp .env.example .env
npm run dev
```

浏览器打开提示的地址（默认 http://localhost:5173 ）即可。本地同样走真实 Supabase 数据。

---

## 🗂 数据库迁移

`supabase/migrations/` 是**库结构的唯一事实来源**，按编号升序执行：

```
supabase/
├─ migrations/                       # ← 唯一事实来源，编号即版本：001 … 038
│  ├─ 001_initial.sql                #    初始库结构（表 + RLS + 存储 + 实时）
│  └─ 038_push_secrets.sql            #    最新的一个（推送密钥从仓库移入 Vault）
├─ schema.sql                        # ⚙️ 自动生成的一次性建库快照（勿手改）
├─ check_migration_status.sql        # ⚙️ 自动生成的「当前库跑到哪了」自查脚本（勿手改）
├─ diagnostics/                      #    临时排查脚本（诊断用，不属于迁移）
└─ functions/                        #    Edge Functions（Web Push）
```

每个迁移文件头部都写清了四件事：`顺序要求` / `依赖迁移` / `fingerprint`（判断是否执行过的布尔 SQL）/ `check`（人话说明）。
`schema.sql` 与 `check_migration_status.sql` 由 `npm run db:sync` 从 `migrations/` 生成——**`npm run ci` 会拒绝生成物漂移**，所以不会再出现"schema.sql 是最新的，但不知道生产库跑过哪些"。

### 新环境执行什么

**方案 A · 用 Supabase CLI（推荐，以后能持续追版本）**

```bash
supabase init                       # 生成 supabase/config.toml（已有则跳过）
supabase link --project-ref <你的项目 ref>   # Settings → General 里找 ref
supabase db push                    # 按编号把 001 → 最新全部应用
```
`db push` 会把执行记录写进 `supabase_migrations.schema_migrations`，之后每次新增迁移都只要再 push 一次。

**方案 B · 不用 CLI（SQL Editor 粘贴）**

把 `supabase/schema.sql` 整份粘贴进 SQL Editor 执行一次即可（内容 = 全部迁移按序执行的结果）。
若担心一次跑几十条 DDL 触发锁等待（40P01），就改成打开 `migrations/` 下的文件，按 **001 → 038 顺序逐个粘贴执行**。

### 已上线环境执行什么

已上线的库以前是手工在 SQL Editor 里跑的，CLI 并不知道跑到哪了，所以要"补登记 + 补跑"两步：

```bash
# 1. 先看清现状（两种办法任选）
supabase migration list             # CLI 视角：本地 vs 远端差异
# 或：把 supabase/check_migration_status.sql 贴进 SQL Editor 跑，
#     status 列写着「未执行 ← 需要补跑」的那些就是缺的

# 2. 已经手工跑过、但 CLI 没记录的迁移，逐个登记为已执行（版本号就是文件名前三位）
supabase migration repair 006 --status applied
supabase migration repair 007 --status applied
# …把查出来「指纹已存在」的全部登记一遍

# 3. 剩下的（真正没跑过的）一次性推上去
supabase db push
```

> 没有 CLI 也行：跑自查脚本找出 status 为「未执行」的编号，然后把对应文件按顺序粘进 SQL Editor 执行。

### 哪些迁移必须按顺序

绝大多数是加列 / 加表，彼此独立；**真正有硬顺序依赖**的是这几组（顺序错了会直接报错或行为异常）：

| 组 | 顺序 | 为什么必须这样 |
| --- | --- | --- |
| 图集三步 | 006 → 007 → 008 | 先有 `albums` 表，才能给 `photos` 加外键、再加 RLS |
| 和好两步 | 009 → 010 | 009 建表，010 才给它们设 REPLICA IDENTITY FULL |
| 信号灯两步 | 011 → 012 | 同上 |
| 记忆空间两步 | 028 → 029 | 028 加图集简介，029 加照片置顶 |
| 软删 → 审批 | 019 → 031 | `delete_requests` 表不存在，审批 RPC 建不出来 |
| 生理期 → 每日记录 → Push | 020 → 022 → 026 | Push 的触发器挂在 `period_daily_logs` 上，表不在则建触发器失败 |
| 通知 publication | 002/004/013/017/019 → 021 | 021 要把这 7 张表收进 realtime publication，缺表只能跳过并重跑 |
| 全部表就绪 → 分页索引 | … → 032 | 索引建在已有表上（不跑也能用，只是全表扫描） |
| 首屏聚合 RPC | … → 033 | `bootstrap_space()` 一次返回用户/空间/成员/纪念日/下次见面。**前端已容错：033 没跑时自动回退原来的多请求路径**，所以可以先发前端再补跑（补跑后首屏少 2 段往返） |
| 缩略图保障 | 024 → 034 | `photos_missing_thumb()` 建在 024 加的 `thumb_path` 上。不跑也能用：缺缩略图的旧照片走服务端 480 变换，前端还会后台补一份真实缩略图写回 |
| **⚠️ 存储私有化 + 前端发布顺序** | **先发布新版前端，再跑 030** | 030 把 `photos`/`voice` 桶转私有；旧前端用的是公开 URL，一转私有历史图片全部 403 |
| **⚠️ 审批 RPC + 前端发布顺序** | **先跑 031，再发布前端** | 前端「同意删除」依赖 `approve_delete_request`，函数没建好就发版会功能不可用 |
| **⚠️ 矛盾处理室 + 前端发布顺序** | **先跑 037，再发布前端** | 和好 tab 的全部动作（发起/加入/发言/结束）都走 037 的 RPC；没跑时点任何按钮都会提示函数不存在 |

### 如何检查当前数据库版本

| 想要的信息 | 怎么做 |
| --- | --- |
| 每行一个迁移、哪些没跑 | SQL Editor 跑 `supabase/check_migration_status.sql` |
| 用 CLI 管过的库的版本历史 | 自查脚本第 3 段会自动处理：没有 `supabase_migrations` schema 就在 Messages 标签页提示「尚未启用」，有则逐条列出已登记版本 |
| 本地 vs 远端差异 | `supabase migration list`（远端列空 = 还没被推过） |
| 某个功能到底建好没 | 看迁移头部的 `fingerprint` 那一行，单独粘出来跑：返回 `t` 即已就位 |
| 生成物是否已漂移 | `npm run db:check`（CI 里自动跑） |

### 新增一个迁移的规矩

```bash
supabase migration new <英文小写下划线名字>   # 生成 supabase/migrations/时间戳_名字.sql
# 手工改名我发现更省心：用「当前最大编号 + 1」当版本，如 039_xxx.sql
```

1. 文件名 `NNN_slug.sql`，编号**必须比现有最大的大 1**（不能有断层，测试会拦）。
2. 头部必须写全四件套（`顺序要求` / `依赖迁移` / `fingerprint` / `check`）——`fingerprint` 要选一个"这条迁移独有的特征"，越具体越不会被误判为已执行。
3. 全部语句用 `if not exists` / `create or replace`，保证幂等可重复跑。
4. 结尾别忘了 `notify pgrst, 'reload schema';`（新增/改动表结构必须刷新 PostgREST 缓存，否则前端 API 立刻 404）。
5. 改完跑 `npm run db:sync` 重新生成 snapshot 与自查脚本，再跑 `npm run ci`。
6. 涉及前端行为的顺序约束（比如 030 / 031），务必同步写进上表，别只记在脑子里。
7. 可选的语法自检：本机没有 Postgres 也能验语法——`pip install pglast` 后用
   `pglast.parse_sql()` + `pglast.parse_plpgsql()` 解析一遍（后者才会检查 DO 块/函数体内部的 PL/pgSQL）。

## 🔤 字体（不依赖任何第三方 CDN）

页面**不引外部字体**，两条规则：

- **正文/中文全部用系统字体** —— `system-ui / PingFang SC / 微软雅黑`，零网络等待，中文在各平台都是本机字形；
- **装饰字体自托管** —— 只有一个文件 `src/assets/fonts/baloo2-latin-var.woff2`（33 KB，Baloo 2 的可变字体，
  一个文件覆盖 400–800 全部字重），`@font-face` 写在 `src/index.css`，并且：

  - `unicode-range` 限死拉丁区 → 中文**根本不触发下载**，页面没有数字/字母时连请求都不发；
  - `font-display: swap` → 先用系统字体画出来，字体到了再换，绝不阻塞首屏；
  - 只覆盖 Latin/数字（首页那串"在一起多少天"、计时器），中文标题回落系统字体。

为什么不做中文字体自托管：中文装饰字体动辄几 MB（原来引的 ZCOOL KuaiLe 就是），为了几个标题的
手感去背这个体积不划算；而外链 `fonts.googleapis.com` 在国内不可达，一行阻塞渲染的样式表就能把首屏卡到超时。

`tests/fonts-selfhosted.test.js` 会守住这条线（页面不许出现 googleapis/gstatic、@font-face 必须本地、
必须带 swap 与 unicode-range、不得按字重拆成多份）。

## 📴 离线与缓存（Service Worker）

`public/sw.js` 按**资源性质**分三层，越靠上越快。这套策略解决的是「第二次打开」和「弱网打开」：
以前是全局 network-first，手机明明缓存好了，网络一慢还是先干等网络。

| 资源 | 策略 | 为什么 |
| --- | --- | --- |
| 带内容 hash 的产物（`/assets/index-a1b2c3d4.js`、`.css`、字体…） | **cache-first** | 文件名就是内容指纹，内容永不变化，命中立刻返回，一秒都不等网络；发新版引用的是新文件名，不会撞旧缓存 |
| 页面导航（HTML） | **network-first + 1.5s 超时** | 超时或断网立刻回退缓存，弱网首屏不转圈；同时保证发新版能拿到新 HTML |
| 其它同源资源（图标、清单、以及 `/src/**` 这类没 hash 的源码模块） | **network-first + 1.2s 超时**，缓存兜底 | 它们没有内容指纹，长期钉住会让手机一直跑旧代码，所以让网络优先；断网时仍用缓存兜底，不白屏 |

几条刻意的取舍：

- **不给 `/src/**` 做 cache-first** —— 本项目线上是 Vite dev server 直出源码（文件名不带 hash），
  cache-first 会把旧模块钉在手机上。要真正的秒开，得让前端走 `dist` 静态托管（那时 `/assets/*` 全部带 hash）。
- **导航缓存统一存在 `'/'` 键上** —— 这个 App 没有路由，所有导航都是同一个壳；顺带绕开
  navigate 模式 Request 在 Cache 里的存储限制。
- **不接管**：跨域（Supabase / 字体 CDN）、非 GET、带 `Range` 的请求（音视频拖动会依赖 206）、
  以及 `sw.js` 自己（缓存住自己就永远升不了级）。
- **`install` 顺手预热 `'/'`** —— 这样第一次重开就有兜底，不用先成功导航一次。
- 命中不到又没有网络时返回 **504 空响应**，而不是把未处理异常抛给页面。

**发新版怎么清旧缓存**：把 `public/sw.js` 顶部的 `VERSION` 加一（`v3` → `v4`）。
`activate` 会删掉所有不在当前版本里的缓存 —— 带 hash 的资源本来就不会冲突，
这一步主要是清垃圾、以及让长期不关的页面丢掉过期兜底数据。**不改版本号也不会出错**，
只是旧缓存会多留一阵子。

`tests/sw-cache.test.js` 会把 `sw.js` 真的放进假 `self` / `caches` / `fetch` 环境里执行，
断言「第二次打开零网络请求」「网络挂住时超时后回退缓存」「无 hash 的模块不会被钉住」
「跨域/Range/POST/sw.js 一律不接管」「activate 清旧版本」等 18 条事实。

## 📁 目录结构

```
love-space/
├─ index.html
├─ src/
│  ├─ main.jsx / App.jsx
│  ├─ lib/          # supabase 客户端、情侣码逻辑、全局状态、hooks
│  ├─ assets/fonts/ # 自托管装饰字体（Baloo 2 latin 可变字体，33 KB，见 index.css）
│  ├─ components/   # 通用卡片/弹窗/底部导航
│  └─ views/        # 6 个页面 + 首次进入引导
│     ├─ tabLoaders.js   # 页签分包入口（lazy 与预加载共用这一份）
│     └─ tabPrefetch.js  # 预加载策略：按下即拉 / 弱网不预热 / 后台最多一个
├─ scripts/         # sync-migrations / run-legacy-tests
├─ tests/           # Vitest + Testing Library 用例（见下）
└─ supabase/
   ├─ migrations/   # 库结构唯一事实来源（001 … 038，见「数据库迁移」）
   ├─ schema.sql    # 由 migrations/ 自动生成的一次性建库快照
   └─ functions/    # Edge Functions（Web Push）
```

## 🧩 页签分包与预加载策略

首页 `Home` 是静态引入（首屏零等待），其余 5 个页签各自一个动态分包 —— 这部分没变，
**不要把页面打回首包**。变的是「什么时候把这些分包拉下来」：

| 时机 | 行为 | 原因 |
| --- | --- | --- |
| **按下页签**（`pointerDown`，早于 `click`） | 立刻拉对应分包 | 用户意图明确，这个请求点了也要发，只是提前了几十毫秒，**不受网络条件限制** |
| **空闲时后台预热** | 先看网络：省流或 `2g/slow-2g` 就一个都不预热；否则**最多挑一个** | 以前空闲时把 5 个一起拉，弱网会跟首屏数据、缩略图抢带宽，反而拖慢首屏 |
| 挑哪一个 | 按 localStorage 里的**历史点击次数**（次数优先、同次数看最近），没有历史就不预热 | 写死的优先级只对一半人有效；第一次用没数据就不瞎猜，等用户真的点了再说 |

实现在 `src/views/tabLoaders.js`（数据）与 `src/views/tabPrefetch.js`（策略）；`lazy` 和预加载共用同一份
loader，两边不可能跑偏。预加载**幂等**（已加载/加载中不重复请求）、**失败可重试**且**绝不冒泡**
（部署期间 chunk 404 不该把页面搞挂）。

`tests/tab-prefetch.test.jsx`（19 例）覆盖门槛、预测、幂等与 TabBar 集成；
历史用例 `.workbuddy/test/lazy-tabs.test.mjs` 也会守住「不再一次性拉齐 5 个分包」。

## 🧱 先画结构，再填数据

页面不等数据到齐才渲染：

| 层 | 做法 |
| --- | --- |
| 首页 | 结构永远是渲染出来的（卡片/标题框都在），缺的只是里面的数字和文字；情侣码没到显示 `••••••` |
| 列表（日记 / 留言 / 照片） | 上一次打开的数据存在 localStorage（`src/lib/collectionCache.js`），**首帧直接画出来**，请求照发，回来后整段覆盖 |
| 缓存也没有时 | 出骨架屏（`src/components/Skeleton.jsx`），外框尺寸与真卡片一致 —— 数据到达不跳 |
| 请求失败 | 保留已画出来的内容，不用空列表覆盖（多半是弱网抖动，不该闪成「什么都没有」） |

三条硬规矩：

1. **图片必须有明确比例**：留言图 `aspect-[4/3]` 且骨架同比例；灯箱/大图用「固定高度容器 + `object-contain`」。
   等到图下载完才由它撑开高度 = 布局跳动，是最影响体感的一类位移。
2. **缓存只用来快速展示**，可见性仍由 Supabase RLS 裁定 —— key 里带 `coupleId`，换空间立刻切过去。
3. 缓存有 TTL（7 天）、条数上限（60）与体积上限（200KB），写不进去就干脆不写，不能把 localStorage 打爆。

`tests/first-paint.test.jsx`（17 例）覆盖缓存读写/隔离/过期/超限、钩子首帧就返回缓存行、
有了缓存就不出骨架、图片补丁尺寸一致。

## 🧪 测试与检查

```bash
npm run test          # Vitest 全量跑一次（不连真库，用内存版 Supabase）
npm run test:watch    # 改动即时跑
npm run test:coverage # 顺带出覆盖率报告（coverage/）
npm run test:legacy   # .workbuddy/test 下的历史 jsdom 冒烟用例（约 2 分钟）
npm run lint          # ESLint（错误会卡 CI，告警只提示）
npm run typecheck     # tsc 语法 / 模块解析检查（JS 项目，不做类型标注检查）
npm run ci            # lint + typecheck + test + db:check + build，本地模拟 CI
npm run db:sync       # 从 migrations/ 重新生成 schema.sql 与 check_migration_status.sql
npm run db:check      # 校验上面两个生成物是否与 migrations/ 同步（不同步就报错）
```

测试跑在 jsdom 里，`src/lib/supabase.js` 被替换成内存替身（`tests/helpers/`），
既能断言「发了什么请求」，也能注入各种失败（写库失败、签名失败、RPC 不存在……）。
重点覆盖的链路：

| 用例 | 守护的行为 |
| --- | --- |
| `photo-delete-approval` | 双人删除必须 TA 点头；批准只走事务 RPC，失败可重试 |
| `photo-solo-delete` | 单人空间直删进最近删除，30 天内可找回；失败如实提示 |
| `photo-trash` | 恢复 / 彻底删除（含三份文件清理）与各种失败分支 |
| `photo-upload-rollback` | 入库失败整批撤回文件，不留孤儿 |
| `unread-isolation` | 未读基线按 用户 + 空间 双维度隔离 |
| `photo-browse-mode` | 相册浏览方式按 用户 + 空间 隔离，最多留 4 个空间 |
| `realtime-lifecycle` | 隐藏页暂停订阅、切回/回前台/断网补拉、DELETE 按空间过滤 |
| `migrations-layout` | 迁移编号连续不重复、元信息齐全、依赖不成环、生成物不漂移 |

GitHub Actions（`.github/workflows/ci.yml`）在每次 push / PR 上跑 lint、typecheck、test、db:check、build。

## ❓ 常见问题

- **换手机/清缓存后还能进吗？** 匿名身份存在浏览器里，清缓存会导致身份丢失。建议用「情侣码」重新加入即可（数据都在，不会丢）。
- **照片会公开吗？** 图片链接是随机文件名，只有拿到链接的人能看，普通访客看不到。情侣码才是进入空间的钥匙。
- **想改两个人名字/城市？** 目前首次进入时填写。后续可在首页「设置下次见面」旁补充编辑资料（可在后续迭代加）。
