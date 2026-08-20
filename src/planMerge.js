// 三向合併（three-way merge）：純函式模組，共同編輯儲存衝突時使用。
// 把 base（上次讀取的快照）／dbData（伺服器目前版本）／local（本機未儲存版本）
// 三份計畫快照（見 src/planSnapshot.js）比對，自動合併不衝突的欄位、標記真正衝突的欄位，
// 使用者在衝突對話框做出選擇後，交給 applyConflictChoices 套用最終結果。
//
// ── 座標系：這個模組最容易出錯的地方 ───────────────────────────
// mitMap／skillStateMap 的 key 內嵌 "p{成員index}"，mitMap 的值與 notesMap 的 key 尾段則是
// 「施放列索引（internalIdx）」。前者相依於該份快照自己的 party 順序，後者相依於自己的
// customRowsByDuty 順序（自訂列一律接在副本原始時間軸之後）。三份快照各自內部都是一致的，
// 但彼此可能處在不同座標系——直接拿三邊的 key 逐一比對，等於把不同單位的數字相加。
//
// 因此一律先決定合併後的 party／自訂列順序，把三份快照全部換算（rebase）到那套座標系，
// 才做逐 key 的三向比對。少了這一步，「一人重排隊伍、另一人同時新增施放紀錄」會讓後者的
// 紀錄無聲地掛到錯的成員身上（該技能在新職業上不存在 → 渲染時整筆消失），而且因為逐 key
// 比對看不出任何差異，連衝突提示都不會跳。
//
// 換算沿用 src/castRecordReindex.js——main.js 本機拖曳排序／刪除成員／刪除自訂列時用的是
// 同一套邏輯，合併路徑共用同一份實作，避免兩邊各自演化出不一致的行為。
//
// 不處理顯示格式——把 conflicts 轉成中文標籤給 modal 顯示的邏輯（_enrichConflicts）
// 留在 main.js，跟 mitigationLedger.js「不處理 tooltip 字串」是同一個原則。

import {
    buildPartyRealignMapping,
    reindexCastRecordsByMember,
    remapCastRecordRows,
} from './castRecordReindex.js';

// timeToSeconds 的自包含小複製版：只給 customRowsByDuty 合併後排序用。
// 跟 main.js 共用的那份是同一份邏輯，但 main.js 不是可 import 的模組，只能重複一份。
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

const _partyEq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

// 把一份快照的施放紀錄（mits／notes／skillStateMap）換算到目標座標系。
// 回傳物件保留原快照的 party／customRowsByDuty 欄位不動——衝突對話框要靠它們顯示
// 「我的版本 vs 他人版本」的隊伍配置與自訂列內容，換掉就沒得比了。
//
// dutyRowCounts：{ [dutyKey]: 該副本原始時間軸列數 }。要判斷一個索引屬於原始列還是自訂列，
// 必須知道自訂列從第幾號開始，而這個數字不在計畫快照裡，只能由呼叫端（main.js）提供。
function _rebaseCastRecords(snapshot, { party: targetParty, customRowsByDuty: targetRowsByDuty, dutyRowCounts }) {
    let mitMap = snapshot.mits || {};
    let notesMap = snapshot.notes || {};
    let skillStateMap = snapshot.skillStateMap || {};

    // ── 成員軸 ────────────────────────────────────────────────
    const memberMap = buildPartyRealignMapping(snapshot.party || [], targetParty);
    if (memberMap.some((to, from) => to !== from)) {
        ({ mitMap, skillStateMap, notesMap } =
            reindexCastRecordsByMember({ mitMap, skillStateMap, notesMap }, memberMap));
    }

    // ── 列軸 ──────────────────────────────────────────────────
    for (const [duty, srcRows] of Object.entries(snapshot.customRowsByDuty || {})) {
        // 這份快照在該副本沒有自訂列 → 不可能有任何索引落在自訂列區段，不必換算
        if (!srcRows?.length) continue;
        const tgtRows = targetRowsByDuty[duty] || [];
        const sameOrder = srcRows.length === tgtRows.length
            && srcRows.every((r, i) => r.id === tgtRows[i].id);
        if (sameOrder) continue;

        const dutyLen = dutyRowCounts[duty];
        // 不知道原始時間軸長度就無法分辨哪些索引屬於自訂列，只能原樣保留。
        // main.js 會在合併前先把相關副本載入（見 buildDutyRowCounts），正常情況不會走到這裡；
        // 只有「副本 JSON 讀取失敗」這種情況才會落到這個保守分支。
        if (typeof dutyLen !== 'number') continue;

        const rowIndexMap = {};
        srcRows.forEach((row, pos) => {
            const newPos = tgtRows.findIndex(t => t.id === row.id);
            rowIndexMap[dutyLen + pos] = newPos < 0 ? -1 : dutyLen + newPos;
        });
        ({ mitMap, notesMap } = remapCastRecordRows(
            { mitMap, notesMap }, { dutyPrefix: duty + '-', rowIndexMap }));
    }

    return { ...snapshot, mits: mitMap, notes: notesMap, skillStateMap };
}

// 回傳 { merged, conflicts, rebased }。
// rebased 是三份換算到合併座標系後的快照——conflicts 裡的 key 也是這套座標系，
// 呼叫端要拿 rebased.local／rebased.db 去查對應的值（拿原始快照會對不到 key）。
export function mergePayloads(base, dbData, local, { dutyRowCounts = {} } = {}) {
    const conflicts = [];
    const merged = {};

    merged.duty = local.duty || dbData.duty || base.duty;

    // ── party ─────────────────────────────────────────────────
    // 先決定最終隊伍順序：施放紀錄的座標系相依於它，必須在 rebase 之前定案。
    const bp = base.party || [];
    const dp = dbData.party || [];
    const lp = local.party || [];
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
    // 同樣要在 rebase 之前定案：施放列索引相依於自訂列的排列順序。
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

    // ── 把三份快照換算到合併後的座標系 ─────────────────────────
    const target = { party: merged.party, customRowsByDuty: mergedCR, dutyRowCounts };
    const rebasedBase = _rebaseCastRecords(base, target);
    const rebasedDb = _rebaseCastRecords(dbData, target);
    const rebasedLocal = _rebaseCastRecords(local, target);

    // ── mitMap ────────────────────────────────────────────────
    const bm = rebasedBase.mits;
    const dm = rebasedDb.mits;
    const lm = rebasedLocal.mits;
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
    // key 為 "{副本}-{列索引}"，但只有副本原始列（isRandom）才有變體可選，
    // 而原始列一律排在自訂列之前、索引不受自訂列增刪影響，所以不需要 rebase。
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
    // 三向合併：key 為 "{副本}-p{成員index}-{skillId}-{列索引}"
    // 同一 key 兩人都修改 → 保留 local（備註為個人操作，不開衝突提示）
    {
        const bn = rebasedBase.notes;
        const dn = rebasedDb.notes;
        const ln = rebasedLocal.notes;
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
    merged.skillStateMap = rebasedLocal.skillStateMap;

    return { merged, conflicts, rebased: { base: rebasedBase, db: rebasedDb, local: rebasedLocal } };
}

// 衝突對話框裡，使用者對每個衝突欄位選擇 'local' 或 'db' 之後，
// 把選擇套用到 autoMerged 上、產生最終要送出的 payload。
// enriched：mergePayloads 回傳的 conflicts 陣列，每筆額外帶一個 choice（'local' | 'db'）欄位
//（choice 之外的顯示用欄位如 label/dbDisplay/localDisplay 由 main.js 的 _enrichConflicts 附加，這裡不讀）。
// localData 必須是 mergePayloads 回傳的 rebased.local——conflicts 的 key 是合併座標系，
// 拿原始的 local 會查不到對應的值。
// 不 mutate 任何輸入，回傳全新物件。
export function applyConflictChoices(autoMerged, enriched, localData, { dutyRowCounts = {} } = {}) {
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

    // 使用者的選擇可能改動隊伍順序（party 選了本機版本）或自訂列的組成（customRow 選了本機版本），
    // 但此時 final 的施放紀錄仍停留在 autoMerged 的座標系，必須一併換算到最終座標系，
    // 否則會重演 mergePayloads 少了 rebase 時的同一個問題：紀錄掛到錯的成員／錯的列。
    const rebased = _rebaseCastRecords(
        { ...final, party: autoMerged.party, customRowsByDuty: autoMerged.customRowsByDuty },
        { party: final.party || [], customRowsByDuty: final.customRowsByDuty || {}, dutyRowCounts }
    );
    final.mits = rebased.mits;
    final.notes = rebased.notes;
    final.skillStateMap = rebased.skillStateMap;

    return final;
}
