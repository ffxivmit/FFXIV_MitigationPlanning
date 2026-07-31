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
    isShieldCoverageActiveAt,
    isNeutralSectShieldActiveAt,
    SHIELD_PRIORITY_RANK,
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

const skillById = (() => {
    const db = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'skills.json'), 'utf8'));
    const map = new Map();
    for (const job of Object.values(db)) {
        for (const s of (job.skills || [])) map.set(s.id, s);
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

describe('skills.json 資料完整性：治療量提升類技能的 selfOnly 標記', () => {
    // 中間學派／節制的 title 都明講「自身發動治療魔法」才吃到補量，不是全隊；
    // 用 effect 層級的 selfOnly 精準限定 heal_out_magic 這個效果即可修正。
    // 這裡順便鎖住「不能改用 skill.personal」這個決定：skill.personal 除了
    // 是 main.js 收合檢視預設顯示的開關，也會被 getHealOutMult/getMaxHpMult
    // 讀取當作整招層級的排除條件（sch_dis/sge_philo/war_tob 等技能就是這樣用）。
    // 對這兩招來說，改回 personal:true 不會讓計算結果出錯（heal_out_magic 已經
    // 靠 selfOnly 限制、whm_tmp 的 mit_all 也不讀 personal），純粹是會連帶把
    // 它們的收合檢視預設顯示改成「預設隱藏」，這不是這次要動的行為，所以鎖住。
    it('ast_netl_S（中間學派）的 heal_out_magic 標記 selfOnly，且不透過 skill.personal 影響收合顯示預設', () => {
        const skill = skillById.get('ast_netl_S');
        const eff = skill.effects.find(e => e.type === 'heal_out_magic');
        assert.equal(eff.selfOnly, true);
        assert.notEqual(skill.personal, true);
    });

    it('whm_tmp（節制）的 heal_out_magic 標記 selfOnly，且不透過 skill.personal 影響收合顯示預設', () => {
        const skill = skillById.get('whm_tmp');
        const eff = skill.effects.find(e => e.type === 'heal_out_magic');
        assert.equal(eff.selfOnly, true);
        assert.notEqual(skill.personal, true);
    });

    it('rdm_kera（抗死）的補量效果型別應為 heal_out_magic（原本誤標為未接邏輯的 heal_in）', () => {
        const effectTypes = skillById.get('rdm_kera').effects.map(e => e.type);
        assert.ok(effectTypes.includes('heal_out_magic'));
        assert.ok(!effectTypes.includes('heal_in'));
    });
});

describe('skills.json 資料完整性：護盾技能都要登記在 SHIELD_PRIORITY_RANK', () => {
    // 防止未來新增護盾技能時忘記同步更新 mitigationLedger.js 的 SHIELD_PRIORITY_GROUPS——
    // 漏登記不會拋錯，只會靜默 fallback 成最低優先序，數值計算不會報錯但扣除順序會悄悄
    // 跟遊戲實際優先序不一致。中間學派衍生護盾（neutralSectShield，例如 ast_abc）走的是
    // '__NSS__' 這個共用 key，不需要技能本身的 id 登記。
    const hasShieldEffect = (variant) =>
        (variant.effects || []).some(e => e.type === 'shield_potency' || e.type === 'shield_maxhp');

    const shieldSkillIds = [];
    for (const job of Object.values(
        JSON.parse(readFileSync(join(__dirname, '..', 'src', 'skills.json'), 'utf8'))
    )) {
        for (const skill of (job.skills || [])) {
            if (skill.neutralSectShield) continue;
            const variants = [skill, ...Object.values(skill.levelRestrictions || {})];
            if (variants.some(hasShieldEffect)) shieldSkillIds.push(skill.id);
        }
    }

    it('skills.json 裡至少找得到幾個護盾技能（確保這個掃描邏輯本身沒有掃空）', () => {
        assert.ok(shieldSkillIds.length > 10);
    });

    for (const id of shieldSkillIds) {
        it(`${id} 的護盾扣除優先序已登記在 SHIELD_PRIORITY_RANK`, () => {
            assert.ok(SHIELD_PRIORITY_RANK.has(id), `${id} 缺少護盾優先序登記，會 fallback 成最低優先`);
        });
    }

    it('__NSS__（中間學派衍生護盾）已登記在 SHIELD_PRIORITY_RANK', () => {
        assert.ok(SHIELD_PRIORITY_RANK.has('__NSS__'));
    });
});

describe('effect.selfOnly 治療量提升技能（如中間學派/節制）只對施放者自身的治療生效', () => {
    // 中間學派（ast_netl_S）開啟時，只有「自己」發動的治療/護盾技能該吃到 +20%；
    // 其他成員發動的治療魔法不該被波及。技能本身刻意不設 skill.personal，
    // 證明限制是靠 effect.selfOnly 生效，不是靠整招 personal。
    function buildCtx(shieldMemberIndex) {
        const buff = {
            instanceId: 'p0-ast_netl_S', id: 'ast_netl_S', memberIndex: 1,
            duration: 20, cooldown: 120,
            effects: [{ type: 'heal_out_magic', val: 0.2, selfOnly: true }],
            personal: false, passive: false,
            casts: [{ time: 0, rowIndex: 0 }],
        };
        const shieldSkill = {
            instanceId: 'p1-sge_haima', id: 'sge_haima', memberIndex: shieldMemberIndex,
            duration: 15, cooldown: 120,
            effects: [{ type: 'shield_potency', val: 300, shieldRatio: 1 }],
            personal: true, passive: false,
            casts: [{ time: 1, rowIndex: 1 }],
        };
        const rows = [
            { time: 2, isCustom: false, isTargeted: false, damage: [{ amount: 99999, type: '物理' }] },
        ];
        const raidParams = { tankHp: 200000, teamMinHp: 120000, healerMnd: { SGE: 4430 } };
        return createLedgerContext({ activeSkills: [buff, shieldSkill], rows, raidParams });
    }

    it('同一成員（自己）發動的護盾：吃到 +20% 補量加成', () => {
        const ctx = buildCtx(1);
        // healAmount = floor(300*4430*0.0081*1.2) = floor(12917.88) = 12917
        assert.equal(ctx.shieldCoverage.absorption[0], 12917);
    });

    it('不同成員發動的護盾：不受影響，維持未加成的基礎值', () => {
        const ctx = buildCtx(2);
        // healAmount = floor(300*4430*0.0081) = 10764，沒有 ×1.2
        assert.equal(ctx.shieldCoverage.absorption[0], 10764);
    });

    it('雙職業各自開啟同款補量技能時，彼此不互相外溢、也不會疊加成雙倍', () => {
        // 情境：兩名成員（例如雙 AST 或一 AST 一 WHM）同時各自開啟中間學派，
        // 驗證成員1的護盾只吃到「自己」那份 +20%，不會因為成員2也同時開著
        // 而被誤判成两份都算數（1.2 而不是 1.2*1.2）。
        const buffMember1 = {
            instanceId: 'p0-ast_netl_S', id: 'ast_netl_S', memberIndex: 1,
            duration: 20, cooldown: 120,
            effects: [{ type: 'heal_out_magic', val: 0.2, selfOnly: true }],
            personal: false, passive: false,
            casts: [{ time: 0, rowIndex: 0 }],
        };
        const buffMember2 = {
            instanceId: 'p1-ast_netl_S', id: 'ast_netl_S', memberIndex: 2,
            duration: 20, cooldown: 120,
            effects: [{ type: 'heal_out_magic', val: 0.2, selfOnly: true }],
            personal: false, passive: false,
            casts: [{ time: 0, rowIndex: 1 }],
        };
        const shieldMember1 = {
            instanceId: 'p2-sge_haima', id: 'sge_haima', memberIndex: 1,
            duration: 15, cooldown: 120,
            effects: [{ type: 'shield_potency', val: 300, shieldRatio: 1 }],
            personal: true, passive: false,
            casts: [{ time: 1, rowIndex: 2 }],
        };
        const rows = [
            { time: 2, isCustom: false, isTargeted: false, damage: [{ amount: 99999, type: '物理' }] },
        ];
        const raidParams = { tankHp: 200000, teamMinHp: 120000, healerMnd: { SGE: 4430 } };
        const ctx = createLedgerContext({
            activeSkills: [buffMember1, buffMember2, shieldMember1], rows, raidParams,
        });
        // 若不小心兩份 buff 都套用會變成 floor(10764.9*1.2*1.2)=15501，而非 12917
        assert.equal(ctx.shieldCoverage.absorption[0], 12917);
    });
});

describe('護盾優先序：同一擊同時被多個護盾覆蓋時的扣除順序', () => {
    // 至黑之夜（drk_tbn）優先序高於聖光幕簾（pld_div），即使聖光幕簾先施放、且在
    // activeSkills 陣列裡排在前面，同一擊仍須先扣至黑之夜，證明扣除順序看優先序表
    // 而非施放時間或陣列建立順序。
    it('優先度高的護盾即使較晚施放、在陣列中排較後，仍優先被扣除', () => {
        const pldDiv = {
            instanceId: 'p0-pld_div', id: 'pld_div', memberIndex: 1,
            duration: 30, cooldown: 60,
            effects: [{ type: 'shield_maxhp', val: 0.2 }],
            personal: true, passive: false,
            casts: [{ time: 0, rowIndex: 0 }],
        };
        const drkTbn = {
            instanceId: 'p1-drk_tbn', id: 'drk_tbn', memberIndex: 1,
            duration: 30, cooldown: 60,
            effects: [{ type: 'shield_maxhp', val: 0.1 }],
            personal: true, passive: false,
            casts: [{ time: 5, rowIndex: 1 }],
        };
        const rows = [
            { time: 10, isCustom: false, isTargeted: false, damage: [{ amount: 15000, type: '物理' }] },
        ];
        const raidParams = { tankHp: 100000, teamMinHp: 100000, healerMnd: {} };
        const ctx = createLedgerContext({ activeSkills: [pldDiv, drkTbn], rows, raidParams });

        // pld_div shieldVal = floor(100000*0.2) = 20000；drk_tbn shieldVal = floor(100000*0.1) = 10000
        // 優先序：drk_tbn 先扣（10000 全數吸收），剩餘 5000 才輪到 pld_div
        assert.equal(ctx.shieldCoverage.absorption[0], 15000);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p1-drk_tbn-0'), 0);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p0-pld_div-0'), null);
    });

    // 殘影（nin_shad）與魔罩（blm_manaw）並列同一優先度，依施放時間排序：
    // 即使魔罩在陣列裡排在前面，較早施放的殘影仍須先被扣除。
    it('同一優先度並列時，依施放時間先後排序', () => {
        const blmManaw = {
            instanceId: 'p0-blm_manaw', id: 'blm_manaw', memberIndex: 2,
            duration: 30, cooldown: 60,
            effects: [{ type: 'shield_maxhp', val: 0.2 }],
            personal: true, passive: false,
            casts: [{ time: 3, rowIndex: 0 }],
        };
        const ninShad = {
            instanceId: 'p1-nin_shad', id: 'nin_shad', memberIndex: 2,
            duration: 30, cooldown: 60,
            effects: [{ type: 'shield_maxhp', val: 0.05 }],
            personal: true, passive: false,
            casts: [{ time: 0, rowIndex: 1 }],
        };
        const rows = [
            { time: 5, isCustom: false, isTargeted: false, damage: [{ amount: 6000, type: '物理' }] },
        ];
        const raidParams = { tankHp: 100000, teamMinHp: 100000, healerMnd: {} };
        const ctx = createLedgerContext({ activeSkills: [blmManaw, ninShad], rows, raidParams });

        // nin_shad（t=0）shieldVal = floor(100000*0.05) = 5000，先於 blm_manaw（t=3）被扣
        assert.equal(ctx.shieldCoverage.absorption[0], 6000);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p1-nin_shad-0'), 0);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p0-blm_manaw-0'), null);
    });
});

// ── isShieldCoverageActiveAt：main.js 原本兩處直接戳 shieldCoverage.depletionAt 的共用邏輯 ──
// （main.js:717-733 的中間學派護盾判斷、main.js:1284-1287 的 conditionOnce 破盾判斷）
// 已抽成這個匯出函式，isSkillActive 內部的 pureShield 分支也改用它，三處呼叫端共用同一份判斷。
describe('isShieldCoverageActiveAt', () => {
    // 只需要 rows（給 time 查詢）與 shieldCoverage.depletionAt，不需要完整的 createLedgerContext
    function buildCtx(depletionEntries) {
        return {
            rows: [{ time: 0 }, { time: 5 }, { time: 10 }, { time: 15 }, { time: 20 }],
            shieldCoverage: { depletionAt: new Map(depletionEntries) },
        };
    }

    it('depletionAt 完全沒有這個 key（技能從未成立護盾）：視為仍生效', () => {
        const ctx = buildCtx([]);
        assert.equal(isShieldCoverageActiveAt(ctx, 'p0-x-0', 3), true);
    });

    it('depletionAt 有 key 但值為 null（護盾存在、從未被打破）：視為仍生效', () => {
        const ctx = buildCtx([['p0-x-0', null]]);
        assert.equal(isShieldCoverageActiveAt(ctx, 'p0-x-0', 3), true);
    });

    it('查詢列的時間 = 破盾列的時間：破盾當下那一列仍算覆蓋', () => {
        const ctx = buildCtx([['p0-x-0', 2]]); // 破盾於 row idx2（time=10）
        assert.equal(isShieldCoverageActiveAt(ctx, 'p0-x-0', 2), true);
    });

    it('查詢列的時間 < 破盾列的時間：仍算覆蓋', () => {
        const ctx = buildCtx([['p0-x-0', 3]]); // 破盾於 row idx3（time=15）
        assert.equal(isShieldCoverageActiveAt(ctx, 'p0-x-0', 1), true); // idx1 time=5 < 15
    });

    it('查詢列的時間 > 破盾列的時間：破盾之後的列不再算覆蓋', () => {
        const ctx = buildCtx([['p0-x-0', 1]]); // 破盾於 row idx1（time=5）
        assert.equal(isShieldCoverageActiveAt(ctx, 'p0-x-0', 3), false); // idx3 time=15 > 5
    });
});

// ── isNeutralSectShieldActiveAt：main.js:717-733 isNeutralSectShieldActiveForCell 的搬移目標 ──
// 前 5 個案例直接沿用既有的 neutral-sect-shield golden-master fixture（真實從瀏覽器 dump 出來，
// 已被上面「shield depletion map matches captured output」驗證過 depletionAt 的正確性），
// 逐一手動核算 ast_abc（吉星相位，nss duration 30）在關鍵列的預期結果，交叉比對 depletionAt：
//   ast_netl_S（中間學派）於 t=0 施放，效果窗 [0,20]
//   ast_abc 施放於 t=3（ci=0）與 t=19（ci=1），兩次施放當下 NSS 都生效
//   depletionAt: p0-ast_abc-nss-0 → row idx2（t=3）；p0-ast_abc-nss-1 → row idx9（t=24）
describe('isNeutralSectShieldActiveAt（回歸測試：main.js 搬移前的行為特徵化）', () => {
    const { raw, activeSkills, rows } = loadOldFixture('neutral-sect-shield');
    const ctx = createLedgerContext({ activeSkills, rows, raidParams: raw.raidParams, hideTargeted: false });
    const astAbc = activeSkills.find(s => s.id === 'ast_abc');

    it('rowTimes[1]=0，早於 ci=0 施放時刻（t=3）：任何一次施放的窗口都還沒開始', () => {
        assert.equal(rows[1].time, 0);
        assert.equal(isNeutralSectShieldActiveAt(ctx, astAbc, 1), false);
    });

    it('rowTimes[2]=3：ci=0 施放當下，護盾覆蓋（且剛好是破盾列本身，仍算覆蓋）', () => {
        assert.equal(rows[2].time, 3);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p0-ast_abc-nss-0'), 2);
        assert.equal(isNeutralSectShieldActiveAt(ctx, astAbc, 2), true);
    });

    it('rowTimes[3]=6：ci=0 已在前一列破盾，ci=1 的窗口（t≥19）還沒開始 → 不覆蓋', () => {
        assert.equal(rows[3].time, 6);
        assert.equal(isNeutralSectShieldActiveAt(ctx, astAbc, 3), false);
    });

    it('rowTimes[9]=24：ci=0 早已破盾，但落在 ci=1 的窗口內且剛好是 ci=1 的破盾列 → 覆蓋', () => {
        assert.equal(rows[9].time, 24);
        assert.equal(ctx.shieldCoverage.depletionAt.get('p0-ast_abc-nss-1'), 9);
        assert.equal(isNeutralSectShieldActiveAt(ctx, astAbc, 9), true);
    });

    it('rowTimes[10]=27：兩次施放的護盾都已破盾 → 不覆蓋', () => {
        assert.equal(rows[10].time, 27);
        assert.equal(isNeutralSectShieldActiveAt(ctx, astAbc, 10), false);
    });

    it('非中間學派護盾技能（沒有 neutralSectShield 屬性）一律回傳 false', () => {
        const nonNssSkill = activeSkills.find(s => s.id === 'ast_netl_S');
        assert.equal(isNeutralSectShieldActiveAt(ctx, nonNssSkill, 2), false);
    });
});

// 上面的 fixture 裡兩次 ast_abc 施放都剛好在中間學派生效時發動，沒有涵蓋「施放當下中間學派
// 不生效，所以完全不附加護盾」這個分支（main.js 原始邏輯的 `if (!ledgerIsNeutralSectActive(...)) continue`）。
// 手動建構一個最小 ctx 補這個邊界情況。
describe('isNeutralSectShieldActiveAt — 施放當下中間學派未生效的邊界情況', () => {
    it('技能施放時中間學派效果已結束：完全不附加護盾，任何列都不覆蓋', () => {
        const netlSkill = {
            instanceId: 'p0-ast_netl_S', id: 'ast_netl_S', memberIndex: 1,
            duration: 20, effects: [], personal: false, passive: false,
            casts: [{ time: 0, rowIndex: 0 }],
        };
        // 吉星相位施放於 t=25，此時中間學派窗口 [0,20] 早已結束
        const shieldSkill = {
            instanceId: 'p0-ast_abc', id: 'ast_abc', memberIndex: 1,
            duration: 15, effects: [], personal: false, passive: false,
            neutralSectShield: { val: 250, shieldRatio: 2.5, duration: 30 },
            casts: [{ time: 25, rowIndex: 0 }],
        };
        const rows = [
            { time: 0, isCustom: false, isTargeted: false, damage: [] },
            { time: 25, isCustom: false, isTargeted: false, damage: [] },
            { time: 40, isCustom: false, isTargeted: false, damage: [{ amount: 100000, type: '物理' }] },
        ];
        const raidParams = { tankHp: 200000, teamMinHp: 120000, healerMnd: { AST: 3250 } };
        const ctx = createLedgerContext({ activeSkills: [netlSkill, shieldSkill], rows, raidParams });

        // 若沒有中間學派閘門，t=40 會落在 [25, 25+30] 護盾窗內而誤判為覆蓋
        assert.equal(isNeutralSectShieldActiveAt(ctx, shieldSkill, 2), false);
    });
});
