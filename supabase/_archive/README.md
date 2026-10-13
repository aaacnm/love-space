# 归档：整理前的散装迁移脚本

`supabase/migrations/` 之前的样子——33 个 `migration_*.sql` 平铺在 `supabase/` 根目录，
没有编号、看不出执行顺序，也无法回答"生产库到底跑过哪些"。

现在它们已经按依赖顺序整理成 `supabase/migrations/NNN_*.sql`（编号即版本），
**这里保留原文件只是为了事后核对**：整理时是否漏了内容、某个字段当时为什么写成这样，
都可以回来 grep 原始文件。

## 对应关系（旧 → 新）

| 旧文件 | 新编号 |
| --- | --- |
| （git HEAD 的原始 `schema.sql`） | `001_initial.sql` |
| migration_pokes.sql | 002 |
| migration_interactive.sql | 003 |
| migration_diary.sql | 004 |
| migration_realtime.sql | 005_realtime_replica |
| migration_albums_a / _b / _c.sql | 006 / 007 / 008 |
| migration_conflicts_a / _b.sql | 009 / 010 |
| migration_signal_a / _b.sql | 011 / 012 |
| migration_voice.sql | 013 |
| migration_message_hidden.sql | 014 |
| migration_trash.sql | 015 |
| migration_trash_v2.sql | 016_trash_purge |
| migration_message_comments.sql | 017 |
| migration_photo_original.sql | 018 |
| migration_photo_delete.sql | 019 |
| migration_period.sql | 020 |
| migration_notify.sql | 021_notify_publication |
| migration_period_daily.sql | 022 |
| migration_member_gender.sql | 023 |
| migration_photo_thumb.sql | 024 |
| migration_message_hidden_policy.sql | 025 |
| migration_push.sql | 026 |
| migration_messages_enrich.sql | 027 |
| migration_photos_memory_a / _b.sql | 028 / 029 |
| migration_storage_private.sql | 030 |
| migration_delete_approve_rpc.sql | 031 |
| migration_paged_indexes.sql | 032 |

纯说明性的 `migration_albums.sql` / `migration_conflicts.sql`（没有 SQL，只有"为什么要拆"的注释）
已并入对应分组第一个文件的头部注释。

> 确认 `supabase/check_migration_status.sql` 在生产库上的结果与你预期一致之后，
> 本目录可以整个删掉。
