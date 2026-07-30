import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    createLedgerContext,
    calcShieldValue,
    calculateDamage,
    getDamageBreakdown,
    isSkillActive,
    isSkillOnCooldown,
    isSkillRecastable,
} from '../src/mitigationLedger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// window.__ledgerDebug() 的 skill dump 沒有帶 name 欄位，但 buildDamageByRow 的同名
// 技能去重（appliedNames）需要真正的技能名稱，否則所有 name===undefined 的技能會被
// 誤判成「同一招」而互相蓋掉。name 是技能定義的靜態屬性，不受任何執行狀態影響，
// 直接從 skills.json 反查即可，不需要重新從瀏覽器 dump。
const skillNameById = (() => {
    const db = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'skills.json'), 'utf8'));
    const map = new Map();
    for (const job of Object.values(db)) {
        for (const s of (job.skills || [])) map.set(s.id, s.name);
    }
    return map;
})();

// 舊格式 fixture（test/fixtures/*.json）是從瀏覽器 window.__ledgerDebug() 手動 dump 出來的，
// 早於 rows/per-hit 拆解欄位加入之前，只有整列加總的 rawDamageByRow。
// 這些 fixture 涵蓋的場景都沒有任何 mit_physical/mit_magic-only 效果實際生效過
// （相關技能都在 skills 清單裡但 castTimes 是空的），所以「整列一個 hit」的還原
// 跟真正逐擊拆解的結果完全等價，可以放心拿來當 golden-master 驗證。
// castTimes 沒有保留 rowIndex，因此以 time 本身當 rowIndex 的替代值——這讓「同一秒
// 兩個技能施放」的比較結果仍然正確（相等時不算「更早」），跟目前唯一真的踩到這個
// 邊界的 tempera-coating fixture（坦培拉塗層同秒施放）的實際輸出一致。
function loadOldFixture(name) {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
    const activeSkills = raw.skills.map(s => ({
        ...s,
        name: skillNameById.get(s.id) ?? s.id,
        casts: s.castTimes.map(time => ({ time, rowIndex: time })),
    }));
    const rows = raw.rowTimes.map((time, i) => ({
        time,
        isCustom: false,
        isTargeted: false,
        damage: raw.rawDamageByRow[i] > 0 ? [{ amount: raw.rawDamageByRow[i], type: '物理' }] : [],
    }));
    return { raw, activeSkills, rows };
}

const FIXTURE_NAMES = [
    'baseline',
    'tempera-coating',
    'recitation',
    'zoe-activation',
    'neutral-sect-shield',
    'charges',
    'toggle-pair',
    'shared-cooldown',
    'transfusion-stacks',
];

for (const name of FIXTURE_NAMES) {
    describe(`golden-master fixture: ${name}`, () => {
        const { raw, activeSkills, rows } = loadOldFixture(name);
        const ctx = createLedgerContext({ activeSkills, rows, raidParams: raw.raidParams, hideTargeted: false });

        it('damageByRow matches captured output', () => {
            assert.deepEqual(ctx.damageByRow, raw.damageByRow);
        });

        it('shield absorption matches captured output', () => {
            assert.deepEqual(ctx.shieldCoverage.absorption, raw.shieldAbsorption);
        });

        it('shield depletion map matches captured output', () => {
            const actual = Array.from(ctx.shieldCoverage.depletionAt.entries()).sort();
            const expected = raw.shieldDepletionAt.slice().sort();
            assert.deepEqual(actual, expected);
        });

        it('isSkillActive matches captured output for every skill/row', () => {
            for (const skill of activeSkills) {
                const expected = raw.isActiveByRow[skill.instanceId];
                const actual = rows.map((_, idx) => isSkillActive(ctx, skill.instanceId, idx, skill));
                assert.deepEqual(actual, expected, `isActive mismatch for ${skill.instanceId}`);
            }
        });

        it('isSkillOnCooldown matches captured output for every skill/row', () => {
            for (const skill of activeSkills) {
                const expected = raw.onCooldownByRow[skill.instanceId];
                const actual = rows.map((_, idx) => isSkillOnCooldown(ctx, skill.instanceId, idx, skill));
                assert.deepEqual(actual, expected, `onCooldown mismatch for ${skill.instanceId}`);
            }
        });
    });
}

// ── 補充案例：舊 fixture 沒有自然出現的情境 ──────────────────

describe('mit_physical / mit_magic 逐擊分屬性減傷', () => {
    // 棄明投暗（drk_dmind）：物理減傷10%、魔法減傷20%，各自只對對應屬性的 hit 生效
    const skill = {
        instanceId: 'p0-drk_dmind', id: 'drk_dmind', memberIndex: 1,
        duration: 10, cooldown: 60,
        effects: [{ type: 'mit_magic', val: 0.2 }, { type: 'mit_physical', val: 0.1 }],
        personal: true, passive: false,
        casts: [{ time: 0, rowIndex: 0 }],
    };
    const rows = [
        { time: 5, isCustom: false, isTargeted: false, damage: [{ amount: 100000, type: '物理' }, { amount: 100000, type: '魔法' }] },
    ];
    const ctx = createLedgerContext({ activeSkills: [skill], rows, raidParams: { tankHp: 200000, teamMinHp: 120000, healerMnd: {} } });

    it('物理 hit 只吃 mit_physical，魔法 hit 只吃 mit_magic', () => {
        // 100000*0.9 + 100000*0.8 = 90000 + 80000 = 170000
        assert.equal(ctx.damageByRow[0], 170000);
    });
});

describe('護盾單次吸收邊界（輸血/泛輸血 stacks 機制）', () => {
    function buildCtx(hitAmount) {
        const skill = {
            instanceId: 'p0-sge_haima', id: 'sge_haima', memberIndex: 1,
            duration: 15, cooldown: 120,
            effects: [{ type: 'shield_potency', val: 300, shieldRatio: 1, stacks: 5 }],
            personal: true, passive: false,
            casts: [{ time: 0, rowIndex: 0 }],
        };
        const rows = [
            { time: 1, isCustom: false, isTargeted: false, damage: [{ amount: hitAmount, type: '物理' }] },
        ];
        const raidParams = { tankHp: 200000, teamMinHp: 120000, healerMnd: { SGE: 4430 } };
        const ctx = createLedgerContext({ activeSkills: [skill], rows, raidParams });
        // healAmount = floor(300*4430*0.0081) = 10764; shieldVal = floor(10764*1) = 10764
        return { ctx, layerAmount: 10764 };
    }

    it('傷害 < 剩餘值：護盾延續，不觸發補層', () => {
        const { ctx, layerAmount } = buildCtx(layerAmountMinusOne(10764));
        assert.equal(ctx.shieldCoverage.absorption[0], 10764 - 1);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p0-sge_haima-0'), null);
    });

    it('傷害 = 剩餘值：視為破除臨界點，觸發補層而非「延續」', () => {
        const { ctx } = buildCtx(10764);
        assert.equal(ctx.shieldCoverage.absorption[0], 10764);
        // 只有這一次傷害，補層後沒有下一次傷害可驗證，但至少確認沒有被標記為永久耗盡
        // （layersLeft 還有剩，補層分支會 continue，不會落入 depletionRowIdx 賦值）
        assert.equal(ctx.shieldCoverage.depletionAt.get('p0-sge_haima-0'), null);
    });

    it('傷害 > 剩餘值：破除並補層，超出部分不會被同一護盾繼續吸收', () => {
        const { ctx } = buildCtx(20000);
        assert.equal(ctx.shieldCoverage.absorption[0], 10764);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p0-sge_haima-0'), null);
    });

    function layerAmountMinusOne(v) { return v - 1; }
});
