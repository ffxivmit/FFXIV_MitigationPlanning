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
        base.notes = { 'p0-pld_grd-0': '舊備註' };
        const dbData = emptyPlan();
        dbData.notes = { 'p0-pld_grd-0': 'DB備註' };
        const local = emptyPlan();
        local.notes = { 'p0-pld_grd-0': '本機備註' };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.notes, { 'p0-pld_grd-0': '本機備註' });
        assert.deepEqual(conflicts, []);
    });
});

describe('mergePayloads — skillStateMap', () => {
    it('一律採用 local，不比對、不參與衝突判斷', () => {
        const base = emptyPlan();
        const dbData = emptyPlan();
        dbData.skillStateMap = { 'm5s-p0-pld_tpc': 1 };
        const local = emptyPlan();
        local.skillStateMap = { 'm5s-p0-pld_tpc': 0 };

        const { merged, conflicts } = mergePayloads(base, dbData, local);
        assert.deepEqual(merged.skillStateMap, { 'm5s-p0-pld_tpc': 0 });
        assert.deepEqual(conflicts, []);
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

    it('不 mutate 輸入的 autoMerged', () => {
        const autoMerged = { mits: { 'm5s-p0-pld_grd': [0, 2] }, selectedVariants: {}, customRowsByDuty: {} };
        const autoMergedCopy = JSON.parse(JSON.stringify(autoMerged));
        const enriched = [{ type: 'skill', key: 'm5s-p0-pld_grd', choice: 'local' }];
        const localData = { mits: { 'm5s-p0-pld_grd': [9] } };

        applyConflictChoices(autoMerged, enriched, localData);
        assert.deepEqual(autoMerged, autoMergedCopy);
    });
});
