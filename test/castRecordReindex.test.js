import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMemberRemovalMapping,
    buildMemberSwapMapping,
    reindexCastRecordsByMember,
    reindexCastRecordsByRemovedRow,
} from '../src/castRecordReindex.js';

describe('buildMemberRemovalMapping', () => {
    it('被移除的成員對應到 -1，其後成員全部往前一格，其前不變', () => {
        assert.deepEqual(buildMemberRemovalMapping(4, 1), [0, -1, 1, 2]);
    });

    it('移除最後一位時，其他成員的索引不變', () => {
        assert.deepEqual(buildMemberRemovalMapping(3, 2), [0, 1, -1]);
    });
});

describe('buildMemberSwapMapping', () => {
    it('往後拖曳（fromIdx < toIdx）：中間成員往前補一格', () => {
        assert.deepEqual(buildMemberSwapMapping(4, 0, 2), [2, 0, 1, 3]);
    });

    it('往前拖曳（fromIdx > toIdx）：中間成員往後補一格', () => {
        // [A,B,C,D] 把 D（index 3）拖到 index 1 → [A,D,B,C]：A 留在 0，D 移到 1，B/C 各往後補一格
        assert.deepEqual(buildMemberSwapMapping(4, 3, 1), [0, 2, 3, 1]);
    });
});

describe('reindexCastRecordsByMember — 成員軸（回歸測試：commit 4a69261 修過的刪除成員 bug）', () => {
    it('刪除中間成員：mitMap/skillStateMap/notesMap 都同步重寫，被刪成員的資料都丟棄', () => {
        const oldToNew = buildMemberRemovalMapping(3, 1);
        const result = reindexCastRecordsByMember({
            mitMap: {
                'm5s-p0-pld_shield': [0],
                'm5s-p1-whm_shield': [1],
                'm5s-p2-sch_shield': [2],
            },
            skillStateMap: {
                'm5s-p1-whm_shield': true,
                'm5s-p2-sch_shield': true,
            },
            notesMap: {
                'm5s-p0-pld_shield-0': '先開盾',
                'm5s-p2-sch_shield-2': '記得補',
            },
        }, oldToNew);

        assert.deepEqual(result.mitMap, {
            'm5s-p0-pld_shield': [0],
            'm5s-p1-sch_shield': [2],
        });
        assert.deepEqual(result.skillStateMap, {
            'm5s-p1-sch_shield': true,
        });
        assert.deepEqual(result.notesMap, {
            'm5s-p0-pld_shield-0': '先開盾',
            'm5s-p1-sch_shield-2': '記得補',
        });
    });

    it('不含 "-p{n}-" 片段的 key（非成員資料）原樣保留', () => {
        const oldToNew = buildMemberRemovalMapping(2, 0);
        const result = reindexCastRecordsByMember({
            mitMap: { 'some-other-key': [0] },
            skillStateMap: {},
            notesMap: {},
        }, oldToNew);
        assert.deepEqual(result.mitMap, { 'some-other-key': [0] });
    });

    it('拖曳重排（swap）：介於 from/to 之間的成員資料跟著平移', () => {
        const oldToNew = buildMemberSwapMapping(3, 0, 2);
        const result = reindexCastRecordsByMember({
            mitMap: {
                'm5s-p0-a': [0],
                'm5s-p1-b': [1],
                'm5s-p2-c': [2],
            },
            skillStateMap: {},
            notesMap: {},
        }, oldToNew);
        assert.deepEqual(result.mitMap, {
            'm5s-p2-a': [0],
            'm5s-p0-b': [1],
            'm5s-p1-c': [2],
        });
    });
});

describe('reindexCastRecordsByRemovedRow — 列軸（發現的 bug：notesMap 先前完全沒有跟著重映射）', () => {
    it('mitMap：施放列索引陣列中，等於被刪列的濾除，大於的往前遞補一位', () => {
        const result = reindexCastRecordsByRemovedRow({
            mitMap: { 'm5s-p0-pld_shield': [1, 3, 5] },
            notesMap: {},
        }, { dutyPrefix: 'm5s-', removedRowIdx: 3 });
        assert.deepEqual(result.mitMap, { 'm5s-p0-pld_shield': [1, 4] });
    });

    it('mitMap：移除後陣列變空時整個 key 刪除', () => {
        const result = reindexCastRecordsByRemovedRow({
            mitMap: { 'm5s-p0-pld_shield': [3] },
            notesMap: {},
        }, { dutyPrefix: 'm5s-', removedRowIdx: 3 });
        assert.deepEqual(result.mitMap, {});
    });

    it('notesMap：key 尾段的列索引比照 mitMap 規則重寫（修正前這裡完全沒有處理）', () => {
        const result = reindexCastRecordsByRemovedRow({
            mitMap: {},
            notesMap: {
                'm5s-p0-pld_shield-1': '前面的列，不受影響',
                'm5s-p0-pld_shield-3': '被刪的那一列',
                'm5s-p0-pld_shield-5': '後面的列，要往前補一位',
            },
        }, { dutyPrefix: 'm5s-', removedRowIdx: 3 });
        assert.deepEqual(result.notesMap, {
            'm5s-p0-pld_shield-1': '前面的列，不受影響',
            'm5s-p0-pld_shield-4': '後面的列，要往前補一位',
        });
    });

    it('只處理屬於指定 dutyPrefix 的 key，其他副本的資料原樣保留', () => {
        const result = reindexCastRecordsByRemovedRow({
            mitMap: { 'm6s-p0-x': [3, 5] },
            notesMap: { 'm6s-p0-x-5': '別的副本，不該被動到' },
        }, { dutyPrefix: 'm5s-', removedRowIdx: 3 });
        assert.deepEqual(result.mitMap, { 'm6s-p0-x': [3, 5] });
        assert.deepEqual(result.notesMap, { 'm6s-p0-x-5': '別的副本，不該被動到' });
    });

    it('刪除列索引 0（最早的一列）：其餘所有列都往前遞補一位', () => {
        const result = reindexCastRecordsByRemovedRow({
            mitMap: { 'm5s-p0-x': [0, 1, 2] },
            notesMap: { 'm5s-p0-x-0': '第一列', 'm5s-p0-x-2': '第三列' },
        }, { dutyPrefix: 'm5s-', removedRowIdx: 0 });
        assert.deepEqual(result.mitMap, { 'm5s-p0-x': [0, 1] });
        assert.deepEqual(result.notesMap, { 'm5s-p0-x-1': '第三列' });
    });
});

describe('不變性與邊界情況', () => {
    it('reindexCastRecordsByMember 不會 mutate 傳入的原始 map（Vue 的 ref 要靠新物件識別變更）', () => {
        const mitMap = { 'm5s-p0-a': [0] };
        const skillStateMap = { 'm5s-p0-a': true };
        const notesMap = { 'm5s-p0-a-0': '備註' };
        const frozen = {
            mitMap: JSON.parse(JSON.stringify(mitMap)),
            skillStateMap: JSON.parse(JSON.stringify(skillStateMap)),
            notesMap: JSON.parse(JSON.stringify(notesMap)),
        };
        reindexCastRecordsByMember({ mitMap, skillStateMap, notesMap }, buildMemberRemovalMapping(2, 1));
        assert.deepEqual(mitMap, frozen.mitMap);
        assert.deepEqual(skillStateMap, frozen.skillStateMap);
        assert.deepEqual(notesMap, frozen.notesMap);
    });

    it('reindexCastRecordsByRemovedRow 不會 mutate 傳入的原始 map', () => {
        const mitMap = { 'm5s-p0-a': [0, 2] };
        const notesMap = { 'm5s-p0-a-2': '備註' };
        const frozen = {
            mitMap: JSON.parse(JSON.stringify(mitMap)),
            notesMap: JSON.parse(JSON.stringify(notesMap)),
        };
        reindexCastRecordsByRemovedRow({ mitMap, notesMap }, { dutyPrefix: 'm5s-', removedRowIdx: 0 });
        assert.deepEqual(mitMap, frozen.mitMap);
        assert.deepEqual(notesMap, frozen.notesMap);
    });

    it('三個 map 皆為空物件時，兩個函式都回傳空物件，不丟例外', () => {
        const byMember = reindexCastRecordsByMember(
            { mitMap: {}, skillStateMap: {}, notesMap: {} },
            buildMemberRemovalMapping(3, 0),
        );
        assert.deepEqual(byMember, { mitMap: {}, skillStateMap: {}, notesMap: {} });

        const byRow = reindexCastRecordsByRemovedRow(
            { mitMap: {}, notesMap: {} },
            { dutyPrefix: 'm5s-', removedRowIdx: 0 },
        );
        assert.deepEqual(byRow, { mitMap: {}, notesMap: {} });
    });

    it('移除隊伍中第 0 位成員：後面所有成員的 key 都往前一格', () => {
        const oldToNew = buildMemberRemovalMapping(3, 0);
        const result = reindexCastRecordsByMember({
            mitMap: {
                'm5s-p0-a': [0],
                'm5s-p1-b': [1],
                'm5s-p2-c': [2],
            },
            skillStateMap: {},
            notesMap: {},
        }, oldToNew);
        assert.deepEqual(result.mitMap, {
            'm5s-p0-b': [1],
            'm5s-p1-c': [2],
        });
    });
});
