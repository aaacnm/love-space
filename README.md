# 💕 我们的恋爱手账

一个只属于你们两个人的私密空间，用来记录异地恋的点滴：在一起天数实时跳动、见面倒计时、双人日记、照片墙、三类愿望清单、留言板、时间线。两人用**同一个情侣码**进入同一份数据，任何一台设备打开都能实时同步。

## 功能一览

| 页面 | 功能 |
|------|------|
| 💕 首页 | 在一起天数实时跳动 + 下次见面倒计时进度条 + 两人城市与当地时间 |
| 📔 日记 | 双人共享日记，带情绪标签，倒序展示 |
| 🖼️ 照片墙 | 上传照片 + 一句话备注，网格相册、大图查看 |
| ✅ 愿望清单 | 分三类：想一起去的地方 / 想吃的东西 / 想做的事，做完打卡 |
| 💌 留言板 | 便利贴墙，随手留一句悄悄话 |
| 📅 时间线 | 按日期回顾重要节点 |

## 技术栈

React + Vite + Tailwind CSS · Supabase（Postgres + Auth + Storage + Realtime）· 部署到 Vercel（免费）

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
├─ migrations/                       # ← 唯一事实来源，编号即版本：001 … 032
│  ├─ 001_initial.sql                #    接手本项目时的初始库结构（8 张表 + RLS + 存储 + 实时）
│  └─ 032_paged_indexes.sql          #    最新的一个
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
若担心一次跑几十条 DDL 触发锁等待（40P01），就改成打开 `migrations/` 下的文件，按 **001 → 032 顺序逐个粘贴执行**。

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
| **⚠️ 存储私有化 + 前端发布顺序** | **先发布新版前端，再跑 030** | 030 把 `photos`/`voice` 桶转私有；旧前端用的是公开 URL，一转私有历史图片全部 403 |
| **⚠️ 审批 RPC + 前端发布顺序** | **先跑 031，再发布前端** | 前端「同意删除」依赖 `approve_delete_request`，函数没建好就发版会功能不可用 |

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
# 手工改名我发现更省心：用「当前最大编号 + 1」当版本，如 033_xxx.sql
```

1. 文件名 `NNN_slug.sql`，编号**必须比现有最大的大 1**（不能有断层，测试会拦）。
2. 头部必须写全四件套（`顺序要求` / `依赖迁移` / `fingerprint` / `check`）——`fingerprint` 要选一个"这条迁移独有的特征"，越具体越不会被误判为已执行。
3. 全部语句用 `if not exists` / `create or replace`，保证幂等可重复跑。
4. 结尾别忘了 `notify pgrst, 'reload schema';`（新增/改动表结构必须刷新 PostgREST 缓存，否则前端 API 立刻 404）。
5. 改完跑 `npm run db:sync` 重新生成 snapshot 与自查脚本，再跑 `npm run ci`。
6. 涉及前端行为的顺序约束（比如 030 / 031），务必同步写进上表，别只记在脑子里。
7. 可选的语法自检：本机没有 Postgres 也能验语法——`pip install pglast` 后用
   `pglast.parse_sql()` + `pglast.parse_plpgsql()` 解析一遍（后者才会检查 DO 块/函数体内部的 PL/pgSQL）。

## 📁 目录结构

```
love-space/
├─ index.html
├─ src/
│  ├─ main.jsx / App.jsx
│  ├─ lib/          # supabase 客户端、情侣码逻辑、全局状态、hooks
│  ├─ components/   # 通用卡片/弹窗/底部导航
│  └─ views/        # 6 个页面 + 首次进入引导
├─ scripts/         # sync-migrations / run-legacy-tests
├─ tests/           # Vitest + Testing Library 用例（见下）
└─ supabase/
   ├─ migrations/   # 库结构唯一事实来源（001 … 032，见「数据库迁移」）
   ├─ schema.sql    # 由 migrations/ 自动生成的一次性建库快照
   └─ functions/    # Edge Functions（Web Push）
```

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
