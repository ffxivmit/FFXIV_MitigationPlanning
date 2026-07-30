// 計畫快照（plan snapshot）：純函式模組，統一「本機儲存 / 分享連結（含 legacy Worker 與
// Supabase token）/ 匯出匯入 JSON」共用的資料形狀，避免各呼叫端各自維護欄位清單、
// 各自忘記套用 legacy mitMap 格式轉換。
//
// 不處理「顯示偏好」（hideNonDmg / hideTargeted）——那兩個是純 client 端切換用的設定，
// 靠 URL 參數記憶，不屬於計畫快照的一部分，也不會存進本機、分享連結或匯出檔案。
//
// applyPlanSnapshot 同時接受兩種既有的欄位命名（本機 localStorage 用 selectedDutyKey/mitMap，
// 可攜式分享/匯出格式用 duty/mits），讓既有使用者的舊資料能正常還原。

// 舊版資料格式 mitMap 的 key 為 "dutyKey-rowIdx-skillInstId"，值為 true；
// 新版格式 key 為 "dutyKey-skillInstId"，值為施放列索引陣列。
// 此函式負責自動將舊格式轉換為新格式，確保向後相容。
export function migrateLegacyMitMap(rawMit) {
    const newMit = {};
    for (const [key, val] of Object.entries(rawMit || {})) {
        if (Array.isArray(val)) {
            newMit[key] = val;
        } else if (val === true) {
            const match = key.match(/^(.+)-(\d+)-(p\d+-.+)$/);
            if (match) {
                const [, dutyKey, rowIdxStr, skillInstId] = match;
                const newKey = `${dutyKey}-${skillInstId}`;
                const rowIdx = parseInt(rowIdxStr);
                if (!newMit[newKey]) newMit[newKey] = [];
                if (!newMit[newKey].includes(rowIdx)) newMit[newKey].push(rowIdx);
            }
        }
    }
    for (const arr of Object.values(newMit)) {
        if (Array.isArray(arr)) arr.sort((a, b) => a - b);
    }
    return newMit;
}

export function serializePlanSnapshot(state) {
    return {
        duty: state.duty ?? '',
        party: state.party ?? [],
        mits: state.mitMap ?? {},
        notes: state.notesMap ?? {},
        selectedVariants: state.selectedVariants ?? {},
        customRowsByDuty: state.customRowsByDuty ?? {},
        skillStateMap: state.skillStateMap ?? {},
    };
}

export function applyPlanSnapshot(json) {
    const data = json || {};
    return {
        duty: data.duty ?? data.selectedDutyKey ?? '',
        party: data.party || [],
        mitMap: migrateLegacyMitMap(data.mits ?? data.mitMap ?? {}),
        notesMap: data.notes || {},
        selectedVariants: data.selectedVariants || {},
        customRowsByDuty: data.customRowsByDuty || {},
        skillStateMap: data.skillStateMap || {},
    };
}
