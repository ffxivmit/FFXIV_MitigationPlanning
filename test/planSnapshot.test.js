import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializePlanSnapshot, applyPlanSnapshot, migrateLegacyMitMap } from '../src/planSnapshot.js';

describe('serializePlanSnapshot', () => {
    it('回傳固定的 7 個欄位，並把 mitMap/notesMap 換成 mits/notes', () => {
        const snap = serializePlanSnapshot({
            duty: 'm5s',
            party: ['pld', 'whm'],
            mitMap: { 'm5s-p0-pld_shield': [0, 3] },
            notesMap: { 'm5s-p0-pld_shield-0': '開頭先擋' },
            selectedVariants: { 'm5s-0': 1 },
            customRowsByDuty: { m5s: [{ id: 'r1', time: 12 }] },
            skillStateMap: { 'm5s-p0-drk_dmind-0': true },
        });
        assert.deepEqual(snap, {
            duty: 'm5s',
            party: ['pld', 'whm'],
            mits: { 'm5s-p0-pld_shield': [0, 3] },
            notes: { 'm5s-p0-pld_shield-0': '開頭先擋' },
            selectedVariants: { 'm5s-0': 1 },
            customRowsByDuty: { m5s: [{ id: 'r1', time: 12 }] },
            skillStateMap: { 'm5s-p0-drk_dmind-0': true },
        });
    });

    it('缺欄位時填入合理預設值，不會輸出 undefined', () => {
        const snap = serializePlanSnapshot({});
        assert.deepEqual(snap, {
            duty: '',
            party: [],
            mits: {},
            notes: {},
            selectedVariants: {},
            customRowsByDuty: {},
            skillStateMap: {},
        });
    });

    it('不輸出 hideNonDmg/hideTargeted——純顯示開關不屬於計畫快照', () => {
        const snap = serializePlanSnapshot({ duty: 'm5s', hideNonDmg: true, hideTargeted: true });
        assert.equal('hideNonDmg' in snap, false);
        assert.equal('hideTargeted' in snap, false);
    });
});

describe('serializePlanSnapshot → applyPlanSnapshot 來回還原', () => {
    it('notes 和 skillStateMap 不會在匯出/匯入之間遺失（回歸測試：候選案四發現的 bug）', () => {
        const original = {
            duty: 'm6s',
            party: ['war', 'sch'],
            mitMap: { 'm6s-p0-war_vengeance': [1] },
            notesMap: { 'm6s-p0-war_vengeance-1': '記得先開盾' },
            selectedVariants: {},
            customRowsByDuty: {},
            skillStateMap: { 'm6s-p1-sch_recitation-0': true },
        };
        const roundTripped = applyPlanSnapshot(JSON.parse(JSON.stringify(serializePlanSnapshot(original))));
        assert.deepEqual(roundTripped, original);
    });
});

describe('applyPlanSnapshot', () => {
    it('對 legacy 格式的 mitMap 會自動跑 migrateLegacyMitMap 轉換', () => {
        const snap = applyPlanSnapshot({
            duty: 'm7s',
            mits: { 'm7s-2-p0-pld_shield': true, 'm7s-5-p0-pld_shield': true },
        });
        assert.deepEqual(snap.mitMap, { 'm7s-p0-pld_shield': [2, 5] });
    });

    it('同時接受本機 localStorage 格式（selectedDutyKey/mitMap）與可攜格式（duty/mits）', () => {
        const fromLocal = applyPlanSnapshot({ selectedDutyKey: 'm8s', mitMap: { 'm8s-p0-x': [0] } });
        assert.equal(fromLocal.duty, 'm8s');
        assert.deepEqual(fromLocal.mitMap, { 'm8s-p0-x': [0] });

        const fromPortable = applyPlanSnapshot({ duty: 'm8s', mits: { 'm8s-p0-x': [0] } });
        assert.equal(fromPortable.duty, 'm8s');
        assert.deepEqual(fromPortable.mitMap, { 'm8s-p0-x': [0] });
    });

    it('欄位缺漏時（例如舊版匯出檔沒有 notes/skillStateMap）回傳空物件，不丟例外', () => {
        const snap = applyPlanSnapshot({ duty: 'm5s', party: ['pld'], mits: {} });
        assert.deepEqual(snap.notesMap, {});
        assert.deepEqual(snap.skillStateMap, {});
        assert.deepEqual(snap.selectedVariants, {});
        assert.deepEqual(snap.customRowsByDuty, {});
    });

    it('json 為 null/undefined 時不丟例外，回傳全部預設值', () => {
        const snap = applyPlanSnapshot(null);
        assert.equal(snap.duty, '');
        assert.deepEqual(snap.party, []);
        assert.deepEqual(snap.mitMap, {});
    });
});

describe('migrateLegacyMitMap', () => {
    it('陣列格式（新格式）原封不動保留', () => {
        assert.deepEqual(migrateLegacyMitMap({ 'm5s-p0-x': [0, 1] }), { 'm5s-p0-x': [0, 1] });
    });

    it('把「duty-rowIdx-skillInstanceId: true」的舊格式合併成「duty-skillInstanceId: [rowIdx,...]」', () => {
        const legacy = {
            'm5s-0-p0-pld_shield': true,
            'm5s-3-p0-pld_shield': true,
            'm5s-1-p1-whm_shield': true,
        };
        assert.deepEqual(migrateLegacyMitMap(legacy), {
            'm5s-p0-pld_shield': [0, 3],
            'm5s-p1-whm_shield': [1],
        });
    });

    it('rowIdx 依數字排序，不是字串排序', () => {
        const legacy = { 'm5s-10-p0-x': true, 'm5s-2-p0-x': true };
        assert.deepEqual(migrateLegacyMitMap(legacy)['m5s-p0-x'], [2, 10]);
    });
});
