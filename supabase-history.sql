-- ============================================================
-- 修改履歷功能
-- 在 Supabase Dashboard > SQL Editor 執行此檔案
-- ============================================================

-- 1. 建立 document_history 表
create table if not exists document_history (
    id          uuid default gen_random_uuid() primary key,
    document_id uuid not null references documents(id) on delete cascade,
    created_at  timestamptz not null default now(),
    created_by  uuid references auth.users(id) on delete set null,
    data        jsonb not null
);

create index if not exists idx_doc_history_lookup
    on document_history (document_id, created_at desc);

alter table document_history enable row level security;

-- 2. RPC: 新增一筆履歷，並自動刪除超過 30 筆的最舊紀錄
--    使用 edit_token 驗權，security definer 繞過 RLS
create or replace function add_document_history(
    p_edit_token text,
    p_data       jsonb,
    p_user_id    uuid default null
) returns void
language plpgsql security definer as $$
declare
    v_doc_id uuid;
begin
    select id into v_doc_id from documents where edit_token = p_edit_token;
    if v_doc_id is null then return; end if;

    insert into document_history (document_id, data, created_by)
    values (v_doc_id, p_data, p_user_id);

    -- 保留最近 30 筆，超過的刪除
    delete from document_history
    where document_id = v_doc_id
      and id not in (
          select id from document_history
          where document_id = v_doc_id
          order by created_at desc
          limit 30
      );
end;
$$;

-- 3. RPC: 取得指定文件的履歷清單（僅限 edit token 持有者）
create or replace function get_document_history(p_edit_token text)
returns table(
    id           uuid,
    created_at   timestamptz,
    display_name text,
    data         jsonb
)
language plpgsql security definer as $$
declare
    v_doc_id uuid;
begin
    select id into v_doc_id from documents where edit_token = p_edit_token;
    if v_doc_id is null then return; end if;

    return query
    select
        h.id,
        h.created_at,
        coalesce(p.display_name, '匿名') as display_name,
        h.data
    from document_history h
    left join profiles p on p.id = h.created_by
    where h.document_id = v_doc_id
    order by h.created_at desc;
end;
$$;
