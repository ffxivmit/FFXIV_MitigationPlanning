// 三向合併（three-way merge）：純函式模組，共同編輯儲存衝突時使用。
// 把 base（上次讀取的快照）／dbData（伺服器目前版本）／local（本機未儲存版本）
// 三份計畫快照（見 src/planSnapshot.js）比對，自動合併不衝突的欄位、標記真正衝突的欄位，
// 使用者在衝突對話框做出選擇後，交給 applyConflictChoices 套用最終結果。
//
// 不處理顯示格式——把 conflicts 轉成中文標籤給 modal 顯示的邏輯（_enrichConflicts）
// 留在 main.js，跟 mitigationLedger.js「不處理 tooltip 字串」是同一個原則。

// timeToSeconds 的自包含小複製版：只給 customRowsByDuty 合併後排序用，
// 跟 main.js 共用的那份是同一份邏輯，但為了讓本模組不依賴 main.js／其他 src 模組而重複一份。
const timeToSeconds = (t) => {
    if (!t) return 0;
    const str = String(t).trim();
    const isNegative = str.startsWith('-');
    const cleanStr = isNegative ? str.slice(1) : str;
    const parts = cleanStr.split(':').map(Number);
    const totalSeconds = (parts[0] || 0) * 60 + (parts[1] || 0);
    return isNegative ? -totalSeconds : totalSeconds;
};

// 比較兩個施放索引陣列是否相同（忽略順序）
const _arrEq = (a, b) => {
    if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
    const sa = [...(a || [])].sort((x, y) => x - y);
    const sb = [...(b || [])].sort((x, y) => x - y);
    return sa.every((v, i) => v === sb[i]);
};

export function mergePayloads(base, dbData, local) {
    const conflicts = [];
    const merged = {};

    merged.duty = local.duty || dbData.duty || base.duty;

    // ── mitMap ────────────────────────────────────────────────
    const bm = base.mits || {};
    const dm = dbData.mits || {};
    const lm = local.mits || {};
    const allMitKeys = new Set([...Object.keys(bm), ...Object.keys(dm), ...Object.keys(lm)]);
    const mergedMits = {};

    for (const key of allMitKeys) {
        const bv = bm[key] || [];
        const dv = dm[key] || [];
        const lv = lm[key] || [];
        const lChg = !_arrEq(lv, bv);
        const dChg = !_arrEq(dv, bv);

        if (lChg && dChg && !_arrEq(lv, dv)) {
            conflicts.push({ type: 'skill', key });
            if (dv.length) mergedMits[key] = dv;       // 衝突：保留 DB（他人）版本
        } else if (lChg) {
            if (lv.length) mergedMits[key] = lv;        // 只有我改：用我的
        } else {
            if (dv.length) mergedMits[key] = dv;        // 只有他改或都沒改：用 DB
        }
    }
    merged.mits = mergedMits;

    // ── selectedVariants ──────────────────────────────────────
    const bsv = base.selectedVariants || {};
    const dsv = dbData.selectedVariants || {};
    const lsv = local.selectedVariants || {};
    const allSVKeys = new Set([...Object.keys(bsv), ...Object.keys(dsv), ...Object.keys(lsv)]);
    const mergedSV = {};

    for (const key of allSVKeys) {
        const bv = bsv[key], dv = dsv[key], lv = lsv[key];
        const lChg = lv !== bv, dChg = dv !== bv;
        if (lChg && dChg && lv !== dv) {
            conflicts.push({ type: 'variant', key });
            if (dv !== undefined) mergedSV[key] = dv;
        } else if (lChg) {
            if (lv !== undefined) mergedSV[key] = lv;
        } else {
            if (dv !== undefined) mergedSV[key] = dv;
        }
    }
    merged.selectedVariants = mergedSV;

    // ── party ─────────────────────────────────────────────────
    const bp = base.party || [];
    const dp = dbData.party || [];
    const lp = local.party || [];
    const _partyEq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const lPartyChg = !_partyEq(lp, bp);
    const dPartyChg = !_partyEq(dp, bp);

    if (lPartyChg && dPartyChg && !_partyEq(lp, dp)) {
        conflicts.push({ type: 'party' });
        merged.party = dp;
    } else if (lPartyChg) {
        merged.party = lp;
    } else {
        merged.party = dp;
    }

    // ── customRowsByDuty ──────────────────────────────────────
    const bc = base.customRowsByDuty || {};
    const dc = dbData.customRowsByDuty || {};
    const lc = local.customRowsByDuty || {};
    const allDuties = new Set([...Object.keys(bc), ...Object.keys(dc), ...Object.keys(lc)]);
    const mergedCR = {};

    for (const duty of allDuties) {
        const bById = Object.fromEntries((bc[duty] || []).map(r => [r.id, r]));
        const dById = Object.fromEntries((dc[duty] || []).map(r => [r.id, r]));
        const lById = Object.fromEntries((lc[duty] || []).map(r => [r.id, r]));
        const allIds = new Set([...Object.keys(bById), ...Object.keys(dById), ...Object.keys(lById)]);
        const rows = [];

        for (const id of allIds) {
            const bSer = JSON.stringify(bById[id]);
            const dSer = JSON.stringify(dById[id]);
            const lSer = JSON.stringify(lById[id]);
            const lChg = lSer !== bSer, dChg = dSer !== bSer;

            if (lChg && dChg && lSer !== dSer) {
                conflicts.push({ type: 'customRow', duty, id });
                if (dById[id]) rows.push(dById[id]);
            } else if (lChg) {
                if (lById[id]) rows.push(lById[id]);
            } else {
                if (dById[id]) rows.push(dById[id]);
            }
        }

        if (rows.length > 0) {
            rows.sort((a, b) => timeToSeconds(a.hitTime) - timeToSeconds(b.hitTime));
            mergedCR[duty] = rows;
        }
    }
    merged.customRowsByDuty = mergedCR;

    // ── 顯示設定（boolean）────────────────────────────────────
    for (const field of ['hideNonDmg', 'hideTargeted']) {
        const bv = base[field], dv = dbData[field], lv = local[field];
        if (lv !== bv && dv !== bv && lv !== dv) {
            conflicts.push({ type: field });
            merged[field] = dv;
        } else if (lv !== bv) {
            merged[field] = lv;
        } else {
            merged[field] = dv !== undefined ? dv : bv;
        }
    }

    // ── notes ─────────────────────────────────────────────────
    // 三向合併：key 為 "p{idx}-{skillInstId}-{rowIdx}"
    // 同一 key 兩人都修改 → 保留 local（備註為個人操作，不開衝突提示）
    {
        const bn = base.notes || {};
        const dn = dbData.notes || {};
        const ln = local.notes || {};
        const allNoteKeys = new Set([...Object.keys(bn), ...Object.keys(dn), ...Object.keys(ln)]);
        const mergedNotes = {};
        for (const key of allNoteKeys) {
            const bv = bn[key], dv = dn[key], lv = ln[key];
            const lChg = lv !== bv;
            if (lChg) {
                if (lv !== undefined && lv !== '') mergedNotes[key] = lv;
            } else {
                if (dv !== undefined && dv !== '') mergedNotes[key] = dv;
            }
        }
        merged.notes = mergedNotes;
    }

    // ── skillStateMap ─────────────────────────────────────────
    merged.skillStateMap = local.skillStateMap || {};

    return { merged, conflicts };
}

// 衝突對話框裡，使用者對每個衝突欄位選擇 'local' 或 'db' 之後，
// 把選擇套用到 autoMerged 上、產生最終要送出的 payload。
// enriched：mergePayloads 回傳的 conflicts 陣列，每筆額外帶一個 choice（'local' | 'db'）欄位
//（choice 之外的顯示用欄位如 label/dbDisplay/localDisplay 由 main.js 的 _enrichConflicts 附加，這裡不讀）。
// 不 mutate 任何輸入，回傳全新物件。
export function applyConflictChoices(autoMerged, enriched, localData) {
    const final = JSON.parse(JSON.stringify(autoMerged));

    for (const c of enriched) {
        if (c.choice !== 'local') continue;
        if (c.type === 'skill') {
            const lv = localData.mits?.[c.key] || [];
            if (lv.length) final.mits[c.key] = lv; else delete final.mits[c.key];
        } else if (c.type === 'party') {
            final.party = localData.party || [];
        } else if (c.type === 'variant') {
            const lv = localData.selectedVariants?.[c.key];
            if (lv !== undefined) final.selectedVariants[c.key] = lv;
            else delete final.selectedVariants[c.key];
        } else if (c.type === 'customRow') {
            const lr = (localData.customRowsByDuty?.[c.duty] || []).find(r => r.id === c.id);
            const rows = final.customRowsByDuty[c.duty] || [];
            const ei = rows.findIndex(r => r.id === c.id);
            if (lr) { if (ei >= 0) rows[ei] = lr; else rows.push(lr); }
            else if (ei >= 0) rows.splice(ei, 1);
            if (rows.length) final.customRowsByDuty[c.duty] = rows;
            else delete final.customRowsByDuty[c.duty];
        } else if (c.type === 'hideNonDmg')   { final.hideNonDmg   = localData.hideNonDmg; }
          else if (c.type === 'hideTargeted') { final.hideTargeted = localData.hideTargeted; }
    }

    return final;
}
