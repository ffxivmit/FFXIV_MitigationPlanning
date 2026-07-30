// 減傷帳本（mitigation ledger）：純函式模組，計算每列傷害、護盾吸收、技能啟用/冷卻狀態。
// 介面只接收「已解析完成的技能實例」（已套用等級限制），不處理 duty/party/mitMap 原始資料，
// 也不處理任何顯示格式（tooltip 字串留在 main.js）。詳見 CONTEXT.md「減傷帳本」。
//
// 技能實例形狀：
//   { instanceId, id, memberIndex, duration, cooldown, effects, personal, passive,
//     upgradeSkillId, multiState, conditionSkillId, conditionOnce, charges,
//     togglesWithId, isFirstToggle, sharedCooldownId, neutralSectShield,
//     zoeHealMult, recitationCritMult,
//     casts: [{ time, rowIndex }] }
// 列（rows）形狀（index 即 rowIndex）：
//   { time, isCustom, isTargeted, damage: [{ amount, type }] }

const HEALER_MIND_SCALING = 0.81 / 100;
const SHIELD_EFFECT_TYPES = new Set(['shield_maxhp', 'shield_potency']);
const MIT_EFFECT_TYPES = new Set(['mit_all', 'mit_physical', 'mit_magic', 'invincible']);
const HEALER_JOB_MAP = { whm: 'WHM', sch: 'SCH', ast: 'AST', sge: 'SGE' };
const TANK_JOB_PREFIXES = new Set(['pld', 'war', 'drk', 'gnb']);

const getJobPrefix = (skill) => (skill.id || '').split('_')[0];

export function createLedgerContext({ activeSkills, rows, raidParams, hideTargeted = false }) {
    const skillsByInstance = new Map();
    const skillsByKey = new Map();
    const timesByInstance = new Map();
    for (const skill of activeSkills) {
        skillsByInstance.set(skill.instanceId, skill);
        skillsByKey.set(`${skill.id}|${skill.memberIndex}`, skill);
        timesByInstance.set(skill.instanceId, (skill.casts || []).map(c => c.time));
    }

    const ctx = { activeSkills, rows, raidParams, hideTargeted, skillsByInstance, skillsByKey, timesByInstance };

    ctx.neutralSectWindowsByMember = buildNeutralSectWindows(ctx);
    ctx.zoeConsumptionByMember = buildZoeConsumption(ctx);
    ctx.rawDamageByRow = buildRawDamageByRow(ctx);
    ctx.damageByRow = buildDamageByRow(ctx);
    ctx.shieldCoverage = buildShieldCoverage(ctx);
    return ctx;
}

// ── 團隊參數 / HP / 治療量倍率 ──────────────────────────────

export const getHealerMnd = (ctx, skill) => {
    const jobKey = HEALER_JOB_MAP[getJobPrefix(skill)];
    return jobKey ? (ctx.raidParams.healerMnd[jobKey] || 3250) : null;
};

const getMaxHpMult = (ctx, memberIndex, castTime) => {
    let mult = 1.0;
    for (const skill of ctx.activeSkills) {
        if (!skill.effects?.length) continue;
        if (skill.personal === true && skill.memberIndex !== memberIndex) continue;
        const castTimes = ctx.timesByInstance.get(skill.instanceId) || [];
        const isActive = castTimes.some(ct => castTime >= ct && castTime <= ct + skill.duration);
        if (!isActive) continue;
        for (const eff of skill.effects) {
            if (eff.type === 'maxhp_boost' && eff.val != null) {
                mult *= (1 + eff.val);
            }
        }
    }
    return mult;
};

export const getMaxHpForSkill = (ctx, skill, castTime = null) => {
    const base = TANK_JOB_PREFIXES.has(getJobPrefix(skill)) ? ctx.raidParams.tankHp : ctx.raidParams.teamMinHp;
    if (castTime === null) return base;
    return Math.floor(base * getMaxHpMult(ctx, skill.memberIndex, castTime));
};

// healOutMult 只影響 shield_potency 類型，shield_maxhp 類型不受治療量加成影響
export const calcShieldValue = (ctx, skill, healOutMult = 1.0, castTime = null) => {
    if (!skill?.effects?.length) return 0;
    let total = 0;
    const healerMnd = getHealerMnd(ctx, skill);
    for (const eff of skill.effects) {
        if (eff.type === 'shield_maxhp') {
            total += Math.floor(getMaxHpForSkill(ctx, skill, castTime) * eff.val);
        } else if (eff.type === 'shield_potency' && !eff.useTankStats && healerMnd) {
            const shieldRatio = eff.shieldRatio || 1.0;
            const healAmount = Math.floor(eff.val * (healerMnd * HEALER_MIND_SCALING) * healOutMult);
            // 注意：stacks（血印/泛血印）不在此處合併總量，改由呼叫端拆成多層護盾各自計算，
            // 才能還原「破盾即以同等量補上一層」的機制，而非一次性的加總大護盾
            total += Math.floor(healAmount * shieldRatio);
        }
    }
    return total;
};

export const isNeutralSectActive = (ctx, memberIndex, castTime) => {
    const wins = ctx.neutralSectWindowsByMember.get(memberIndex);
    if (!wins) return false;
    return wins.some(w => castTime >= w.start && castTime <= w.end);
};

// 計算施放者在指定時間點的治療量提升倍率（累乘）
// personal 技能只對自己成員有效；非 personal 技能對全隊有效
const getHealOutMult = (ctx, memberIndex, castTime) => {
    let mult = 1.0;
    for (const skill of ctx.activeSkills) {
        if (!skill.effects?.length) continue;
        if (skill.personal === true && skill.memberIndex !== memberIndex) continue;
        const castTimes = ctx.timesByInstance.get(skill.instanceId) || [];
        const isActive = castTimes.some(ct => castTime >= ct && castTime <= ct + skill.duration);
        if (!isActive) continue;
        for (const eff of skill.effects) {
            if (eff.type === 'heal_out_magic' && eff.val != null) {
                mult *= (1 + eff.val);
            }
        }
    }
    return mult;
};

// 預建「中間學派生效窗口」Map，避免每次掃全部 activeSkills
function buildNeutralSectWindows(ctx) {
    const result = new Map(); // memberIndex -> [{start, end}]
    for (const s of ctx.activeSkills) {
        if (s.id !== 'ast_netl_S') continue;
        const cts = ctx.timesByInstance.get(s.instanceId) || [];
        if (!cts.length) continue;
        if (!result.has(s.memberIndex)) result.set(s.memberIndex, []);
        const wins = result.get(s.memberIndex);
        for (const ct of cts) wins.push({ start: ct, end: ct + s.duration });
    }
    return result;
}

// 活化（sge_Zoe）消耗紀錄：每次活化施放後，找出效果時間內最早施放的合格治療魔法
// key: `${memberIndex}-${zoeCastTime}` → consumedAt（最早合格施放時間）
function buildZoeConsumption(ctx) {
    const result = new Map();
    const zoeSkillByMember = new Map();
    for (const s of ctx.activeSkills) {
        if (s.id === 'sge_Zoe') zoeSkillByMember.set(s.memberIndex, s);
    }
    for (const skill of ctx.activeSkills) {
        if (skill.zoeHealMult == null) continue;
        const zoeSkill = zoeSkillByMember.get(skill.memberIndex);
        if (!zoeSkill) continue;
        const zoeCastTimes = ctx.timesByInstance.get(zoeSkill.instanceId) || [];
        const zoeDuration = zoeSkill.duration ?? 30;
        for (const ct of (ctx.timesByInstance.get(skill.instanceId) || [])) {
            const zt = zoeCastTimes.find(z => ct >= z && ct <= z + zoeDuration);
            if (zt === undefined) continue;
            const key = `${skill.memberIndex}-${zt}`;
            if (!result.has(key) || ct < result.get(key)) {
                result.set(key, ct);
            }
        }
    }
    return result;
}

const getZoeEffectiveDuration = (ctx, zoeSkill, zoeCastTimeSecs) => {
    const consumedAt = ctx.zoeConsumptionByMember.get(`${zoeSkill.memberIndex}-${zoeCastTimeSecs}`);
    if (consumedAt == null) return zoeSkill.duration;
    return Math.min(zoeSkill.duration, consumedAt - zoeCastTimeSecs);
};

// ── 坦培拉塗層（PCT）：TPC 被 TPG 立即消耗 ──────────────────

// 找出在 TPC 施放窗口內的 TPG 施放時間（秒）。同秒數時用 rowIndex 比較：
// TPG 的 rowIndex 必須不早於 TPC 才算在窗口內（同列視為同時施放，TPG 立即解除 TPC 的護盾）
function findTpgTimeSecs(ctx, tpcSkill, tpcCastTimeSecs, tpcRowIndex) {
    if (!tpcSkill.upgradeSkillId) return null;
    const upgSkill = ctx.skillsByKey.get(`${tpcSkill.upgradeSkillId}|${tpcSkill.memberIndex}`);
    if (!upgSkill) return null;
    for (const { time: tpgTime, rowIndex: tpgRowIndex } of (upgSkill.casts || [])) {
        if (tpgTime < tpcCastTimeSecs) continue;
        if (tpgTime > tpcCastTimeSecs + tpcSkill.duration) continue;
        if (tpgTime === tpcCastTimeSecs && tpgRowIndex < tpcRowIndex) continue;
        return tpgTime;
    }
    return null;
}

// 根據 TPC 的施放時間與 TPG 是否存在，計算 TPC 的有效持續時間（TPG 施放時截斷）
const getTpcEffectiveDuration = (ctx, tpcSkill, cast) => {
    if (!tpcSkill.upgradeSkillId) return tpcSkill.duration;
    const tpgTime = findTpgTimeSecs(ctx, tpcSkill, cast.time, cast.rowIndex);
    return tpgTime != null ? (tpgTime - cast.time) : tpcSkill.duration;
};

// 檢查指定技能第 ci 次施放的護盾是否已被完全吸收
const isShieldDepleted = (ctx, skillInst, ci) => {
    return ctx.shieldCoverage.depletionAt.get(`${skillInst.instanceId}-${ci}`) != null;
};

// 根據護盾是否耗盡自動計算 TPC 的有效 CD
// TPC 護盾耗盡 → 60s；TPG 護盾耗盡 → 90s；否則 → 120s（skill.cooldown）
const getTpcEffectiveCooldown = (ctx, tpcSkill, cast, ci) => {
    if (isShieldDepleted(ctx, tpcSkill, ci)) {
        return tpcSkill.stateCooldowns?.[1] ?? 60;
    }
    if (tpcSkill.upgradeSkillId) {
        const upgSkill = ctx.skillsByKey.get(`${tpcSkill.upgradeSkillId}|${tpcSkill.memberIndex}`);
        if (upgSkill) {
            const tpgTime = findTpgTimeSecs(ctx, tpcSkill, cast.time, cast.rowIndex);
            if (tpgTime != null) {
                const tpgCi = (upgSkill.casts || []).findIndex(c => c.time === tpgTime);
                if (tpgCi >= 0 && isShieldDepleted(ctx, upgSkill, tpgCi)) {
                    return tpcSkill.cooldown - 30;
                }
            }
        }
    }
    return tpcSkill.cooldown;
};

// ── 多充能 ─────────────────────────────────────────────────

const computeChargeRestoreTimes = (sortedCastTimes, rechargeTime) => {
    const restoreTimes = [];
    let lastRestore = -Infinity;
    for (const ct of sortedCastTimes) {
        lastRestore = Math.max(ct, lastRestore) + rechargeTime;
        restoreTimes.push(lastRestore);
    }
    return restoreTimes;
};

const chargesAvailableAtTime = (checkTime, skill, sortedContextTimes) => {
    const castsBefore = sortedContextTimes.filter(ct => ct < checkTime);
    if (!castsBefore.length) return skill.charges;
    const restoreTimes = computeChargeRestoreTimes(castsBefore, skill.cooldown);
    const inRecharge = castsBefore.filter((_ct, i) => checkTime < restoreTimes[i]).length;
    return Math.max(0, skill.charges - inRecharge);
};

const chargesAvailableAt = (ctx, skillInstanceId, rowTime, skill) => {
    const allTimes = ctx.timesByInstance.get(skillInstanceId) || [];
    return chargesAvailableAtTime(rowTime, skill, allTimes);
};

// ── 傷害計算 ───────────────────────────────────────────────

export const isPureShieldSkill = (skill) => {
    if (!skill?.effects?.length) return false;
    const hasShield = skill.effects.some(e => SHIELD_EFFECT_TYPES.has(e.type));
    const hasMit = skill.effects.some(e => MIT_EFFECT_TYPES.has(e.type));
    return hasShield && !hasMit;
};

// 未套用任何減傷技能前的原始傷害（僅加總命中傷害，不套用 mit_* 效果）
function buildRawDamageByRow(ctx) {
    return ctx.rows.map(row => {
        if (row.isCustom || !row.damage?.length) return 0;
        let total = 0;
        for (const hit of row.damage) total += hit.amount;
        return Math.floor(total);
    });
}

// 預先計算每列的剩餘傷害；同名技能只計算一次（appliedNames 去重）；
// 效果有 duration 限制時需檢查是否仍在效果窗內；支援 bonusVal（配對技能同時生效時的額外減傷加成）
function buildDamageByRow(ctx) {
    const flat = ctx.rows;
    const result = new Array(flat.length).fill(0);
    const skills = ctx.activeSkills;

    // Passive 技能不依賴時間，預先合算一次，避免在每個 row×hit 裡重複掃描
    const passiveMult = { '物理': 1, '魔法': 1, _other: 1 };
    const passiveAppliedNames = new Set();
    const nonPassiveSkills = [];
    for (const skill of skills) {
        if (!skill.passive) { nonPassiveSkills.push(skill); continue; }
        if (passiveAppliedNames.has(skill.name)) continue;
        let applied = false;
        for (const effect of skill.effects) {
            if (effect.val == null) continue;
            const f = 1 - effect.val;
            if (effect.type === 'mit_all') {
                passiveMult['物理'] *= f; passiveMult['魔法'] *= f; passiveMult._other *= f;
                applied = true;
            } else if (effect.type === 'mit_physical') {
                passiveMult['物理'] *= f; applied = true;
            } else if (effect.type === 'mit_magic') {
                passiveMult['魔法'] *= f; applied = true;
            }
        }
        if (applied) passiveAppliedNames.add(skill.name);
    }

    for (let internalIdx = 0; internalIdx < flat.length; internalIdx++) {
        const row = flat[internalIdx];
        if (row.isCustom) continue;
        const damages = row.damage;
        if (!damages || !damages.length) continue;
        const rowTime = row.time;
        let totalRemaining = 0;
        for (const hit of damages) {
            const mitigates = (t) =>
                t === 'mit_all' ||
                (t === 'mit_physical' && hit.type === '物理') ||
                (t === 'mit_magic' && hit.type === '魔法');
            let dmg = hit.amount * (passiveMult[hit.type] ?? passiveMult._other);
            // 以 passiveAppliedNames 為初始值，確保 passive/active 同名去重的行為不變
            const appliedNames = new Set(passiveAppliedNames);
            for (const skill of nonPassiveSkills) {
                const castTimes = ctx.timesByInstance.get(skill.instanceId);
                if (!castTimes || !castTimes.length) continue;
                if (appliedNames.has(skill.name)) continue;
                const activeCastTime = castTimes.find(ct => rowTime >= ct && rowTime <= ct + skill.duration);
                if (activeCastTime == null) continue;
                let applied = false;
                for (const effect of skill.effects) {
                    if (effect.duration != null && rowTime > activeCastTime + effect.duration) continue;
                    if (mitigates(effect.type) && effect.val != null) {
                        let effectVal = effect.val;
                        if (effect.bonusVal != null && effect.bonusRequiresIds?.length) {
                            const conditionMet = effect.bonusRequiresIds.some(reqId => {
                                const s = ctx.skillsByKey.get(`${reqId}|${skill.memberIndex}`);
                                return s && isSkillActive(ctx, s.instanceId, internalIdx, s);
                            });
                            if (conditionMet) effectVal += effect.bonusVal;
                        }
                        dmg *= (1 - effectVal);
                        applied = true;
                    }
                }
                if (applied) appliedNames.add(skill.name);
            }
            totalRemaining += dmg;
        }
        result[internalIdx] = Math.floor(totalRemaining);
    }
    return result;
}

function buildShieldCoverage(ctx) {
    const flat = ctx.rows;
    const times = flat.map(r => r.time);
    const postMitDmg = ctx.damageByRow;
    const absorption = new Array(flat.length).fill(0);
    const depletionAt = new Map();
    const shields = [];
    const nssShields = []; // 僅含 NSS 護盾的參考陣列，供快速過濾用

    // 秘策（sch_rec）是一次性消耗：同一窗口內，四招中任何一招的第一次施放就消耗掉效果，
    // 後續施放不再套爆擊。這裡先跨技能掃描，找出每個秘策窗口內最早的合格施放時間。
    const recSkillByMember = new Map();
    for (const s of ctx.activeSkills) {
        if (s.id === 'sch_rec') recSkillByMember.set(s.memberIndex, s);
    }
    const recWindowFirstCast = new Map();
    for (const skill of ctx.activeSkills) {
        if (skill.recitationCritMult == null) continue;
        const recSkill = recSkillByMember.get(skill.memberIndex);
        if (!recSkill) continue;
        const recCastTimes = ctx.timesByInstance.get(recSkill.instanceId) || [];
        const recDuration = recSkill.duration ?? 1;
        for (const ct of (ctx.timesByInstance.get(skill.instanceId) || [])) {
            const rt = recCastTimes.find(r => ct >= r && ct <= r + recDuration);
            if (rt === undefined) continue;
            const key = `${skill.memberIndex}-${rt}`;
            if (!recWindowFirstCast.has(key) || ct < recWindowFirstCast.get(key)) {
                recWindowFirstCast.set(key, ct);
            }
        }
    }

    // 活化（sge_Zoe）是一次性消耗：套用 zoeConsumptionByMember 算出的「最早合格施放時間」
    const zoeSkillByMember = new Map();
    for (const s of ctx.activeSkills) {
        if (s.id === 'sge_Zoe') zoeSkillByMember.set(s.memberIndex, s);
    }
    const zoeWindowFirstCast = ctx.zoeConsumptionByMember;

    for (const skill of ctx.activeSkills) {
        if (!skill.effects?.some(e => SHIELD_EFFECT_TYPES.has(e.type))) continue;
        const casts = skill.casts || [];
        if (!casts.length) continue;
        const critMult = skill.recitationCritMult ?? null;
        let recCastTimes = [];
        let recDuration = 1;
        if (critMult !== null) {
            const recSkill = recSkillByMember.get(skill.memberIndex);
            if (recSkill) {
                recCastTimes = ctx.timesByInstance.get(recSkill.instanceId) || [];
                recDuration = recSkill.duration ?? 1;
            }
        }
        for (let ci = 0; ci < casts.length; ci++) {
            const cast = casts[ci];
            const ct = cast.time;
            const dur = skill.upgradeSkillId ? getTpcEffectiveDuration(ctx, skill, cast) : skill.duration;
            if (dur <= 0) continue; // TPC 被同秒 TPG 立即消耗，跳過
            const endTime = ct + dur;
            let healOutMult = getHealOutMult(ctx, skill.memberIndex, ct);
            if (skill.zoeHealMult != null) {
                const zoeSkill = zoeSkillByMember.get(skill.memberIndex);
                const zoeCastTimes = zoeSkill ? (ctx.timesByInstance.get(zoeSkill.instanceId) || []) : [];
                const zoeDuration = zoeSkill?.duration ?? 30;
                const zt = zoeCastTimes.find(z => ct >= z && ct <= z + zoeDuration);
                if (zt !== undefined && zoeWindowFirstCast.get(`${skill.memberIndex}-${zt}`) === ct) {
                    healOutMult *= skill.zoeHealMult;
                }
            }
            let shieldVal = calcShieldValue(ctx, skill, healOutMult, ct);
            if (shieldVal <= 0) continue;
            if (critMult !== null) {
                const recWindowStart = recCastTimes.find(rt => ct >= rt && ct <= rt + recDuration);
                if (recWindowStart !== undefined) {
                    // 只有四招中「最先施放」的那一個才套爆擊（跨技能判斷）
                    const windowKey = `${skill.memberIndex}-${recWindowStart}`;
                    if (recWindowFirstCast.get(windowKey) === ct) {
                        shieldVal = Math.floor(shieldVal * critMult);
                    }
                }
            }
            const exclusiveEnd = !!skill.upgradeSkillId;
            // 血印/泛血印（stacks > 1）：初始護盾是額外的一層，另外附加 stacks 階血印狀態；
            // 每次判定只跟「當前這一層」的剩餘值比較，傷害超過護盾剩餘值才會破盾，
            // 且破盾當下只吸收該層剩餘的量（超出部分直接穿透），破盾後消耗 1 階血印原地補滿供下一擊使用，
            // 直到 stacks 階血印全部用完或效果時間結束為止（初始層 + stacks 層血印 = 共 1+stacks 次護盾）。
            const stackCount = skill.effects.find(e => e.type === 'shield_potency')?.stacks || 1;
            shields.push({
                key: `${skill.instanceId}-${ci}`, castTime: ct, endTime, remaining: shieldVal,
                depletionRowIdx: null, exclusiveEnd,
                layerAmount: stackCount > 1 ? shieldVal : null,
                layersLeft: stackCount > 1 ? stackCount : 0,
            });
        }
    }
    // 中間學派護盾（吉星相位 / 陽星合相 在中間學派效果內施放時附加的護盾）
    for (const skill of ctx.activeSkills) {
        if (!skill.neutralSectShield) continue;
        const casts = skill.casts || [];
        if (!casts.length) continue;
        const healerMnd = getHealerMnd(ctx, skill);
        if (!healerMnd) continue;
        const nss = skill.neutralSectShield;
        for (let ci = 0; ci < casts.length; ci++) {
            const ct = casts[ci].time;
            if (!isNeutralSectActive(ctx, skill.memberIndex, ct)) continue;
            const healOutMult = getHealOutMult(ctx, skill.memberIndex, ct);
            const healAmount = Math.floor(nss.val * (healerMnd * HEALER_MIND_SCALING) * healOutMult);
            const shieldVal = Math.floor(healAmount * nss.shieldRatio);
            if (shieldVal <= 0) continue;
            const endTime = ct + nss.duration;
            const nssEntry = { key: `${skill.instanceId}-nss-${ci}`, castTime: ct, endTime, remaining: shieldVal, depletionRowIdx: null, exclusiveEnd: false, isNSS: true, memberIndex: skill.memberIndex, initialShieldVal: shieldVal };
            shields.push(nssEntry);
            nssShields.push(nssEntry);
        }
    }
    for (let i = 0; i < flat.length; i++) {
        if (flat[i].isCustom) continue;
        if (ctx.hideTargeted && flat[i].isTargeted) continue;
        const rowTime = times[i];
        const rowDmg = postMitDmg[i];
        if (!rowDmg) continue;
        let remainingDmg = rowDmg;
        // 中間學派護盾不疊加：同成員的 NSS 護盾僅取初始值最高者（吉星相位優先於陽星合相）
        const nssMaxByMember = new Map();
        for (const sh of nssShields) {
            if (sh.depletionRowIdx !== null) continue;
            if (rowTime < sh.castTime || rowTime > sh.endTime) continue;
            const cur = nssMaxByMember.get(sh.memberIndex);
            if (!cur || sh.initialShieldVal > cur.initialShieldVal) nssMaxByMember.set(sh.memberIndex, sh);
        }
        for (const sh of shields) {
            if (sh.depletionRowIdx !== null || remainingDmg <= 0) continue;
            if (rowTime < sh.castTime || (sh.exclusiveEnd ? rowTime >= sh.endTime : rowTime > sh.endTime)) continue;
            if (sh.isNSS && nssMaxByMember.get(sh.memberIndex) !== sh) continue;
            const absorbed = Math.min(sh.remaining, remainingDmg);
            sh.remaining -= absorbed;
            remainingDmg -= absorbed;
            absorption[i] += absorbed;
            if (sh.remaining <= 0) {
                // 血印/泛血印：破盾當下只吸收該層剩餘的量（超出部分已在上面直接穿透到 remainingDmg），
                // 若還有血印可用就原地補滿供下一擊使用，不會讓同一擊繼續吃到新補的層
                if (sh.layersLeft > 0) {
                    sh.layersLeft -= 1;
                    sh.remaining = sh.layerAmount;
                    continue;
                }
                sh.depletionRowIdx = i;
                // NSS 護盾破盾時，同成員且當下同樣生效中的其他 NSS 護盾一併消除（不疊加規則）
                if (sh.isNSS) {
                    for (const other of nssShields) {
                        if (other.memberIndex === sh.memberIndex && other !== sh
                            && other.depletionRowIdx === null
                            && rowTime >= other.castTime && rowTime <= other.endTime) {
                            other.depletionRowIdx = i;
                        }
                    }
                }
            }
        }
    }
    for (const sh of shields) depletionAt.set(sh.key, sh.depletionRowIdx);
    return { absorption, depletionAt };
}

export const calculateDamage = (ctx, internalIdx) => {
    const base = ctx.damageByRow[internalIdx] ?? 0;
    const absorbed = ctx.shieldCoverage.absorption[internalIdx] ?? 0;
    return Math.max(0, base - absorbed);
};

// 預計傷害欄懸浮卡片用：原始傷害 × 減傷率 − 護盾 = 預計傷害
export const getDamageBreakdown = (ctx, internalIdx) => {
    const raw = ctx.rawDamageByRow[internalIdx] ?? 0;
    const mitigated = ctx.damageByRow[internalIdx] ?? 0;
    const absorbed = ctx.shieldCoverage.absorption[internalIdx] ?? 0;
    const final = calculateDamage(ctx, internalIdx);
    const mitMultiplier = raw > 0 ? mitigated / raw : 1;
    return { raw, mitigated, absorbed, final, mitRate: 1 - mitMultiplier, mitMultiplier };
};

// ── 技能啟用 / 冷卻狀態 ───────────────────────────────────────

export const isSkillActive = (ctx, skillInstanceId, internalIdx, skill) => {
    if (skill.passive) return true;
    const casts = skill.casts || [];
    if (!casts.length) return false;
    const rowTime = ctx.rows[internalIdx].time;
    const pureShield = isPureShieldSkill(skill);
    return casts.some((cast, ci) => {
        const dur = skill.upgradeSkillId ? getTpcEffectiveDuration(ctx, skill, cast)
            : skill.id === 'sge_Zoe' ? getZoeEffectiveDuration(ctx, skill, cast.time)
            : skill.duration;
        // upgradeSkillId 技能（TPC）被 TPG 施放時立即消耗，用嚴格小於避免邊界重疊
        const inWindow = skill.upgradeSkillId
            ? (rowTime >= cast.time && rowTime < cast.time + dur)
            : (rowTime >= cast.time && rowTime <= cast.time + dur);
        if (!inWindow) return false;
        if (pureShield) {
            const depletionIdx = ctx.shieldCoverage.depletionAt.get(`${skillInstanceId}-${ci}`);
            if (depletionIdx != null && rowTime > ctx.rows[depletionIdx].time) return false;
        }
        return true;
    });
};

// duration > cooldown 的技能（如陽星合相），在冷卻結束後但效果仍在時允許重新施放以延長
export const isSkillRecastable = (ctx, skillInstanceId, internalIdx, skill) => {
    if (skill.passive || skill.multiState || skill.charges > 1 || skill.togglesWithId || skill.conditionOnce) return false;
    if (!skill.duration || !skill.cooldown || skill.duration <= skill.cooldown) return false;
    const casts = skill.casts || [];
    if (!casts.length) return false;
    const rowTime = ctx.rows[internalIdx].time;
    return casts.some(cast => {
        const diff = rowTime - cast.time;
        return diff >= skill.cooldown && diff <= skill.duration;
    });
};

// 判斷技能在指定列是否處於冷卻中，需處理多種複雜情境：
//   - togglesWithId：成對技能的冷卻狀態需參照配對技能的施放時間
//   - sharedCooldownId：共享冷卻時間的技能（如任何一個在冷卻中則判定為冷卻）
//   - conditionOnce：在條件技能的時間窗內只允許施放一次
//   - charges > 1：多充能技能，充能歸零才算冷卻
export const isSkillOnCooldown = (ctx, skillInstanceId, internalIdx, skill) => {
    const myCasts = skill.casts || [];
    const rowTime = ctx.rows[internalIdx].time;

    if (skill.togglesWithId) {
        const pairedSkill = ctx.skillsByKey.get(`${skill.togglesWithId}|${skill.memberIndex}`);
        const ownOnCooldown = myCasts.some(cast => {
            const diff = rowTime - cast.time;
            return diff > skill.duration && diff < skill.cooldown;
        });
        if (ownOnCooldown) return true;
        const myCount = myCasts.filter(cast => cast.time < rowTime).length;
        const pairedCastTimes = pairedSkill
            ? (ctx.timesByInstance.get(pairedSkill.instanceId) || []).filter(t => t < rowTime)
            : [];
        let parityCorrect;
        if (skill.isFirstToggle) {
            parityCorrect = myCount === pairedCastTimes.length;
        } else {
            parityCorrect = myCount < pairedCastTimes.length;
        }
        if (!parityCorrect) return false;
        if (pairedCastTimes.length > 0) {
            const lastPaired = Math.max(...pairedCastTimes);
            const pairedCooldown = pairedSkill?.cooldown ?? skill.cooldown;
            return rowTime < lastPaired + pairedCooldown;
        }
        return false;
    }

    if (skill.sharedCooldownId) {
        const pairedSkill = ctx.skillsByKey.get(`${skill.sharedCooldownId}|${skill.memberIndex}`);
        if (pairedSkill) {
            const pairedCastTimes = ctx.timesByInstance.get(pairedSkill.instanceId) || [];
            const sharedOnCooldown = pairedCastTimes.some(ct => {
                const diff = rowTime - ct;
                return diff >= 0 && diff < pairedSkill.cooldown;
            });
            if (sharedOnCooldown) return true;
        }
    }

    if (!myCasts.length) return false;

    if (skill.charges > 1) {
        if (isSkillActive(ctx, skillInstanceId, internalIdx, skill)) return false;
        return chargesAvailableAt(ctx, skillInstanceId, rowTime, skill) === 0;
    }

    if (skill.multiState && skill.upgradeSkillId) {
        return myCasts.some((cast, ci) => {
            const diff = rowTime - cast.time;
            if (diff < 0) return false;
            const effectiveDuration = getTpcEffectiveDuration(ctx, skill, cast);
            const effectiveCd = getTpcEffectiveCooldown(ctx, skill, cast, ci);
            if (diff >= effectiveDuration && diff < effectiveCd) return true;
            // 護盾耗盡後，在 CD 結束前也顯示為冷卻中
            const depletionIdx = ctx.shieldCoverage.depletionAt.get(`${skillInstanceId}-${ci}`);
            return depletionIdx != null && rowTime > ctx.rows[depletionIdx].time && diff < effectiveCd;
        });
    }

    return myCasts.some((cast, ci) => {
        const diff = rowTime - cast.time;
        const effDuration = skill.id === 'sge_Zoe' ? getZoeEffectiveDuration(ctx, skill, cast.time) : skill.duration;
        if (diff > effDuration && diff < skill.cooldown) return true;
        if (isPureShieldSkill(skill)) {
            const depletionIdx = ctx.shieldCoverage.depletionAt.get(`${skillInstanceId}-${ci}`);
            return depletionIdx != null && rowTime > ctx.rows[depletionIdx].time && diff >= 0 && diff < skill.cooldown;
        }
        return false;
    });
};
