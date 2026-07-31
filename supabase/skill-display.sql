-- ============================================================
-- 技能收合顯示設定（自訂設定組，綁定 Discord 帳號）
-- 在 Supabase Dashboard > SQL Editor 執行此檔案
-- 需先執行過 supabase-schema.sql（依賴 public.profiles、public.set_updated_at）
-- ============================================================

create table public.user_skill_display (
    user_id           uuid        references public.profiles(id) on delete cascade primary key,
    enabled           boolean     not null default false,
    active_profile_id text,
    skill_profiles    jsonb       not null default '[]',
    updated_at        timestamptz default now()
);
alter table public.user_skill_display enable row level security;

-- 使用者只能讀寫自己的設定
create policy "user_skill_display_self" on public.user_skill_display
    for all using (auth.uid() = user_id);

create trigger user_skill_display_set_updated_at
    before update on public.user_skill_display
    for each row execute procedure public.set_updated_at();
