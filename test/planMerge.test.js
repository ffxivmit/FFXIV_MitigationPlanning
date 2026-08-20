import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergePayloads, applyConflictChoices } from '../src/planMerge.js';

const emptyPlan = () => ({
    duty: 'm5s',
    mits: {},
    selectedVariants: {},
    party: ['PLD', 'WHM'],
    customRowsByDuty: {},
    hideNonDmg: false,
    hideTargeted: false,
    notes: {},
    skillStateMap: {},
});

describe('mergePayloads — mits（技能施放紀錄）', () => {
    it('雙方都沒改：保留 DB 版本，不算衝突', () => {
        const base = emptyPlan();
        base.mits = { 'm5s-p0-pld_grd': [0, 1] };
        const dbData = emptyPlan();
        dbData.mits = { 'm5s-p0-pld_grd': [0, 1] };
        const local = emptyPlan();
        local.mits = { 'm5s-p0-pld_grd': [0, 1] };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.mits, { 'm5s-p0-pld_grd': [0, 1] });
        assert.deepEqual(conflicts, []);
    });

    it('只有本機改：採用本機版本', () => {
        const base = emptyPlan();
        base.mits = { 'm5s-p0-pld_grd': [0] };
        const dbData = emptyPlan();
        dbData.mits = { 'm5s-p0-pld_grd': [0] };
        const local = emptyPlan();
        local.mits = { 'm5s-p0-pld_grd': [0, 1] };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.mits, { 'm5s-p0-pld_grd': [0, 1] });
        assert.deepEqual(conflicts, []);
    });

    it('只有他人改：採用 DB 版本', () => {
        const base = emptyPlan();
        base.mits = { 'm5s-p0-pld_grd': [0] };
        const dbData = emptyPlan();
        dbData.mits = { 'm5s-p0-pld_grd': [0, 1] };
        const local = emptyPlan();
        local.mits = { 'm5s-p0-pld_grd': [0] };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.mits, { 'm5s-p0-pld_grd': [0, 1] });
        assert.deepEqual(conflicts, []);
    });

    it('雙方都改、結果不同：標記衝突，自動合併結果採 DB 版本', () => {
        const base = emptyPlan();
        base.mits = { 'm5s-p0-pld_grd': [0] };
        const dbData = emptyPlan();
        dbData.mits = { 'm5s-p0-pld_grd': [0, 2] };
        const local = emptyPlan();
        local.mits = { 'm5s-p0-pld_grd': [0, 1] };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.mits, { 'm5s-p0-pld_grd': [0, 2] });
        assert.deepEqual(conflicts, [{ type: 'skill', key: 'm5s-p0-pld_grd' }]);
    });

    it('雙方都改成同一個結果：不算衝突', () => {
        const base = emptyPlan();
        base.mits = { 'm5s-p0-pld_grd': [0] };
        const dbData = emptyPlan();
        dbData.mits = { 'm5s-p0-pld_grd': [0, 1] };
        const local = emptyPlan();
        local.mits = { 'm5s-p0-pld_grd': [0, 1] };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.mits, { 'm5s-p0-pld_grd': [0, 1] });
        assert.deepEqual(conflicts, []);
    });
});

describe('mergePayloads — party（職業配置）', () => {
    it('雙方都改且不同：標記衝突，採 DB 版本', () => {
        const base = emptyPlan();
        base.party = ['PLD', 'WHM'];
        const dbData = emptyPlan();
        dbData.party = ['WAR', 'WHM'];
        const local = emptyPlan();
        local.party = ['GNB', 'WHM'];

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.party, ['WAR', 'WHM']);
        assert.deepEqual(conflicts, [{ type: 'party' }]);
    });
});

describe('mergePayloads — customRowsByDuty（自訂時間點）', () => {
    it('同一 id 雙方各自修改成不同內容：標記衝突，採 DB 版本，其餘依施放時間排序', () => {
        const base = emptyPlan();
        base.customRowsByDuty = { m5s: [{ id: 'cr1', hitTime: '1:00', skill: '舊招' }] };
        const dbData = emptyPlan();
        dbData.customRowsByDuty = {
            m5s: [
                { id: 'cr1', hitTime: '1:00', skill: 'DB改的招' },
                { id: 'cr2', hitTime: '0:30', skill: '新列' },
            ],
        };
        const local = emptyPlan();
        local.customRowsByDuty = { m5s: [{ id: 'cr1', hitTime: '1:00', skill: '本機改的招' }] };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(conflicts, [{ type: 'customRow', duty: 'm5s', id: 'cr1' }]);
        // 依 hitTime 排序：0:30 在 1:00 前面
        assert.deepEqual(merged.customRowsByDuty.m5s.map(r => r.id), ['cr2', 'cr1']);
        assert.equal(merged.customRowsByDuty.m5s.find(r => r.id === 'cr1').skill, 'DB改的招');
    });
});

describe('mergePayloads — hideNonDmg/hideTargeted（顯示設定）', () => {
    it('base/db/local 三方兩兩不同：標記衝突，採 DB 版本', () => {
        const base = emptyPlan();
        base.hideNonDmg = undefined;
        const dbData = emptyPlan();
        dbData.hideNonDmg = true;
        const local = emptyPlan();
        local.hideNonDmg = false;

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.equal(merged.hideNonDmg, true);
        assert.deepEqual(conflicts, [{ type: 'hideNonDmg' }]);
    });
});

describe('mergePayloads — notes（備註，三向合併但衝突不提示）', () => {
    it('同一 key 雙方都改：保留 local，不算衝突', () => {
        const base = emptyPlan();
        base.notes = { 'm5s-p0-pld_grd-0': '舊備註' };
        const dbData = emptyPlan();
        dbData.notes = { 'm5s-p0-pld_grd-0': 'DB備註' };
        const local = emptyPlan();
        local.notes = { 'm5s-p0-pld_grd-0': '本機備註' };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.notes, { 'm5s-p0-pld_grd-0': '本機備註' });
        assert.deepEqual(conflicts, []);
    });
});

describe('mergePayloads — skillStateMap', () => {
    // 坦培拉塗層（pct_tpc）是繪靈法師的技能，是目前唯一會用到 skillStateMap 的 multiState 技能
    it('一律採用 local，不比對、不參與衝突判斷', () => {
        const base = { ...emptyPlan(), party: ['PCT', 'WHM'] };
        const dbData = { ...emptyPlan(), party: ['PCT', 'WHM'], skillStateMap: { 'm5s-p0-pct_tpc': 1 } };
        const local = { ...emptyPlan(), party: ['PCT', 'WHM'], skillStateMap: { 'm5s-p0-pct_tpc': 0 } };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.skillStateMap, { 'm5s-p0-pct_tpc': 0 });
        assert.deepEqual(conflicts, []);
    });
});

// mitMap/notesMap 的 key 內嵌 p{成員index}、值是施放列索引，兩者都相依於各自快照的
// party 與 customRowsByDuty 順序。三份快照處在不同座標系時若直接逐 key 比對，
// 施放紀錄會無聲地掛到錯的成員／錯的列上（見 src/planMerge.js 開頭的「座標系」說明）。
describe('mergePayloads — 座標系換算（party 順序）', () => {
    it('一人重排隊伍、另一人同時新增施放：紀錄跟著正確的成員走，且不算衝突', () => {
        const base = { ...emptyPlan(), party: ['PLD', 'WHM'], mits: { 'm5s-p0-pld_grd': [0] } };
        // 本機把隊伍換成 [WHM, PLD]，並已在本機同步重新索引（PLD 從 p0 移到 p1）
        const local = { ...emptyPlan(), party: ['WHM', 'PLD'], mits: { 'm5s-p1-pld_grd': [0] } };
        // 他人沒動隊伍，只幫 WHM（在他那份順序裡是 p1）新增了一次施放
        const dbData = {
            ...emptyPlan(), party: ['PLD', 'WHM'],
            mits: { 'm5s-p0-pld_grd': [0], 'm5s-p1-whm_tmp': [2] },
        };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.party, ['WHM', 'PLD']);
        // p0 是 WHM 拿 whm_tmp、p1 是 PLD 拿 pld_grd
        assert.deepEqual(merged.mits, { 'm5s-p1-pld_grd': [0], 'm5s-p0-whm_tmp': [2] });
        assert.deepEqual(conflicts, []);
    });

    it('重複職業互相對調（party 陣列內容不變）：對調結果與他人的新增都保留', () => {
        const base = {
            ...emptyPlan(), party: ['PLD', 'PLD', 'WHM'],
            mits: { 'm5s-p0-pld_grd': [5], 'm5s-p1-pld_hs': [7] },
        };
        // 兩名騎士互換位置：party 字串陣列一模一樣，差異只表現在施放紀錄上
        const local = {
            ...emptyPlan(), party: ['PLD', 'PLD', 'WHM'],
            mits: { 'm5s-p1-pld_grd': [5], 'm5s-p0-pld_hs': [7] },
        };
        const dbData = {
            ...emptyPlan(), party: ['PLD', 'PLD', 'WHM'],
            mits: { 'm5s-p0-pld_grd': [5], 'm5s-p1-pld_hs': [7], 'm5s-p2-whm_tmp': [3] },
        };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.mits, {
            'm5s-p1-pld_grd': [5], 'm5s-p0-pld_hs': [7], 'm5s-p2-whm_tmp': [3],
        });
        assert.deepEqual(conflicts, []);
    });

    it('重複職業＋真的有位移：同職業依序配對，紀錄跟著平移', () => {
        const base = {
            ...emptyPlan(), party: ['PLD', 'PLD', 'PLD', 'WHM'],
            mits: { 'm5s-p0-pld_grd': [5], 'm5s-p3-whm_tmp': [3] },
        };
        // WHM 被拖到最前面，三名騎士整體往後平移一格
        const local = {
            ...emptyPlan(), party: ['WHM', 'PLD', 'PLD', 'PLD'],
            mits: { 'm5s-p1-pld_grd': [5], 'm5s-p0-whm_tmp': [3] },
        };
        // 他人沒動隊伍，幫第三名騎士（他那份順序的 p2）新增施放
        const dbData = {
            ...emptyPlan(), party: ['PLD', 'PLD', 'PLD', 'WHM'],
            mits: { 'm5s-p0-pld_grd': [5], 'm5s-p3-whm_tmp': [3], 'm5s-p2-pld_hs': [7] },
        };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        // 原 p2 的騎士在新順序是 p3
        assert.deepEqual(merged.mits, {
            'm5s-p1-pld_grd': [5], 'm5s-p0-whm_tmp': [3], 'm5s-p3-pld_hs': [7],
        });
        assert.deepEqual(conflicts, []);
    });

    it('本機移除了某成員：他人在該成員身上的新增一併丟棄，不會錯位到別人身上', () => {
        const base = { ...emptyPlan(), party: ['PLD', 'WHM', 'SCH'], mits: {} };
        const local = { ...emptyPlan(), party: ['PLD', 'WHM'], mits: {} };
        const dbData = { ...emptyPlan(), party: ['PLD', 'WHM', 'SCH'], mits: { 'm5s-p2-sch_adl': [4] } };

        const { merged } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.party, ['PLD', 'WHM']);
        assert.deepEqual(merged.mits, {});
    });

    it('備註的成員索引也一起換算：他人在另一名成員身上新增的備註不會掛錯人', () => {
        const base = { ...emptyPlan(), party: ['PLD', 'WHM'], notes: { 'm5s-p0-pld_grd-3': '記得開' } };
        // 本機把隊伍換成 [WHM, PLD]，備註已在本機同步重新索引
        const local = { ...emptyPlan(), party: ['WHM', 'PLD'], notes: { 'm5s-p1-pld_grd-3': '記得開' } };
        // 他人沒動隊伍，在 WHM（他那份順序裡是 p1）身上新增一筆備註
        const dbData = {
            ...emptyPlan(), party: ['PLD', 'WHM'],
            notes: { 'm5s-p0-pld_grd-3': '記得開', 'm5s-p1-whm_tmp-4': '這裡補節制' },
        };

        const { merged } = mergePayloads(base, dbData, local);
        // 少了換算的話，他人那筆會留在 p1——但合併後的 p1 是騎士，
        // 白魔的節制備註就掛到錯的成員身上了
        assert.deepEqual(merged.notes, {
            'm5s-p1-pld_grd-3': '記得開',
            'm5s-p0-whm_tmp-4': '這裡補節制',
        });
    });
});

describe('mergePayloads — 座標系換算（自訂列的施放列索引）', () => {
    // 副本原始時間軸 5 列（索引 0-4），自訂列從索引 5 開始
    const DUTY_ROW_COUNTS = { m5s: 5 };

    it('兩人各自新增自訂列導致排序位移：施放紀錄跟著原本那一列走', () => {
        const base = emptyPlan();
        // 本機在 0:10 新增 crA（本機索引 5）並在該列點了技能
        const local = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crA', hitTime: '0:10', skill: 'A' }] },
            mits: { 'm5s-p0-pld_grd': [5] },
        };
        // 他人同時在更早的 0:05 新增 crB，合併後 crB 會排在 crA 前面
        const dbData = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crB', hitTime: '0:05', skill: 'B' }] },
        };

        const { merged, conflicts } = mergePayloads(base, dbData, local, { dutyRowCounts: DUTY_ROW_COUNTS });
        assert.deepEqual(merged.customRowsByDuty.m5s.map(r => r.id), ['crB', 'crA']);
        // crA 從第 0 個自訂列變成第 1 個 → 索引 5 應改寫成 6
        assert.deepEqual(merged.mits, { 'm5s-p0-pld_grd': [6] });
        assert.deepEqual(conflicts, []);
    });

    it('備註 key 尾段的列索引同樣跟著換算', () => {
        const base = emptyPlan();
        const local = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crA', hitTime: '0:10', skill: 'A' }] },
            notes: { 'm5s-p0-pld_grd-5': '這裡要補' },
        };
        const dbData = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crB', hitTime: '0:05', skill: 'B' }] },
        };

        const { merged } = mergePayloads(base, dbData, local, { dutyRowCounts: DUTY_ROW_COUNTS });
        assert.deepEqual(merged.notes, { 'm5s-p0-pld_grd-6': '這裡要補' });
    });

    it('自訂列被他人刪除：落在該列的施放紀錄一併移除，不會殘留成錯誤索引', () => {
        const base = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crA', hitTime: '0:10', skill: 'A' }] },
        };
        const local = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crA', hitTime: '0:10', skill: 'A' }] },
            mits: { 'm5s-p0-pld_grd': [5] },
        };
        const dbData = { ...emptyPlan(), customRowsByDuty: {} };

        const { merged } = mergePayloads(base, dbData, local, { dutyRowCounts: DUTY_ROW_COUNTS });
        assert.deepEqual(merged.customRowsByDuty, {});
        assert.deepEqual(merged.mits, {});
    });

    it('副本原始列的索引不受自訂列增刪影響', () => {
        const base = emptyPlan();
        const local = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crA', hitTime: '0:10', skill: 'A' }] },
            mits: { 'm5s-p0-pld_grd': [2] },   // 索引 2 < 5，屬於副本原始時間軸
        };
        const dbData = {
            ...emptyPlan(),
            customRowsByDuty: { m5s: [{ id: 'crB', hitTime: '0:05', skill: 'B' }] },
        };

        const { merged } = mergePayloads(base, dbData, local, { dutyRowCounts: DUTY_ROW_COUNTS });
        assert.deepEqual(merged.mits, { 'm5s-p0-pld_grd': [2] });
    });
});

describe('applyConflictChoices', () => {
    it('choice 為 db（預設）：保持 autoMerged 的值不變', () => {
        const autoMerged = { mits: { 'm5s-p0-pld_grd': [0, 2] }, selectedVariants: {}, customRowsByDuty: {} };
        const enriched = [{ type: 'skill', key: 'm5s-p0-pld_grd', choice: 'db' }];
        const localData = { mits: { 'm5s-p0-pld_grd': [0, 1] } };

        const final = applyConflictChoices(autoMerged, enriched, localData);
        assert.deepEqual(final.mits, { 'm5s-p0-pld_grd': [0, 2] });
    });

    it('choice 為 local：改用 localData 的技能施放紀錄，空陣列時整個 key 刪除', () => {
        const autoMerged = { mits: { 'm5s-p0-pld_grd': [0, 2] }, selectedVariants: {}, customRowsByDuty: {} };
        const enriched = [{ type: 'skill', key: 'm5s-p0-pld_grd', choice: 'local' }];
        const localData = { mits: { 'm5s-p0-pld_grd': [] } };

        const final = applyConflictChoices(autoMerged, enriched, localData);
        assert.equal('m5s-p0-pld_grd' in final.mits, false);
    });

    it('choice 為 local 的 party 衝突：整組職業配置改用 local', () => {
        const autoMerged = { mits: {}, selectedVariants: {}, customRowsByDuty: {}, party: ['WAR', 'WHM'] };
        const enriched = [{ type: 'party', choice: 'local' }];
        const localData = { party: ['GNB', 'WHM'] };

        const final = applyConflictChoices(autoMerged, enriched, localData);
        assert.deepEqual(final.party, ['GNB', 'WHM']);
    });

    it('party 改選本機版本：施放紀錄一併換算回本機的隊伍座標系', () => {
        // autoMerged 採用了他人的隊伍順序，紀錄也在那套座標系
        const autoMerged = {
            party: ['WAR', 'WHM'], selectedVariants: {}, customRowsByDuty: {}, notes: {}, skillStateMap: {},
            mits: { 'm5s-p0-war_sio': [0], 'm5s-p1-whm_tmp': [1] },
        };
        const enriched = [{ type: 'party', choice: 'local' }];
        const localData = { party: ['WHM', 'WAR'], mits: {}, customRowsByDuty: {}, notes: {}, skillStateMap: {} };

        const final = applyConflictChoices(autoMerged, enriched, localData);
        assert.deepEqual(final.party, ['WHM', 'WAR']);
        // WAR 從 p0 移到 p1、WHM 從 p1 移到 p0，紀錄必須跟著走
        assert.deepEqual(final.mits, { 'm5s-p1-war_sio': [0], 'm5s-p0-whm_tmp': [1] });
    });

    it('不 mutate 輸入的 autoMerged', () => {
        const autoMerged = { mits: { 'm5s-p0-pld_grd': [0, 2] }, selectedVariants: {}, customRowsByDuty: {} };
        const autoMergedCopy = JSON.parse(JSON.stringify(autoMerged));
        const enriched = [{ type: 'skill', key: 'm5s-p0-pld_grd', choice: 'local' }];
        const localData = { mits: { 'm5s-p0-pld_grd': [9] } };

        applyConflictChoices(autoMerged, enriched, localData);
        assert.deepEqual(autoMerged, autoMergedCopy);
    });
});
