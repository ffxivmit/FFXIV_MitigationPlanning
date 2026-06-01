import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Supabase Dashboard > Settings > API 取得這兩個值後填入
const SUPABASE_URL      = 'https://eoyihcgqtdiqesuesrvw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVveWloY2dxdGRpcWVzdWVzcnZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNzM2NDksImV4cCI6MjA5NTg0OTY0OX0.5Vxm381ZD7xJnG0QCX95klwYa4Ufnon-mRMZO-c1uYw';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
    },
});

// ── Auth helpers ──────────────────────────────────────────────

export const signInWithDiscord = () =>
    sb.auth.signInWithOAuth({
        provider: 'discord',
        options: {
            redirectTo: window.location.origin + window.location.pathname,
        },
    });

export const signOut = () => sb.auth.signOut();

export const getSession = () => sb.auth.getSession();

export const onAuthStateChange = (callback) =>
    sb.auth.onAuthStateChange(callback);

// ── Document helpers ──────────────────────────────────────────

// 取得目前使用者的所有範本（登入狀態下使用）
export const fetchMyDocuments = () =>
    sb.from('documents')
        .select('id, duty_key, name, data, edit_token, read_token, updated_at')
        .order('updated_at', { ascending: false });

// 建立新範本
export const createDocument = (ownerId, dutyKey, name, data) =>
    sb.from('documents')
        .insert({ owner_id: ownerId, duty_key: dutyKey, name, data })
        .select()
        .single();

// 更新範本（擁有者用）
export const updateDocument = (id, data, name) =>
    sb.from('documents')
        .update({ data, ...(name !== undefined && { name }) })
        .eq('id', id)
        .select()
        .single();

// 重新命名範本
export const renameDocument = (id, name) =>
    sb.from('documents').update({ name }).eq('id', id).select().single();

// 刪除範本
export const deleteDocument = (id) =>
    sb.from('documents').delete().eq('id', id);

// ── Token-based RPC（分享連結使用）───────────────────────────

// 用 token 讀取 document（edit token 或 read token 均可）
// 回傳 { data: { ...document, token_type: 'edit'|'read' }, error }
export const getDocumentByToken = (token) =>
    sb.rpc('get_document_by_token', { p_token: token }).single();

// 用 edit token 更新 document（共同編輯者使用）
export const updateByEditToken = (token, data, name) =>
    sb.rpc('update_document_by_edit_token', {
        p_token: token,
        p_data:  data,
        ...(name !== undefined && { p_name: name }),
    });

// ── Share URL helpers ─────────────────────────────────────────

export const buildEditUrl  = (editToken) =>
    `${window.location.origin}${window.location.pathname}?edit=${editToken}`;

export const buildReadUrl  = (readToken) =>
    `${window.location.origin}${window.location.pathname}?view=${readToken}`;

// ── Realtime Broadcast ────────────────────────────────────────

// 訂閱文件頻道，當其他編輯者儲存後會收到 doc_updated 事件
// 回傳 channel，呼叫 channel.unsubscribe() 取消訂閱
export const subscribeDocChannel = (docId, onUpdate) => {
    const channel = sb.channel(`doc:${docId}`)
        .on('broadcast', { event: 'doc_updated' }, ({ payload }) => onUpdate(payload))
        .subscribe();
    return channel;
};
