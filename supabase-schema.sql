-- ============================================================
-- FFXIV MIT Planner - Supabase Schema (Phase 1)
-- 在 Supabase Dashboard > SQL Editor 執行此檔案
-- ============================================================

-- ── 1. profiles（Discord 使用者資料）────────────────────────
create table public.profiles (
    id              uuid references auth.users on delete cascade primary key,
    discord_id      text,
    discord_username text not null default '',
    discord_avatar  text,
    created_at      timestamptz default now()
);
alter table public.profiles enable row level security;

create policy "profiles_self" on public.profiles
    for all using (auth.uid() = id);

-- ── 2. documents（減傷範本）─────────────────────────────────
create table public.documents (
    id          uuid        default gen_random_uuid() primary key,
    owner_id    uuid        references public.profiles(id) on delete cascade not null,
    duty_key    text        not null,
    name        text        not null default '未命名範本',
    data        jsonb       not null default '{}',
    -- 兩個 token 各自獨立產生，完全不同
    edit_token  text        unique not null default encode(gen_random_bytes(16), 'hex'),
    read_token  text        unique not null default encode(gen_random_bytes(20), 'hex'),
    created_at  timestamptz default now(),
    updated_at  timestamptz default now()
);
alter table public.documents enable row level security;

-- 擁有者有完整操作權限
create policy "documents_owner" on public.documents
    for all using (auth.uid() = owner_id);

-- ── 3. updated_at 自動更新 ───────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create trigger documents_set_updated_at
    before update on public.documents
    for each row execute procedure public.set_updated_at();

-- ── 4. Discord OAuth 後自動建立 profile ──────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
    insert into public.profiles (id, discord_id, discord_username, discord_avatar)
    values (
        new.id,
        new.raw_user_meta_data->>'provider_id',
        coalesce(
            new.raw_user_meta_data->>'full_name',
            new.raw_user_meta_data->>'user_name',
            ''
        ),
        new.raw_user_meta_data->>'avatar_url'
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- ── 5. Token-based RPC（繞過 RLS，讓未登入者可用分享連結）───
-- 根據 edit_token 或 read_token 查詢 document，並回傳 token 類型
create or replace function public.get_document_by_token(p_token text)
returns table (
    id          uuid,
    owner_id    uuid,
    duty_key    text,
    name        text,
    data        jsonb,
    edit_token  text,
    read_token  text,
    created_at  timestamptz,
    updated_at  timestamptz,
    token_type  text        -- 'edit' | 'read'
)
language sql security definer as $$
    select
        d.id, d.owner_id, d.duty_key, d.name, d.data,
        d.edit_token, d.read_token, d.created_at, d.updated_at,
        case when d.edit_token = p_token then 'edit' else 'read' end
    from public.documents d
    where d.edit_token = p_token or d.read_token = p_token
    limit 1;
$$;

-- 透過 edit_token 更新 document 資料（未登入的共同編輯者使用）
create or replace function public.update_document_by_edit_token(
    p_token text,
    p_data  jsonb,
    p_name  text default null
)
returns void
language sql security definer as $$
    update public.documents
    set
        data = p_data,
        name = coalesce(p_name, name)
    where edit_token = p_token;
$$;

-- ── 6. 查詢索引（效能優化）──────────────────────────────────
create index documents_owner_id_idx  on public.documents(owner_id);
create index documents_edit_token_idx on public.documents(edit_token);
create index documents_read_token_idx on public.documents(read_token);
