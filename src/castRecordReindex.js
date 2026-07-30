// 施放紀錄重新索引（cast record reindex）：純函式模組，統一「隊伍成員增刪/重排」與
// 「自訂列刪除」這兩類會讓 mitMap/skillStateMap/notesMap 的既有 key 或值失去對應關係
// 的重映射邏輯，避免各呼叫端各自重寫一份、也各自忘記涵蓋某個 map。
//
// 兩種軸線：
// - member 軸：mitMap/skillStateMap/notesMap 的 key 都內嵌 "-p{成員index}-"，
//   成員增刪/拖曳重排時，這個 index 片段要跟著改寫或整組資料一起丟棄。
// - row 軸：mitMap 的值是「施放列索引（internalIdx）」陣列，notesMap 的 key 內嵌
//   "-{列索引}" 尾段；自訂列被刪除時，這兩處都要把大於被刪列索引的值往前遞補一位。
//   （skillStateMap 的 key 不含列索引，row 軸不需要處理它。）

// 依 oldToNew 陣列重寫單一 map 的 key："-p{n}-" 片段改寫成新索引；
// oldToNew[n] === -1 代表該成員的資料應丟棄。
function reindexKeysByMember(map, oldToNew) {
    const out = {};
    for (const [key, val] of Object.entries(map)) {
        const m = key.match(/-p(\d+)-/);
        if (!m) {
            out[key] = val;
            continue;
        }
        const ni = oldToNew[parseInt(m[1], 10)];
        if (ni === undefined || ni === -1) continue;
        out[key.replace(/-p(\d+)-/, `-p${ni}-`)] = val;
    }
    return out;
}

// 依 oldToNew 陣列同步重寫 mitMap/skillStateMap/notesMap 三者的成員索引片段。
export function reindexCastRecordsByMember({ mitMap, skillStateMap, notesMap }, oldToNew) {
    return {
        mitMap: reindexKeysByMember(mitMap, oldToNew),
        skillStateMap: reindexKeysByMember(skillStateMap, oldToNew),
        notesMap: reindexKeysByMember(notesMap, oldToNew),
    };
}

// 成員被移除時的 oldToNew：removedIndex 丟棄，其後全部往前一格。
export function buildMemberRemovalMapping(partyLength, removedIndex) {
    const oldToNew = Array.from({ length: partyLength }, (_, i) => i);
    oldToNew[removedIndex] = -1;
    for (let i = removedIndex + 1; i < partyLength; i++) oldToNew[i] = i - 1;
    return oldToNew;
}

// 成員拖曳重排（fromIdx 移到 toIdx）時的 oldToNew：中間的成員依方向平移一格。
export function buildMemberSwapMapping(partyLength, fromIdx, toIdx) {
    const oldToNew = Array.from({ length: partyLength }, (_, i) => i);
    if (fromIdx < toIdx) {
        oldToNew[fromIdx] = toIdx;
        for (let i = fromIdx + 1; i <= toIdx; i++) oldToNew[i] = i - 1;
    } else {
        oldToNew[fromIdx] = toIdx;
        for (let i = toIdx; i < fromIdx; i++) oldToNew[i] = i + 1;
    }
    return oldToNew;
}

// 自訂列被移除時，重寫 mitMap 的施放列索引陣列，以及 notesMap key 尾段內嵌的列索引；
// 只處理屬於 dutyPrefix（例如 "m5s-"）這個副本的 key，其他副本的資料原樣保留。
export function reindexCastRecordsByRemovedRow({ mitMap, notesMap }, { dutyPrefix, removedRowIdx }) {
    const newMitMap = { ...mitMap };
    for (const [key, castRows] of Object.entries(mitMap)) {
        if (!key.startsWith(dutyPrefix)) continue;
        const updated = castRows
            .filter(i => i !== removedRowIdx)
            .map(i => i > removedRowIdx ? i - 1 : i);
        if (updated.length) {
            newMitMap[key] = updated;
        } else {
            delete newMitMap[key];
        }
    }

    const newNotesMap = { ...notesMap };
    for (const [key, note] of Object.entries(notesMap)) {
        if (!key.startsWith(dutyPrefix)) continue;
        const m = key.match(/^(.*)-(\d+)$/);
        if (!m) continue;
        const rowIdx = parseInt(m[2], 10);
        if (rowIdx === removedRowIdx) {
            delete newNotesMap[key];
            continue;
        }
        if (rowIdx > removedRowIdx) {
            delete newNotesMap[key];
            newNotesMap[`${m[1]}-${rowIdx - 1}`] = note;
        }
    }

    return { mitMap: newMitMap, notesMap: newNotesMap };
}
