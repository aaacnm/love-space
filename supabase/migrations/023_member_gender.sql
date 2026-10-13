-- ============================================================
--  023_member_gender.sql · 成员性别字段
--
--  顺序要求：无特殊要求
--  依赖迁移：001（members）
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from information_schema.columns where table_schema='public' and table_name='members' and column_name='gender')
--  check: members.gender 列已存在
-- ============================================================

-- 成员资料支持设置性别（male / female；未设置时为 null）
-- 在 SQL Editor 中执行一次即可，幂等可重复执行。

alter table public.members
  add column if not exists gender text
  check (gender in ('male', 'female'));

-- RLS 无需改动：members_update_own 策略本来就允许本人更新自己的整行，
-- 新列自动被覆盖（只能改自己的性别，对方改不了）。
