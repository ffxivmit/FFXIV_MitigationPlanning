const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LEN = 7;
const TTL_SECONDS = 60 * 60 * 24 * 180; // 180 天
const MAX_BODY = 200_000; // 200 KB

function generateId() {
    const arr = new Uint8Array(ID_LEN);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => CHARSET[b % CHARSET.length]).join('');
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}

function text(body, status = 200) {
    return new Response(body, { status, headers: CORS });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        // POST /save — 儲存設定，回傳短 ID
        if (request.method === 'POST' && url.pathname === '/save') {
            const body = await request.text();
            if (body.length > MAX_BODY) return text('Payload too large', 413);

            // 驗證是合法 JSON（避免儲存垃圾資料）
            try { JSON.parse(body); } catch { return text('Invalid JSON', 400); }

            for (let i = 0; i < 5; i++) {
                const id = generateId();
                if (!(await env.PLANS.get(id))) {
                    await env.PLANS.put(id, body, { expirationTtl: TTL_SECONDS });
                    return json({ id });
                }
            }
            return text('ID generation failed', 500);
        }

        // GET /load/:id — 讀取設定
        if (request.method === 'GET' && url.pathname.startsWith('/load/')) {
            const id = url.pathname.slice(6);
            if (!/^[A-Za-z0-9]{4,12}$/.test(id)) return text('Invalid ID', 400);

            const data = await env.PLANS.get(id);
            if (!data) return text('Not found', 404);

            return new Response(data, {
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }

        return text('Not found', 404);
    },
};
