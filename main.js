const { createApp, ref, computed, watch, onMounted, nextTick } = Vue;

const MEMBER_COLORS = [
    { bg: '#eff6ff', border: '#3b82f6', headerBg: '#dbeafe' },
    { bg: '#f0fdf4', border: '#22c55e', headerBg: '#dcfce7' },
    { bg: '#faf5ff', border: '#a855f7', headerBg: '#f3e8ff' },
    { bg: '#fffbeb', border: '#f59e0b', headerBg: '#fef3c7' },
    { bg: '#fff1f2', border: '#f43f5e', headerBg: '#ffe4e6' },
    { bg: '#ecfeff', border: '#06b6d4', headerBg: '#cffafe' },
    { bg: '#fff7ed', border: '#f97316', headerBg: '#ffedd5' },
    { bg: '#f0fdfa', border: '#14b8a6', headerBg: '#ccfbf1' },
];

const DAMAGE_TYPE_ICONS = {
    '物理': 'src/Damage_type/physical.png',
    '魔法': 'src/Damage_type/magical.png',
    '特殊': 'src/Damage_type/unique.png',
    '即死': 'src/Damage_type/unique.png'
};

const TARGETED_LABELS = new Set(['普通攻擊', '點名', '死刑']);

const _timeCache = Object.create(null);
const timeToSeconds = (t) => {
    if (!t) return 0;
    if (t in _timeCache) return _timeCache[t];
    const str = String(t).trim();
    const isNegative = str.startsWith('-');
    const cleanStr = isNegative ? str.slice(1) : str;
    const parts = cleanStr.split(':').map(Number);
    const totalSeconds = (parts[0] || 0) * 60 + (parts[1] || 0);
    return (_timeCache[t] = isNegative ? -totalSeconds : totalSeconds);
};

const secondsToTime = (totalSecs) => {
    const isNegative = totalSecs < 0;
    const abs = Math.abs(Math.round(totalSecs));
    const minutes = Math.floor(abs / 60);
    const seconds = abs % 60;
    const sign = isNegative ? '-' : '';
    return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
};

// 驗證並正規化時間輸入為 "M:SS"，若格式錯誤（秒數不在 0-59）則回傳 null
const normalizeTimeInput = (t) => {
    if (!t || !t.trim()) return null;
    const str = t.trim();
    const isNegative = str.startsWith('-');
    const cleanStr = isNegative ? str.slice(1) : str;
    const parts = cleanStr.split(':');
    if (parts.length !== 2) return null;
    const minutes = parseInt(parts[0], 10);
    const seconds = parseInt(parts[1], 10);
    if (isNaN(minutes) || isNaN(seconds) || seconds < 0 || seconds > 59) return null;
    const sign = isNegative ? '-' : '';
    return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
};

let _crCounter = 0;
const newCustomId = () => `cr${Date.now()}${_crCounter++}`;

let _insertHideTimer = null;

// ── Worker URL（部署後請替換為你的 Worker 網址）────────────────
const WORKER_URL = 'https://mit-planner.ffxivmit.workers.dev';

createApp({
    setup() {
        const categoryDb = ref({});
        const jobDb = ref({});
        const dutyDb = ref({});
        const dutyIndex = ref({ categories: {}, duties: [] });

        const selectedDutyKey = ref('');
        const party = ref([]);
        const mitMap = ref({});
        const hideNonDmg = ref(false);
        const hideTargeted = ref(false);
        const currentCat = ref('Tank');
        const settingsOpen = ref(false);
        const compactMode = ref(true);
        const selectedVariants = ref({});
        const expandedPersonalMembers = ref([]);
        const shareToastVisible = ref(false);
        const shareLoading = ref(false);
        const isViewingSharedPlan = ref(false);

        const dutyDropdownOpen = ref(false);
        const expandedCategories = ref({});

        const skillTooltip = ref({ skill: null, x: 0, y: 0 });
        const showSkillTooltip = (skill, event) => {
            if (!skill.title && !skill.conditionSkillId && !skill.blockedBySkillId && skill.charges <= 1 && !skill.duration && !skill.cooldown) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const tooltipWidth = 240;
            let x = rect.left + rect.width / 2;
            x = Math.max(tooltipWidth / 2 + 8, Math.min(x, window.innerWidth - tooltipWidth / 2 - 8));
            skillTooltip.value = { skill, x, y: rect.bottom + 8 };
        };
        const hideSkillTooltip = () => { skillTooltip.value.skill = null; };

        // 自訂時間軸列，以副本 key 為索引分別儲存
        const customRowsByDuty = ref({});
        // 使用者輸入中尚未驗證的時間暫存值，避免 Vue 強制覆蓋正在打字的 input
        const customRowDraftTimes = ref({});

        // ── URL params ────────────────────────────────────────
        const readUrlParams = () => {
            const params = new URLSearchParams(window.location.search);
            if (params.has('hideNoDmg')) {
                hideNonDmg.value = params.get('hideNoDmg') === '1';
            }
            if (params.has('hideTargeted')) {
                hideTargeted.value = params.get('hideTargeted') === '1';
            }
            if (params.has('compact')) {
                compactMode.value = params.get('compact') !== '0';
            }
        };

        const syncUrlParams = () => {
            const params = new URLSearchParams(window.location.search);
            if (hideNonDmg.value) {
                params.set('hideNoDmg', '1');
            } else {
                params.delete('hideNoDmg');
            }
            if (hideTargeted.value) {
                params.set('hideTargeted', '1');
            } else {
                params.delete('hideTargeted');
            }
            if (!compactMode.value) {
                params.set('compact', '0');
            } else {
                params.delete('compact');
            }
            const qs = params.toString();
            const queryString = qs ? '?' + qs : '';
            history.replaceState(null, '', window.location.pathname + queryString);
        };

        // ── Custom rows ───────────────────────────────────────
        const customRows = computed(() => {
            return customRowsByDuty.value[selectedDutyKey.value] || [];
        });

        // 將副本原始時間軸與自訂列合併為一個扁平陣列（自訂列附加在後）
        const allRowsFlat = computed(() => {
            const duty = dutyDb.value[selectedDutyKey.value]?.timeline || [];
            const custom = customRows.value.map(cr => ({
                hitTime: cr.hitTime,
                skill: cr.skill,
                phase: '',
                damage: [],
                _isCustom: true,
                _customId: cr.id,
            }));
            return [...duty, ...custom];
        });

        const currentTimeline = computed(() => {
            return allRowsFlat.value
                .map((row, idx) => ({ ...row, _internalIdx: idx }))
                .sort((a, b) => timeToSeconds(a.hitTime) - timeToSeconds(b.hitTime));
        });

        // 在兩列之間插入自訂列，時間預設為中間值；若無前後列則各加減 5 秒
        // 插入後自動聚焦時間輸入框讓使用者立即編輯
        const insertCustomRowBetween = (timeBefore, timeAfter) => {
            let suggestedSecs;
            if (timeBefore == null) {
                suggestedSecs = timeToSeconds(timeAfter) - 5;
            } else if (timeAfter == null) {
                suggestedSecs = timeToSeconds(timeBefore) + 5;
            } else {
                const t1 = timeToSeconds(timeBefore);
                const t2 = timeToSeconds(timeAfter);
                suggestedSecs = Math.floor((t1 + t2) / 2);
                if (suggestedSecs <= t1) suggestedSecs = t1 + 1;
                if (suggestedSecs >= t2) suggestedSecs = t2 - 1;
            }
            if (!customRowsByDuty.value[selectedDutyKey.value]) {
                customRowsByDuty.value[selectedDutyKey.value] = [];
            }
            const id = newCustomId();
            customRowsByDuty.value[selectedDutyKey.value].push({
                id,
                hitTime: secondsToTime(suggestedSecs),
                skill: '',
                phase: '',
            });
            nextTick(() => {
                const input = document.querySelector(`input[data-time-id="${id}"]`);
                if (input) {
                    input.select();
                    input.focus();
                }
            });
        };

        // 刪除自訂列，並修正 mitMap 中所有受影響的 internalIdx（大於被刪除索引的都要 -1）
        const removeCustomRow = (customId) => {
            const rows = customRowsByDuty.value[selectedDutyKey.value];
            if (!rows) return;
            const crIdx = rows.findIndex(cr => cr.id === customId);
            if (crIdx < 0) return;
            const dutyLen = (dutyDb.value[selectedDutyKey.value]?.timeline || []).length;
            const removedIdx = dutyLen + crIdx;
            const prefix = selectedDutyKey.value + '-';
            const newMap = { ...mitMap.value };
            for (const [key, castArr] of Object.entries(newMap)) {
                if (!key.startsWith(prefix)) continue;
                const updated = castArr
                    .filter(i => i !== removedIdx)
                    .map(i => {
                        if (i > removedIdx) {
                            return i - 1;
                        }
                        return i;
                    });
                if (!updated.length) {
                    delete newMap[key];
                } else {
                    newMap[key] = updated;
                }
            }
            mitMap.value = newMap;
            rows.splice(crIdx, 1);
        };

        const updateCustomRow = (customId, field, value) => {
            const rows = customRowsByDuty.value[selectedDutyKey.value];
            if (!rows) return;
            const row = rows.find(cr => cr.id === customId);
            if (row) row[field] = value;
        };

        // 輸入中同步暫存值，防止 Vue 的 :value 綁定在打字過程中強制重設 DOM
        const onCustomRowTimeInput = (customId, value) => {
            customRowDraftTimes.value[customId] = value;
        };

        // 離開輸入框時驗證：空白則刪除該列，格式正確則正規化存入，錯誤則還原舊值
        const onCustomRowTimeBlur = (customId, value) => {
            delete customRowDraftTimes.value[customId];
            if (!value || !value.trim()) {
                removeCustomRow(customId);
                return;
            }
            const normalized = normalizeTimeInput(value);
            if (normalized !== null) {
                updateCustomRow(customId, 'hitTime', normalized);
            }
        };

        // ── Row visibility ────────────────────────────────────
        // 判斷時間軸列是否顯示：自訂列永遠顯示；原始列依「隱藏無傷害」與「隱藏點名」篩選
        const isRowVisible = (row, internalIdx) => {
            if (!row) return false;
            if (row._isCustom) return true;
            if (hideNonDmg.value && !hasOriginalDamage(row, internalIdx)) return false;
            if (hideTargeted.value && isTargetedAttack(row, internalIdx)) return false;
            return true;
        };

        // ── Floating insert button ────────────────────────────
        const hoverInsert = ref(null);

        // 找出指定顯示列的前後最近可見列的 hitTime，用於計算插入列的預設時間
        const getVisibleNeighbors = (displayIdx) => {
            const ct = currentTimeline.value;
            let prevTime = null;
            let nextTime = null;
            for (let i = displayIdx - 1; i >= 0; i--) {
                if (isRowVisible(ct[i], ct[i]._internalIdx)) {
                    prevTime = ct[i].hitTime;
                    break;
                }
            }
            for (let i = displayIdx + 1; i < ct.length; i++) {
                if (isRowVisible(ct[i], ct[i]._internalIdx)) {
                    nextTime = ct[i].hitTime;
                    break;
                }
            }
            return { prevTime, nextTime };
        };

        // 滑鼠在列上移動時，根據游標位置（上半／下半）決定插入按鈕顯示在列的上方或下方
        const onRowMouseMove = (row, displayIdx, event) => {
            if (!isRowVisible(row, row._internalIdx)) return;
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && event.currentTarget.contains(active)) return;
            clearTimeout(_insertHideTimer);
            const tr = event.currentTarget;
            const rect = tr.getBoundingClientRect();
            const isTop = event.clientY - rect.top < rect.height / 2;
            const { prevTime, nextTime } = getVisibleNeighbors(displayIdx);
            if (isTop) {
                hoverInsert.value = {
                    timeBefore: prevTime,
                    timeAfter: row.hitTime,
                    x: rect.left + 40,
                    y: rect.top,
                };
            } else {
                hoverInsert.value = {
                    timeBefore: row.hitTime,
                    timeAfter: nextTime,
                    x: rect.left + 40,
                    y: rect.bottom,
                };
            }
        };

        const onRowMouseLeave = () => {
            _insertHideTimer = setTimeout(() => { hoverInsert.value = null; }, 100);
        };

        const onInsertBtnEnter = () => {
            clearTimeout(_insertHideTimer);
        };

        const onInsertBtnLeave = () => {
            hoverInsert.value = null;
        };

        // ── Row helpers ───────────────────────────────────────
        // 取得當前選用的技能變體（isRandom 技能有多個傷害變體可切換，否則直接回傳原始列）
        const getEffectiveVariant = (row, internalIdx) => {
            if (!row.isRandom || !row.variants) {
                return row;
            }
            const variantKey = `${selectedDutyKey.value}-${internalIdx}`;
            const idx = selectedVariants.value[variantKey] || 0;
            const variant = row.variants[idx];
            if (variant !== undefined) {
                return variant;
            }
            return row;
        };

        const hasOriginalDamage = (row, internalIdx) => {
            if (row._isCustom) return false;
            return (getEffectiveVariant(row, internalIdx).damage?.length ?? 0) > 0;
        };

        const isTargetedAttack = (row, internalIdx) => {
            if (row._isCustom) return false;
            const damages = getEffectiveVariant(row, internalIdx).damage || [];
            return damages.length > 0 && damages.every(d => TARGETED_LABELS.has(d.label));
        };

        const getDamageTypeIconByType = (type) => DAMAGE_TYPE_ICONS[type] ?? null;

        const getDamageTypeIcon = (row, internalIdx) =>
            row._isCustom ? null : getDamageTypeIconByType(getEffectiveVariant(row, internalIdx).type);

        // ── Skill cast state helpers ──────────────────────────
        // 產生 mitMap 的 key，格式為 "dutyKey-skillInstanceId"
        const mitKeyForSkill = (skillInstanceId) => {
            return `${selectedDutyKey.value}-${skillInstanceId}`;
        };

        const getCastRows = (skillInstanceId) => {
            const key = mitKeyForSkill(skillInstanceId);
            return mitMap.value[key] || [];
        };

        // 根據已排序的施放時間點，計算每次施放後充能恢復的時刻
        // 邏輯：每次恢復時間 = max(上次恢復時間, 施放時間) + 充能冷卻
        const computeChargeRestoreTimes = (sortedCastTimes, rechargeTime) => {
            const restoreTimes = [];
            let lastRestore = -Infinity;
            for (const ct of sortedCastTimes) {
                lastRestore = Math.max(ct, lastRestore) + rechargeTime;
                restoreTimes.push(lastRestore);
            }
            return restoreTimes;
        };

        // 計算在指定時間點（checkTime）時技能剩餘的充能數（用於插入前向衝突的模擬驗算）
        const chargesAvailableAtTime = (checkTime, skill, sortedContextTimes) => {
            const castsBefore = sortedContextTimes.filter(ct => ct < checkTime);
            if (!castsBefore.length) {
                return skill.charges;
            }
            const restoreTimes = computeChargeRestoreTimes(castsBefore, skill.cooldown);
            const inRecharge = castsBefore.filter((_ct, i) => checkTime < restoreTimes[i]).length;
            return Math.max(0, skill.charges - inRecharge);
        };

        // 計算在某個時間軸列時，技能實際剩餘充能數（根據 mitMap 中該技能的所有施放記錄推算）
        const chargesAvailableAt = (skillInstanceId, rowTime, skill) => {
            const castRows = getCastRows(skillInstanceId);
            const flat = allRowsFlat.value;
            const castTimes = castRows
                .map(ci => timeToSeconds(flat[ci]?.hitTime))
                .filter(ct => ct < rowTime);
            if (!castTimes.length) {
                return skill.charges;
            }
            const restoreTimes = computeChargeRestoreTimes(castTimes, skill.cooldown);
            const inRecharge = castTimes.filter((_ct, i) => rowTime < restoreTimes[i]).length;
            return Math.max(0, skill.charges - inRecharge);
        };

        // 判斷技能的「前提條件」是否滿足，涵蓋三種情境：
        //   1. togglesWithId：成對開關技能，依施放次數奇偶交替（isFirstToggle 決定先後順序）
        //   2. conditionDuration：需要在某個條件技能的效果時間窗內才可施放
        //   3. conditionSkillId（無 duration）：需要條件技能目前處於效果中
        const isSkillConditionMet = (skill, internalIdx) => {
            const flat = allRowsFlat.value;
            const rowTime = timeToSeconds(flat[internalIdx]?.hitTime);
            if (skill.togglesWithId) {
                const pairedSkill = activeSkills.value.find(s =>
                    s.id === skill.togglesWithId && s.memberIndex === skill.memberIndex
                );
                const myCount = getCastRows(skill.instanceId)
                    .filter(ci => timeToSeconds(flat[ci]?.hitTime) < rowTime).length;
                let pairedCount = 0;
                if (pairedSkill) {
                    pairedCount = getCastRows(pairedSkill.instanceId)
                        .filter(ci => timeToSeconds(flat[ci]?.hitTime) < rowTime).length;
                }
                if (skill.isFirstToggle) {
                    return myCount === pairedCount;
                }
                return myCount < pairedCount;
            }
            if (!skill.conditionSkillId) return true;
            if (skill.conditionDuration != null) {
                return activeSkills.value.some(condSkill => {
                    if (condSkill.id !== skill.conditionSkillId) return false;
                    if (condSkill.memberIndex !== skill.memberIndex) return false;
                    return getCastRows(condSkill.instanceId).some(ci => {
                        const castTime = timeToSeconds(flat[ci]?.hitTime);
                        return rowTime >= castTime && rowTime <= castTime + skill.conditionDuration;
                    });
                });
            }
            return activeSkills.value.some(s =>
                s.id === skill.conditionSkillId &&
                s.memberIndex === skill.memberIndex &&
                isSkillActive(s.instanceId, internalIdx, s)
            );
        };

        const isSkillBlocked = (skill, internalIdx) => {
            if (!skill.blockedBySkillId) return false;
            return activeSkills.value.some(s =>
                s.id === skill.blockedBySkillId &&
                s.memberIndex === skill.memberIndex &&
                isSkillActive(s.instanceId, internalIdx, s)
            );
        };

        const isSkillActive = (skillInstanceId, internalIdx, skill) => {
            const castRows = getCastRows(skillInstanceId);
            if (!castRows.length) return false;
            const flat = allRowsFlat.value;
            const rowTime = timeToSeconds(flat[internalIdx]?.hitTime);
            return castRows.some(ci => {
                const castTime = timeToSeconds(flat[ci]?.hitTime);
                return rowTime >= castTime && rowTime <= castTime + skill.duration;
            });
        };

        // 判斷技能在指定列是否處於冷卻中，需處理多種複雜情境：
        //   - togglesWithId：成對技能的冷卻狀態需參照配對技能的施放時間
        //   - sharedCooldownId：共享冷卻時間的技能（如任何一個在冷卻中則判定為冷卻）
        //   - conditionOnce：在條件技能的時間窗內只允許施放一次
        //   - charges > 1：多充能技能，充能歸零才算冷卻
        const isSkillOnCooldown = (skillInstanceId, internalIdx, skill) => {
            const castRows = getCastRows(skillInstanceId);
            const flat = allRowsFlat.value;
            const rowTime = timeToSeconds(flat[internalIdx]?.hitTime);

            if (skill.togglesWithId) {
                const pairedSkill = activeSkills.value.find(s =>
                    s.id === skill.togglesWithId && s.memberIndex === skill.memberIndex
                );
                const ownOnCooldown = castRows.some(ci => {
                    const castTime = timeToSeconds(flat[ci]?.hitTime);
                    const diff = rowTime - castTime;
                    return diff > skill.duration && diff < skill.cooldown;
                });
                if (ownOnCooldown) return true;
                const myCount = castRows
                    .filter(ci => timeToSeconds(flat[ci]?.hitTime) < rowTime).length;
                let pairedCastTimes = [];
                if (pairedSkill) {
                    pairedCastTimes = getCastRows(pairedSkill.instanceId)
                        .map(ci => timeToSeconds(flat[ci]?.hitTime))
                        .filter(t => t < rowTime);
                }
                let parityCorrect;
                if (skill.isFirstToggle) {
                    parityCorrect = myCount === pairedCastTimes.length;
                } else {
                    parityCorrect = myCount < pairedCastTimes.length;
                }
                if (!parityCorrect) return false;
                if (pairedCastTimes.length > 0) {
                    const lastPaired = Math.max(...pairedCastTimes);
                    let pairedCooldown = skill.cooldown;
                    if (pairedSkill && pairedSkill.cooldown !== undefined) {
                        pairedCooldown = pairedSkill.cooldown;
                    }
                    return rowTime < lastPaired + pairedCooldown;
                }
                return false;
            }

            if (skill.sharedCooldownId) {
                const pairedSkill = activeSkills.value.find(s =>
                    s.id === skill.sharedCooldownId && s.memberIndex === skill.memberIndex
                );
                if (pairedSkill) {
                    const sharedOnCooldown = getCastRows(pairedSkill.instanceId).some(ci => {
                        const diff = rowTime - timeToSeconds(flat[ci]?.hitTime);
                        return diff >= 0 && diff < pairedSkill.cooldown;
                    });
                    if (sharedOnCooldown) return true;
                }
            }

            if (!castRows.length) return false;

            if (skill.conditionOnce && skill.conditionSkillId) {
                const condDuration = skill.conditionDuration;
                const condSkillInst = activeSkills.value.find(s =>
                    s.id === skill.conditionSkillId && s.memberIndex === skill.memberIndex
                );
                if (condSkillInst) {
                    for (const condCastIdx of getCastRows(condSkillInst.instanceId)) {
                        const condCastTime = timeToSeconds(flat[condCastIdx]?.hitTime);
                        let effectiveDuration;
                        if (condDuration !== null && condDuration !== undefined) {
                            effectiveDuration = condDuration;
                        } else {
                            effectiveDuration = condSkillInst.duration;
                        }
                        const windowEnd = condCastTime + effectiveDuration;
                        if (rowTime > condCastTime && rowTime <= windowEnd) {
                            const existingCastIdx = castRows.find(ci => {
                                if (ci === internalIdx) return false;
                                const ct = timeToSeconds(flat[ci]?.hitTime);
                                return ct >= condCastTime && ct <= windowEnd;
                            });
                            if (existingCastIdx != null) {
                                const existingCastTime = timeToSeconds(flat[existingCastIdx]?.hitTime);
                                if (rowTime > existingCastTime + skill.duration) return true;
                            }
                        }
                    }
                }
            }

            if (skill.charges > 1) {
                if (isSkillActive(skillInstanceId, internalIdx, skill)) return false;
                return chargesAvailableAt(skillInstanceId, rowTime, skill) === 0;
            }

            return castRows.some(ci => {
                const castTime = timeToSeconds(flat[ci]?.hitTime);
                const diff = rowTime - castTime;
                return diff > skill.duration && diff < skill.cooldown;
            });
        };

        const isSkillCastOrigin = (skillInstanceId, internalIdx) => {
            return getCastRows(skillInstanceId).includes(internalIdx);
        };

        // 切換技能在指定列的施放記錄（核心互動函式）
        // 取消施放：直接移除；新增施放：依序檢查前提、封鎖、乙太消耗、冷卻
        // 多充能技能：模擬插入後驗算後方施放是否會因充能不足產生衝突並詢問使用者
        // 單充能技能：若新施放點的冷卻覆蓋到後方已記錄的施放點，同樣詢問是否取消衝突
        const toggleSkillCast = (skillInstanceId, internalIdx, skill) => {
            const key = mitKeyForSkill(skillInstanceId);
            const castRows = [...(mitMap.value[key] || [])];
            const idx = castRows.indexOf(internalIdx);
            const flat = allRowsFlat.value;

            if (idx >= 0) {
                castRows.splice(idx, 1);
            } else {
                if (!isSkillConditionMet(skill, internalIdx)) return;
                if (isSkillBlocked(skill, internalIdx)) return;
                if (isSkillAetherDepleted(skill, internalIdx)) return;

                if (skill.charges > 1) {
                    const rowTime = timeToSeconds(flat[internalIdx]?.hitTime);
                    if (chargesAvailableAt(skillInstanceId, rowTime, skill) === 0) return;
                    const castsAfter = castRows
                        .filter(ci => timeToSeconds(flat[ci]?.hitTime) > rowTime)
                        .sort((a, b) => timeToSeconds(flat[a]?.hitTime) - timeToSeconds(flat[b]?.hitTime));
                    if (castsAfter.length > 0) {
                        const validTimes = castRows
                            .map(ci => timeToSeconds(flat[ci]?.hitTime))
                            .filter(ct => ct < rowTime)
                            .sort((a, b) => a - b);
                        validTimes.push(rowTime);
                        const forwardConflicts = [];
                        for (const ci of castsAfter) {
                            const ct = timeToSeconds(flat[ci]?.hitTime);
                            if (chargesAvailableAtTime(ct, skill, validTimes) > 0) {
                                validTimes.push(ct);
                            } else {
                                forwardConflicts.push(ci);
                            }
                        }
                        if (forwardConflicts.length > 0) {
                            const conflictTimes = forwardConflicts.map(ci => flat[ci]?.hitTime).join('、');
                            if (!confirm(`「${skill.name}」與較晚的施放點（${conflictTimes}）衝突，已自動取消衝突紀錄。`)) return;
                            forwardConflicts.forEach(ci => {
                                const i = castRows.indexOf(ci);
                                if (i >= 0) castRows.splice(i, 1);
                            });
                        }
                    }
                } else {
                    if (isSkillOnCooldown(skillInstanceId, internalIdx, skill)) return;
                    if (isSkillActive(skillInstanceId, internalIdx, skill)) return;
                    if (!skill.togglesWithId) {
                        const rowTime = timeToSeconds(flat[internalIdx]?.hitTime);
                        const forwardConflicts = castRows.filter(ci => {
                            const d = timeToSeconds(flat[ci]?.hitTime) - rowTime;
                            return d > 0 && d < skill.cooldown;
                        });
                        if (forwardConflicts.length > 0) {
                            const conflictTimes = forwardConflicts.map(ci => flat[ci]?.hitTime).join('、');
                            if (!confirm(`「${skill.name}」與較晚的施放點（${conflictTimes}）衝突，已自動取消衝突紀錄。`)) return;
                            forwardConflicts.forEach(ci => {
                                const i = castRows.indexOf(ci);
                                if (i >= 0) castRows.splice(i, 1);
                            });
                        }
                    }
                }

                castRows.push(internalIdx);
                castRows.sort((a, b) => a - b);
            }

            const newMap = { ...mitMap.value };
            if (castRows.length) {
                newMap[key] = castRows;
            } else {
                delete newMap[key];
            }
            mitMap.value = newMap;
        };

        // 逐列追蹤學者（SCH）乙太流（Aetherflow）的存量變化
        // 掃描整個時間軸，每次施放「補充乙太」技能 +N，施放「消耗乙太」技能 -N，上限 3
        // 結果為 { pIdx: [每列的乙太存量] } 的映射，供 isSkillAetherDepleted 查詢
        const aetherStacksByMember = computed(() => {
            const result = {};
            party.value.forEach((jobKey, pIdx) => {
                if (jobKey !== 'SCH') return;
                const jobEntry = jobDb.value[jobKey];
                if (!jobEntry || !jobEntry.skills) return;
                const flat = allRowsFlat.value;
                let stacks = 0;
                const byRow = [];
                for (let ri = 0; ri < flat.length; ri++) {
                    for (const skill of jobEntry.skills) {
                        if (!skill.aetherProvide && !skill.aetherCost) continue;
                        if (isSkillCastOrigin(`p${pIdx}-${skill.id}`, ri)) {
                            if (skill.aetherProvide) {
                                stacks = Math.min(3, stacks + skill.aetherProvide);
                            }
                            if (skill.aetherCost) {
                                stacks = Math.max(0, stacks - skill.aetherCost);
                            }
                        }
                    }
                    byRow.push(stacks);
                }
                result[pIdx] = byRow;
            });
            return result;
        });

        const getAetherStacksAt = (pIdx, internalIdx) =>
            aetherStacksByMember.value[pIdx]?.[internalIdx] ?? 0;

        const isSkillAetherDepleted = (skill, internalIdx) => {
            if (!skill.aetherCost) return false;
            const pIdx = skill.memberIndex - 1;
            return (aetherStacksByMember.value[pIdx]?.[internalIdx - 1] ?? 0) === 0;
        };

        // ── Data loading ──────────────────────────────────────
        // 舊版資料格式 mitMap 的 key 為 "dutyKey-rowIdx-skillInstId"，值為 true
        // 新版格式 key 為 "dutyKey-skillInstId"，值為施放列索引陣列
        // 此函式負責自動將舊格式轉換為新格式，確保向後相容
        const migrateLegacyMitMap = (rawMit) => {
            const newMit = {};
            for (const [key, val] of Object.entries(rawMit)) {
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
        };

        watch(selectedDutyKey, async (key) => {
            if (!key || dutyDb.value[key]) return;
            const entry = dutyIndex.value.duties.find(d => d.key === key);
            if (entry) {
                const res = await fetch(`src/duty/${entry.file}`);
                dutyDb.value[key] = await res.json();
            }
        });

        onMounted(async () => {
            try {
                const [catRes, skillsRes, indexRes] = await Promise.all([
                    fetch('src/jobs.json'),
                    fetch('src/skills.json'),
                    fetch('src/duty/index.json')
                ]);
                categoryDb.value = await catRes.json();
                jobDb.value = await skillsRes.json();
                dutyIndex.value = await indexRes.json();

                if (!await loadFromShareParam()) {
                    readUrlParams();
                    const saved = localStorage.getItem('ffxiv_planner_data');
                    if (saved) {
                        const parsed = JSON.parse(saved);
                        selectedDutyKey.value = parsed.selectedDutyKey || '';
                        party.value = parsed.party || [];
                        selectedVariants.value = parsed.selectedVariants || {};
                        customRowsByDuty.value = parsed.customRowsByDuty || {};
                        mitMap.value = migrateLegacyMitMap(parsed.mitMap || {});
                    }
                }
                initDefaultAetherflowForParty();
                syncStickyRow();
            } catch (err) {
                console.error("資料載入失敗，請確認檔案路徑是否正確 (src/)", err);
                alert("無法讀取 JSON 資料，請檢查控制台錯誤訊息。");
            }
        });

        // ── Party ─────────────────────────────────────────────
        const addToParty = (jobId) => {
            if (party.value.length < 8) {
                party.value.push(jobId);
            }
        };

        const removeFromParty = (index) => {
            party.value.splice(index, 1);
        };

        const togglePersonalSkills = (pIdx) => {
            const arr = expandedPersonalMembers.value;
            if (arr.includes(pIdx)) {
                expandedPersonalMembers.value = arr.filter(p => p !== pIdx);
            } else {
                expandedPersonalMembers.value = [...arr, pIdx];
            }
        };

        // ── Active skills ─────────────────────────────────────
        const activeSkillsByMember = computed(() => {
            const result = party.value.map((jobKey, pIdx) => {
                const jobEntry = jobDb.value[jobKey];
                if (!jobEntry || !jobEntry.skills) return null;
                const color = MEMBER_COLORS[pIdx % MEMBER_COLORS.length];
                const hasPersonalSkills = jobEntry.skills.some(s => s.personal);
                const showPersonal = expandedPersonalMembers.value.includes(pIdx);
                const filteredSkills = jobEntry.skills.filter(s => !s.personal || showPersonal);
                const mappedSkills = filteredSkills.map((s, sIdx) => ({
                    ...s,
                    instanceId: `p${pIdx}-${s.id}`,
                    memberIndex: pIdx + 1,
                    jobIcon: jobEntry.icon,
                    memberBg: color.bg,
                    memberBorder: color.border,
                    isFirstInGroup: sIdx === 0,
                }));
                if (jobKey === 'SCH' && showPersonal) {
                    mappedSkills.push({
                        id: '_aether',
                        instanceId: `p${pIdx}-_aether`,
                        name: '乙太存量',
                        _isAetherIndicator: true,
                        _pIdx: pIdx,
                        memberBg: color.bg,
                        memberBorder: color.border,
                        isFirstInGroup: false,
                        effects: [],
                    });
                }
                return {
                    pIdx,
                    memberIndex: pIdx + 1,
                    jobKey,
                    jobName: jobEntry.name,
                    jobIcon: jobEntry.icon,
                    color,
                    hasPersonalSkills,
                    showPersonal,
                    skills: mappedSkills,
                };
            });
            return result.filter(member => member !== null);
        });

        const activeSkills = computed(() => {
            return activeSkillsByMember.value.flatMap(m => m.skills);
        });

        // ── Damage calculation ────────────────────────────────
        // 計算套用所有作用中減傷技能後的剩餘傷害總量
        // 同名技能只計算一次（appliedNames 去重）；效果有 duration 限制時需檢查是否仍在效果窗內
        // 支援 bonusVal（如配對技能同時生效時的額外減傷加成）
        const calculateDamage = (row, internalIdx) => {
            if (!selectedDutyKey.value || row._isCustom) return 0;
            const damages = getEffectiveVariant(row, internalIdx).damage || [];
            if (!damages.length) return 0;
            const flat = allRowsFlat.value;
            let totalRemaining = 0;
            damages.forEach(hit => {
                let dmg = hit.amount;
                const appliedNames = new Set();
                activeSkills.value.forEach(skill => {
                    if (!isSkillActive(skill.instanceId, internalIdx, skill)) return;
                    if (appliedNames.has(skill.name)) return;
                    const castRows = getCastRows(skill.instanceId);
                    const rowTime = timeToSeconds(flat[internalIdx]?.hitTime);
                    const activeCastTime = castRows.reduce((found, ci) => {
                        if (found !== null) return found;
                        const ct = timeToSeconds(flat[ci]?.hitTime);
                        if (rowTime >= ct && rowTime <= ct + skill.duration) {
                            return ct;
                        }
                        return null;
                    }, null);
                    let applied = false;
                    skill.effects.forEach(effect => {
                        if (effect.duration != null && activeCastTime != null &&
                            rowTime > activeCastTime + effect.duration) return;
                        const t = effect.type;
                        const mitigates = t === 'mit_all' ||
                            (t === 'mit_physical' && hit.type === '物理') ||
                            (t === 'mit_magic'    && hit.type === '魔法');
                        if (mitigates && effect.val != null) {
                            let effectVal = effect.val;
                            const hasBonusRequirements = effect.bonusVal != null &&
                                Array.isArray(effect.bonusRequiresIds) &&
                                effect.bonusRequiresIds.length > 0;
                            if (hasBonusRequirements) {
                                const conditionMet = effect.bonusRequiresIds.some(reqId =>
                                    activeSkills.value.some(s =>
                                        s.id === reqId && s.memberIndex === skill.memberIndex &&
                                        isSkillActive(s.instanceId, internalIdx, s)
                                    )
                                );
                                if (conditionMet) effectVal += effect.bonusVal;
                            }
                            dmg *= (1 - effectVal);
                            applied = true;
                        }
                    });
                    if (applied) appliedNames.add(skill.name);
                });
                totalRemaining += dmg;
            });
            return Math.floor(totalRemaining);
        };

        // ── Variant switching ─────────────────────────────────
        const switchVariant = (internalIdx, variantIdx) => {
            selectedVariants.value[`${selectedDutyKey.value}-${internalIdx}`] = variantIdx;
        };

        const getSelectedVariantIdx = (internalIdx) =>
            selectedVariants.value[`${selectedDutyKey.value}-${internalIdx}`] ?? 0;

        // ── Aetherflow auto-init ──────────────────────────────
        // 根據時間軸自動計算乙太流的預設施放列
        // 規則：從第 0 秒開始，每 60 秒施放一次（選最早滿足時間的列）
        const computeDefaultAetherflowRows = () => {
            const sorted = allRowsFlat.value
                .map((row, idx) => ({ hitTime: row.hitTime, idx }))
                .sort((a, b) => timeToSeconds(a.hitTime) - timeToSeconds(b.hitTime));
            if (!sorted.length) return [];
            const rows = [];
            let nextCastTime = 0;
            for (const { hitTime, idx } of sorted) {
                const t = timeToSeconds(hitTime);
                if (t >= nextCastTime) {
                    rows.push(idx);
                    nextCastTime = t + 60;
                }
            }
            return rows;
        };

        const initDefaultAetherflowForParty = () => {
            if (!selectedDutyKey.value || !allRowsFlat.value.length) return;
            const newMap = { ...mitMap.value };
            let changed = false;
            party.value.forEach((jobKey, pIdx) => {
                if (jobKey !== 'SCH') return;
                const afKey = `${selectedDutyKey.value}-p${pIdx}-sch_af`;
                if (afKey in newMap) return;
                const rows = computeDefaultAetherflowRows();
                if (rows.length) {
                    newMap[afKey] = rows;
                    changed = true;
                }
            });
            if (changed) mitMap.value = newMap;
        };

        // ── Clear helpers ─────────────────────────────────────
        // 判斷指定技能實例是否有任何施放記錄（用於顯示清除按鈕）
        const skillHasAnyCast = (instanceId) =>
            (mitMap.value[mitKeyForSkill(instanceId)]?.length ?? 0) > 0;

        const memberHasAnyCast = (pIdx) => {
            const prefix = `${selectedDutyKey.value}-p${pIdx}-`;
            const afKey = `${selectedDutyKey.value}-p${pIdx}-sch_af`;
            return Object.keys(mitMap.value).some(key =>
                key.startsWith(prefix) && key !== afKey && mitMap.value[key].length > 0
            );
        };

        const clearSkill = (instanceId, skillName) => {
            const skill = activeSkills.value.find(s => s.instanceId === instanceId);
            let hasPair = false;
            if (skill && skill.togglesWithId) {
                hasPair = true;
            }
            let msg;
            if (hasPair) {
                msg = `確定要清除「${skillName}」及其配對技能的所有施放紀錄？`;
            } else {
                msg = `確定要清除「${skillName}」的所有施放紀錄？`;
            }
            if (!confirm(msg)) return;
            const key = mitKeyForSkill(instanceId);
            const newMap = { ...mitMap.value };
            if (key.endsWith('-sch_af')) {
                newMap[key] = [];
            } else {
                delete newMap[key];
            }
            if (hasPair) {
                const pIdxMatch = instanceId.match(/^p(\d+)-/);
                if (pIdxMatch !== null) {
                    const pIdx = pIdxMatch[1];
                    delete newMap[mitKeyForSkill(`p${pIdx}-${skill.togglesWithId}`)];
                }
            }
            mitMap.value = newMap;
        };

        const clearMember = (pIdx, jobName) => {
            if (!confirm(`確定要清除 ${jobName} 的所有施放紀錄？`)) return;
            const prefix = `${selectedDutyKey.value}-p${pIdx}-`;
            const newMap = { ...mitMap.value };
            for (const key of Object.keys(newMap)) {
                if (key.startsWith(prefix)) delete newMap[key];
            }
            mitMap.value = newMap;
            initDefaultAetherflowForParty();
        };

        const clearAll = () => {
            if (!confirm('確定要清除所有施放紀錄？此操作無法復原。')) return;
            mitMap.value = {};
            initDefaultAetherflowForParty();
        };

        // ── Share via Cloudflare Worker + KV ─────────────────
        const _applySharedData = (data) => {
            selectedDutyKey.value = data.duty || '';
            party.value = data.party || [];
            mitMap.value = migrateLegacyMitMap(data.mits || {});
            selectedVariants.value = data.selectedVariants || {};
            customRowsByDuty.value = data.customRowsByDuty || {};
            if (data.hideNonDmg !== undefined) hideNonDmg.value = data.hideNonDmg;
            if (data.hideTargeted !== undefined) hideTargeted.value = data.hideTargeted;
        };

        const loadFromShareParam = async () => {
            const id = new URLSearchParams(window.location.search).get('s');
            if (!id) return false;
            try {
                const res = await fetch(`${WORKER_URL}/load/${id}`);
                if (!res.ok) return false;
                const data = await res.json();
                isViewingSharedPlan.value = true;   // 必須在 _applySharedData 之前設定，確保 watcher 觸發時已有 flag
                _applySharedData(data);
                return true;
            } catch (e) {
                isViewingSharedPlan.value = false;
                console.error('載入分享連結失敗', e);
                return false;
            }
        };

        const saveSharedPlanToLocal = () => {
            isViewingSharedPlan.value = false;
            localStorage.setItem('ffxiv_planner_data', JSON.stringify({
                selectedDutyKey: selectedDutyKey.value,
                party: party.value,
                mitMap: mitMap.value,
                selectedVariants: selectedVariants.value,
                customRowsByDuty: customRowsByDuty.value,
            }));
            const params = new URLSearchParams(window.location.search);
            params.delete('s');
            const qs = params.toString();
            history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
        };

        let _toastTimer = null;
        const copyShareUrl = async () => {
            if (shareLoading.value) return;
            shareLoading.value = true;
            try {
                const payload = JSON.stringify({
                    duty: selectedDutyKey.value,
                    party: party.value,
                    mits: mitMap.value,
                    selectedVariants: selectedVariants.value,
                    customRowsByDuty: customRowsByDuty.value,
                    hideNonDmg: hideNonDmg.value,
                    hideTargeted: hideTargeted.value,
                });
                const res = await fetch(`${WORKER_URL}/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload,
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const { id } = await res.json();
                const url = `${window.location.origin}${window.location.pathname}?s=${id}`;
                try {
                    await navigator.clipboard.writeText(url);
                } catch {
                    prompt('複製以下連結：', url);
                }
                if (_toastTimer) clearTimeout(_toastTimer);
                shareToastVisible.value = true;
                _toastTimer = setTimeout(() => { shareToastVisible.value = false; }, 2500);
            } catch (e) {
                alert('分享連結產生失敗，請確認 Worker 是否已部署。');
            } finally {
                shareLoading.value = false;
            }
        };

        // ── Persistence ───────────────────────────────────────
        // 監聽所有需要持久化的狀態，任何變更都即時寫入 localStorage
        watch([selectedDutyKey, party, mitMap, selectedVariants, customRowsByDuty], () => {
            if (isViewingSharedPlan.value) return;
            localStorage.setItem('ffxiv_planner_data', JSON.stringify({
                selectedDutyKey: selectedDutyKey.value,
                party: party.value,
                mitMap: mitMap.value,
                selectedVariants: selectedVariants.value,
                customRowsByDuty: customRowsByDuty.value,
            }));
        }, { deep: true });

        watch([hideNonDmg, hideTargeted, compactMode], syncUrlParams);
        watch(selectedDutyKey, initDefaultAetherflowForParty);
        watch(party, initDefaultAetherflowForParty, { deep: true });

        // 動態對齊 row-skills 的 sticky top，避免因 inline 圖片 baseline 差距造成捲動抖動
        const syncStickyRow = () => {
            nextTick(() => {
                const rowGroup = document.querySelector('thead tr.row-group');
                if (!rowGroup) return;
                const h = Math.ceil(rowGroup.getBoundingClientRect().height);
                document.querySelectorAll('thead tr.row-skills th').forEach(th => {
                    th.style.top = h + 'px';
                });
            });
        };
        watch([party, activeSkillsByMember], syncStickyRow, { deep: false });

        const exportData = () => {
            const data = JSON.stringify({
                duty: selectedDutyKey.value,
                party: party.value,
                mits: mitMap.value,
                selectedVariants: selectedVariants.value,
                customRowsByDuty: customRowsByDuty.value,
            }, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `plan-${selectedDutyKey.value}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };

        const importData = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    selectedDutyKey.value = data.duty;
                    party.value = data.party || [];
                    mitMap.value = data.mits || {};
                    selectedVariants.value = data.selectedVariants || {};
                    customRowsByDuty.value = data.customRowsByDuty || {};
                } catch (err) {
                    alert("匯入格式錯誤");
                }
            };
            reader.readAsText(file);
        };

        const selectedDutyName = computed(() =>
            selectedDutyKey.value
                ? (dutyIndex.value.duties.find(d => d.key === selectedDutyKey.value)?.name ?? '選擇副本…')
                : '選擇副本…'
        );

        const openDutyDropdown = () => {
            if (!dutyDropdownOpen.value && selectedDutyKey.value) {
                const duty = dutyIndex.value.duties.find(d => d.key === selectedDutyKey.value);
                if (duty) expandedCategories.value[duty.category] = true;
            }
            dutyDropdownOpen.value = !dutyDropdownOpen.value;
        };

        const toggleDutyCategory = (catKey) => {
            expandedCategories.value[catKey] = !expandedCategories.value[catKey];
        };

        const selectDuty = (key) => {
            selectedDutyKey.value = key;
            dutyDropdownOpen.value = false;
        };

        return {
            categoryDb, jobDb, dutyDb, dutyIndex,
            selectedDutyKey, party, mitMap,
            hideNonDmg, hideTargeted, settingsOpen, compactMode, currentCat,
            currentTimeline, activeSkills, activeSkillsByMember,
            addToParty, removeFromParty, calculateDamage,
            exportData, importData, copyShareUrl, shareToastVisible, shareLoading,
            isViewingSharedPlan, saveSharedPlanToLocal,
            hasOriginalDamage, isTargetedAttack,
            MEMBER_COLORS,
            selectedVariants, switchVariant, getSelectedVariantIdx, getDamageTypeIcon,
            isSkillActive, isSkillOnCooldown, isSkillCastOrigin, toggleSkillCast,
            getDamageTypeIconByType,
            expandedPersonalMembers, togglePersonalSkills,
            dutyDropdownOpen, expandedCategories, selectedDutyName,
            openDutyDropdown, toggleDutyCategory, selectDuty,
            isSkillConditionMet, isSkillBlocked,
            getAetherStacksAt, isSkillAetherDepleted,
            skillHasAnyCast, clearSkill, memberHasAnyCast, clearMember, clearAll,
            // Custom rows
            customRowsByDuty, customRowDraftTimes,
            insertCustomRowBetween, removeCustomRow, updateCustomRow,
            onCustomRowTimeInput, onCustomRowTimeBlur,
            isRowVisible,
            // Floating insert button
            hoverInsert, onRowMouseMove, onRowMouseLeave, onInsertBtnEnter, onInsertBtnLeave,
            skillTooltip, showSkillTooltip, hideSkillTooltip,
        };
    }
}).mount('#app');
