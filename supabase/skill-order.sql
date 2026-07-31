-- ============================================================
-- 技能顯示順序（拖曳自訂，綁定 Discord 帳號）
-- 在 Supabase Dashboard > SQL Editor 執行此檔案
-- 需先執行過 supabase-skill-display.sql（沿用同一張 user_skill_display 表）
-- ============================================================

alter table public.user_skill_display
    add column if not exists skill_order jsonb not null default '{}';
