import { signInWithDiscord, signOut, getSession, onAuthStateChange as sbAuthChange, fetchMyDocuments, createDocument, updateDocument, renameDocument, deleteDocument, getDocumentByToken, updateByEditToken, buildEditUrl, buildReadUrl, subscribeDocChannel, fetchBookmarkedDocuments, addBookmark, removeBookmark, checkBookmark } from './src/supabase.js';

// Service Worker 註冊：偵測到新版本時自動重新載入頁面
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
        reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    // 有舊版 SW 在控制中，代表這是「更新」而非初次安裝，直接刷新
                    window.location.reload();
                }
            });
        });
    }).catch(() => {});
}

const { createApp, ref, computed, watch, onMounted, nextTick } = Vue;

const MEMBER_COLORS = [
    { bg: '#eff6ff', border: '#3b82f6', headerBg: '#dbeafe' },
    { bg: '#f0fdf4', border: '#22c55e', headerBg: '#dcfce7' },
    { bg: '#faf5ff', border: '#a855f7', headerBg: '#f3e8ff' },
    { bg: '#fffbeb', border: '#f59e0b', headerBg: '#fef3c7' },
    { bg: '#f8e4f4', border: '#f366df', headerBg: '#fae3f5' },
    { bg: '#ecfeff', border: '#06b6d4', headerBg: '#cffafe' },
    { bg: '#fff7ed', border: '#f97316', headerBg: '#ffedd5' },
    { bg: '#f0fdfa', border: '#14b8a6', headerBg: '#ccfbf1' },
];

const DARK_MEMBER_COLORS = [
    { bg: 'rgba(104,168,255,0.15)', border: '#68a8ff', headerBg: 'rgba(104,168,255,0.22)' },
    { bg: 'rgba(61,189,114,0.12)',  border: '#3dbd72', headerBg: 'rgba(61,189,114,0.18)'  },
    { bg: 'rgba(192,132,252,0.13)', border: '#c084fc', headerBg: 'rgba(192,132,252,0.20)' },
    { bg: 'rgba(214,163,84,0.13)',  border: '#d6a354', headerBg: 'rgba(214,163,84,0.20)'  },
    { bg: 'rgba(243,102,223,0.13)', border: '#f366df', headerBg: 'rgba(243,102,223,0.20)' },
    { bg: 'rgba(122,199,255,0.13)', border: '#7ac7ff', headerBg: 'rgba(122,199,255,0.20)' },
    { bg: 'rgba(240,152,90,0.13)',  border: '#f0985a', headerBg: 'rgba(240,152,90,0.20)'  },
    { bg: 'rgba(130,216,166,0.13)', border: '#82d8a6', headerBg: 'rgba(130,216,166,0.20)' },
];

// 注入 CSS custom properties，讓主題切換完全交給 CSS，避免 Vue 重渲染 table
(function injectMemberColorVars() {
    let css = ':root {\n';
    for (let i = 0; i < 8; i++) {
        const l = MEMBER_COLORS[i];
        css += `  --m${i}-bg:${l.bg};--m${i}-border:${l.border};--m${i}-hdr:${l.headerBg};`;
        css += `  --m${i}-cast:${l.border};--m${i}-cov-bg:${l.border}28;--m${i}-cov-bdr:${l.border}70;--m${i}-badge:${l.border}cc;\n`;
    }
    css += '}\nbody.dark {\n';
    for (let i = 0; i < 8; i++) {
        const d = DARK_MEMBER_COLORS[i];
        css += `  --m${i}-bg:${d.bg};--m${i}-border:${d.border};--m${i}-hdr:${d.headerBg};`;
        css += `  --m${i}-cast:${d.border}90;--m${i}-cov-bg:${d.border}28;--m${i}-cov-bdr:${d.border}70;--m${i}-badge:${d.border}cc;\n`;
    }
    css += '}';
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
})();

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

// ── Realtime 模組層級狀態（非 reactive，跨元件生命週期）───────
let _realtimeChannel = null;
let _realtimeNotifTimer = null;

// ── 三向 diff merge helpers（純函式，不依賴 Vue）────────────────

// 比較兩個施放索引陣列是否相同（忽略順序）
const _arrEq = (a, b) => {
    if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
    const sa = [...(a || [])].sort((x, y) => x - y);
    const sb = [...(b || [])].sort((x, y) => x - y);
    return sa.every((v, i) => v === sb[i]);
};

/**
 * 三向合併：base（我載入時的快照）、dbData（DB 目前版本）、local（我要儲存的版本）
 * 回傳 { merged, conflicts }
 * conflicts 是陣列，每個元素描述一個衝突欄位
 */
function mergePayloads(base, dbData, local) {
    const conflicts = [];
    const merged = {};

    merged.duty = local.duty || dbData.duty || base.duty;

    // ── mitMap ────────────────────────────────────────────────
    const bm = base.mits || {};
    const dm = dbData.mits || {};
    const lm = local.mits || {};
    const allMitKeys = new Set([...Object.keys(bm), ...Object.keys(dm), ...Object.keys(lm)]);
    const mergedMits = {};

    for (const key of allMitKeys) {
        const bv = bm[key] || [];
        const dv = dm[key] || [];
        const lv = lm[key] || [];
        const lChg = !_arrEq(lv, bv);
        const dChg = !_arrEq(dv, bv);

        if (lChg && dChg && !_arrEq(lv, dv)) {
            conflicts.push({ type: 'skill', key });
            if (dv.length) mergedMits[key] = dv;       // 衝突：保留 DB（他人）版本
        } else if (lChg) {
            if (lv.length) mergedMits[key] = lv;        // 只有我改：用我的
        } else {
            if (dv.length) mergedMits[key] = dv;        // 只有他改或都沒改：用 DB
        }
    }
    merged.mits = mergedMits;

    // ── selectedVariants ──────────────────────────────────────
    const bsv = base.selectedVariants || {};
    const dsv = dbData.selectedVariants || {};
    const lsv = local.selectedVariants || {};
    const allSVKeys = new Set([...Object.keys(bsv), ...Object.keys(dsv), ...Object.keys(lsv)]);
    const mergedSV = {};

    for (const key of allSVKeys) {
        const bv = bsv[key], dv = dsv[key], lv = lsv[key];
        const lChg = lv !== bv, dChg = dv !== bv;
        if (lChg && dChg && lv !== dv) {
            conflicts.push({ type: 'variant', key });
            if (dv !== undefined) mergedSV[key] = dv;
        } else if (lChg) {
            if (lv !== undefined) mergedSV[key] = lv;
        } else {
            if (dv !== undefined) mergedSV[key] = dv;
        }
    }
    merged.selectedVariants = mergedSV;

    // ── party ─────────────────────────────────────────────────
    const bp = base.party || [];
    const dp = dbData.party || [];
    const lp = local.party || [];
    const _partyEq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const lPartyChg = !_partyEq(lp, bp);
    const dPartyChg = !_partyEq(dp, bp);

    if (lPartyChg && dPartyChg && !_partyEq(lp, dp)) {
        conflicts.push({ type: 'party' });
        merged.party = dp;
    } else if (lPartyChg) {
        merged.party = lp;
    } else {
        merged.party = dp;
    }

    // ── customRowsByDuty ──────────────────────────────────────
    const bc = base.customRowsByDuty || {};
    const dc = dbData.customRowsByDuty || {};
    const lc = local.customRowsByDuty || {};
    const allDuties = new Set([...Object.keys(bc), ...Object.keys(dc), ...Object.keys(lc)]);
    const mergedCR = {};

    for (const duty of allDuties) {
        const bById = Object.fromEntries((bc[duty] || []).map(r => [r.id, r]));
        const dById = Object.fromEntries((dc[duty] || []).map(r => [r.id, r]));
        const lById = Object.fromEntries((lc[duty] || []).map(r => [r.id, r]));
        const allIds = new Set([...Object.keys(bById), ...Object.keys(dById), ...Object.keys(lById)]);
        const rows = [];

        for (const id of allIds) {
            const bSer = JSON.stringify(bById[id]);
            const dSer = JSON.stringify(dById[id]);
            const lSer = JSON.stringify(lById[id]);
            const lChg = lSer !== bSer, dChg = dSer !== bSer;

            if (lChg && dChg && lSer !== dSer) {
                conflicts.push({ type: 'customRow', duty, id });
                if (dById[id]) rows.push(dById[id]);
            } else if (lChg) {
                if (lById[id]) rows.push(lById[id]);
            } else {
                if (dById[id]) rows.push(dById[id]);
            }
        }

        if (rows.length > 0) {
            rows.sort((a, b) => timeToSeconds(a.hitTime) - timeToSeconds(b.hitTime));
            mergedCR[duty] = rows;
        }
    }
    merged.customRowsByDuty = mergedCR;

    // ── 顯示設定（boolean）────────────────────────────────────
    for (const field of ['hideNonDmg', 'hideTargeted']) {
        const bv = base[field], dv = dbData[field], lv = local[field];
        if (lv !== bv && dv !== bv && lv !== dv) {
            conflicts.push({ type: field });
            merged[field] = dv;
        } else if (lv !== bv) {
            merged[field] = lv;
        } else {
            merged[field] = dv !== undefined ? dv : bv;
        }
    }

    return { merged, conflicts };
}


createApp({
    setup() {
        const categoryDb = ref({});
        const jobDb = ref({});
        const dutyDb = ref({});
        const dutyIndex = ref({ categories: {}, duties: [] });

        const selectedDutyKey = ref('');
        const party = ref([]);
        const mitMap = ref({});
        // multiState 技能的每次施放狀態，格式：{ "dutyKey-skillInstId": { internalIdx: state } }
        // state 0 = 普通施放，state 1 = 護盾吸收觸發
        const skillStateMap = ref({});
        const hideNonDmg = ref(false);
        const hideTargeted = ref(false);
        const currentCat = ref('Tank');
        const compactMode = ref(true);
        const selectedVariants = ref({});
        const expandedPersonalMembers = ref([]);
        const shareToastVisible = ref(false);
        const shareLoading = ref(false);
        const isViewingSharedPlan = ref(false);
        const tokenMode = ref(null);    // null | 'edit' | 'read'
        const activeToken = ref('');
        const tokenDocName = ref('');
        const tokenLoadedAt = ref('');
        const tokenBaseData = ref(null); // 載入時的資料快照，用於三向 merge
        const tokenDocId   = ref('');
        const tokenSaving  = ref(false);
        const conflictDialog = ref({ open: false, enriched: [], autoMerged: null, dbData: null, localData: null });
        const realtimeNotif = ref(null); // null | {type:'pending'} | {type:'auto'}
        const isReadOnly = computed(() => tokenMode.value === 'read');
        const currentUser = ref(null);
        const authLoading = ref(true);
        const tokenDocOwnerId = ref('');
        const isDocOwner = computed(() => !!currentUser.value && currentUser.value.id === tokenDocOwnerId.value);
        const isBookmarked = ref(false);
        const bookmarkLoading = ref(false);
        const bookmarkedDocuments = ref([]);

        const dutyDropdownOpen = ref(false);
        const expandedCategories = ref({});

        const darkMode = ref(false);
        const toggleDarkMode = () => {
            darkMode.value = !darkMode.value;
            document.body.classList.toggle('dark', darkMode.value);
            localStorage.setItem('ffxiv_dark_mode', darkMode.value ? '1' : '0');
        };

        // ── Raid Params ───────────────────────────────────────
        const DEFAULT_RAID_PARAMS = {
            tankHp: 225800,
            teamMinHp: 142000,
            healerMnd: { WHM: 3250, SCH: 3250, AST: 3250, SGE: 3250 }
        };
        const raidParams = ref(JSON.parse(JSON.stringify(DEFAULT_RAID_PARAMS)));
        const allRaidParams = ref({});
        const raidParamsDialog = ref({ open: false });
        const raidParamsDraft = ref(JSON.parse(JSON.stringify(DEFAULT_RAID_PARAMS)));

        const HEALER_JOB_MAP    = { whm: 'WHM', sch: 'SCH', ast: 'AST', sge: 'SGE' };
        const TANK_JOB_PREFIXES = new Set(['pld', 'war', 'drk', 'gnb']);
        const HEALER_MIND_SCALING = 0.81 / 100;
        const SHIELD_EFFECT_TYPES = new Set(['shield_maxhp', 'shield_potency']);
        const MIT_EFFECT_TYPES    = new Set(['mit_all', 'mit_physical', 'mit_magic', 'invincible']);

        const getJobPrefix = (skill) => (skill.id || '').split('_')[0];
        const getHealerMnd = (skill) => {
            const jobKey = HEALER_JOB_MAP[getJobPrefix(skill)];
            return jobKey ? (raidParams.value.healerMnd[jobKey] || 3250) : null;
        };
        const getMaxHpForSkill = (skill) =>
            TANK_JOB_PREFIXES.has(getJobPrefix(skill))
                ? raidParams.value.tankHp
                : raidParams.value.teamMinHp;

        const calcShieldDisplay = (skill) => {
            if (!skill?.effects?.length) return [];
            const results = [];
            const healerMnd = getHealerMnd(skill);
            const critMult = skill.recitationCritMult || null;

            for (const eff of skill.effects) {
                if (eff.type === 'shield_maxhp') {
                    const pct = Math.round(eff.val * 100);
                    const baseHp = getMaxHpForSkill(skill);
                    const shieldHp = Math.floor(baseHp * eff.val);
                    results.push({ label: `護盾（HP×${pct}%）`, value: shieldHp });
                } else if (eff.type === 'shield_potency') {
                    if (eff.useTankStats) {
                        results.push({ label: `護盾恢復力 ${eff.val}`, note: '（坦克自身能力值計算）' });
                        continue;
                    }
                    if (!healerMnd) continue;
                    const shieldRatio = eff.shieldRatio || 1.0;
                    const showRatio = shieldRatio !== 1.0;
                    const healAmount = Math.floor(eff.val * (healerMnd * HEALER_MIND_SCALING));
                    const shieldAmount = Math.floor(healAmount * shieldRatio);
                    const critShieldAmount = critMult !== null ? Math.floor(shieldAmount * critMult) : null;
                    const stacks = eff.stacks || 1;
                    if (stacks > 1) {
                        results.push({
                            label: `護盾 ×${stacks}層`,
                            value: shieldAmount,
                            total: shieldAmount * stacks,
                            healAmount,
                            shieldRatio: showRatio ? shieldRatio : null,
                            critValue: critShieldAmount,
                            critTotal: critShieldAmount !== null ? critShieldAmount * stacks : null,
                        });
                    } else {
                        results.push({
                            label: '護盾',
                            value: shieldAmount,
                            healAmount: showRatio ? healAmount : null,
                            shieldRatio: showRatio ? shieldRatio : null,
                            critValue: critShieldAmount,
                        });
                    }
                }
            }
            return results;
        };

        // healOutMult 只影響 shield_potency 類型，shield_maxhp 類型不受治療量加成影響
        const calcShieldValue = (skill, healOutMult = 1.0) => {
            if (!skill?.effects?.length) return 0;
            let total = 0;
            const healerMnd = getHealerMnd(skill);
            for (const eff of skill.effects) {
                if (eff.type === 'shield_maxhp') {
                    total += Math.floor(getMaxHpForSkill(skill) * eff.val);
                } else if (eff.type === 'shield_potency' && !eff.useTankStats && healerMnd) {
                    const shieldRatio = eff.shieldRatio || 1.0;
                    const healAmount = Math.floor(eff.val * (healerMnd * HEALER_MIND_SCALING) * healOutMult);
                    total += Math.floor(healAmount * shieldRatio) * (eff.stacks || 1);
                }
            }
            return total;
        };

        // 計算施放者在指定時間點的治療量提升倍率（累乘）
        // personal 技能只對自己成員有效；非 personal 技能對全隊有效
        const getHealOutMult = (memberIndex, castTime) => {
            let mult = 1.0;
            for (const skill of activeSkills.value) {
                if (!skill.effects?.length) continue;
                if (skill.personal === true && skill.memberIndex !== memberIndex) continue;
                const castTimes = castTimesCache.value.get(skill.instanceId) || [];
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

        const _getCurrentDutyCategory = () => {
            const dutyEntry = dutyIndex.value.duties.find(d => d.key === selectedDutyKey.value);
            return dutyEntry?.category || null;
        };

        const loadRaidParamsForDuty = (dutyKey) => {
            const dutyEntry = dutyIndex.value.duties.find(d => d.key === dutyKey);
            const catKey = dutyEntry?.category || null;
            if (catKey && allRaidParams.value[catKey]) {
                raidParams.value = JSON.parse(JSON.stringify(allRaidParams.value[catKey]));
                return;
            }
            if (catKey) {
                const catDef = dutyIndex.value.categories[catKey]?.params;
                if (catDef) {
                    raidParams.value = JSON.parse(JSON.stringify(catDef));
                    return;
                }
            }
            raidParams.value = JSON.parse(JSON.stringify(DEFAULT_RAID_PARAMS));
        };

        const openRaidParamsDialog = () => {
            raidParamsDraft.value = {
                tankHp: raidParams.value.tankHp,
                teamMinHp: raidParams.value.teamMinHp,
                healerMnd: { ...raidParams.value.healerMnd }
            };
            raidParamsDialog.value.open = true;
        };

        const closeRaidParamsDialog = () => {
            raidParamsDialog.value.open = false;
        };

        const resetRaidParamsDraftToDefault = () => {
            const catKey = _getCurrentDutyCategory();
            const catDef = catKey ? dutyIndex.value.categories[catKey]?.params : null;
            raidParamsDraft.value = JSON.parse(JSON.stringify(catDef || DEFAULT_RAID_PARAMS));
        };

        const saveRaidParams = () => {
            const parsed = {
                tankHp: parseInt(raidParamsDraft.value.tankHp) || DEFAULT_RAID_PARAMS.tankHp,
                teamMinHp: parseInt(raidParamsDraft.value.teamMinHp) || DEFAULT_RAID_PARAMS.teamMinHp,
                healerMnd: {
                    WHM: parseInt(raidParamsDraft.value.healerMnd.WHM) || DEFAULT_RAID_PARAMS.healerMnd.WHM,
                    SCH: parseInt(raidParamsDraft.value.healerMnd.SCH) || DEFAULT_RAID_PARAMS.healerMnd.SCH,
                    AST: parseInt(raidParamsDraft.value.healerMnd.AST) || DEFAULT_RAID_PARAMS.healerMnd.AST,
                    SGE: parseInt(raidParamsDraft.value.healerMnd.SGE) || DEFAULT_RAID_PARAMS.healerMnd.SGE,
                }
            };
            raidParams.value = parsed;
            const catKey = _getCurrentDutyCategory();
            if (catKey) {
                allRaidParams.value = { ...allRaidParams.value, [catKey]: JSON.parse(JSON.stringify(parsed)) };
            }
            localStorage.setItem('ffxiv_raid_params', JSON.stringify(allRaidParams.value));
            raidParamsDialog.value.open = false;
        };

        const customRowStyle = computed(() =>
            darkMode.value ? 'background:rgba(214,163,84,0.10);' : 'background:#fffdf0;'
        );


        const skillTooltip = ref({ skill: null, x: 0, y: 0 });
        let _tooltipHideTimer = null;
        const showSkillTooltip = (skill, event) => {
            if (!skill.title && !skill.conditionSkillId && !skill.blockedBySkillId && skill.charges <= 1 && !skill.duration && !skill.cooldown) return;
            clearTimeout(_tooltipHideTimer);
            const rect = event.currentTarget.getBoundingClientRect();
            const tooltipWidth = 240;
            let x = rect.left + rect.width / 2;
            x = Math.max(tooltipWidth / 2 + 8, Math.min(x, window.innerWidth - tooltipWidth / 2 - 8));
            skillTooltip.value = { skill, x, y: rect.bottom + 8 };
        };
        const hideSkillTooltip = () => {
            _tooltipHideTimer = setTimeout(() => { skillTooltip.value.skill = null; }, 50);
        };
        const keepSkillTooltip = () => { clearTimeout(_tooltipHideTimer); };

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

        const rowTimes = computed(() =>
            allRowsFlat.value.map(row => timeToSeconds(row?.hitTime))
        );

        const castTimesCache = computed(() => {
            const map = new Map();
            const flat = allRowsFlat.value;
            const prefix = selectedDutyKey.value + '-';
            for (const [key, castRows] of Object.entries(mitMap.value)) {
                if (!key.startsWith(prefix)) continue;
                const instanceId = key.slice(prefix.length);
                map.set(instanceId, castRows.map(ci => timeToSeconds(flat[ci]?.hitTime)));
            }
            return map;
        });

        const currentTimeline = computed(() => {
            return allRowsFlat.value
                .map((row, idx) => ({ ...row, _internalIdx: idx }))
                .sort((a, b) => timeToSeconds(a.hitTime) - timeToSeconds(b.hitTime));
        });

        // 在兩列之間插入自訂列，時間預設為中間值；若無前後列則各加減 5 秒
        // 插入後自動聚焦時間輸入框讓使用者立即編輯
        const insertCustomRowBetween = (timeBefore, timeAfter) => {
            if (isReadOnly.value) return;
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
            if (isReadOnly.value) return;
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
            if (isReadOnly.value) return;
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


        // 找出某技能在指定秒數對應的 internalIdx（用於從 castTimesCache 反查 state）
        const findCastRowIdx = (skillInstanceId, timeSecs) => {
            const castRows = getCastRows(skillInstanceId);
            return castRows.find(ri => rowTimes.value[ri] === timeSecs) ?? null;
        };

        // 找出在 TPC 施放窗口內的 TPG 施放時間（秒）
        // 同秒數時改用列索引（internalIdx）比較：TPG 的列索引必須大於 TPC 的列索引才算在窗口內
        const findTpgTimeSecs = (tpcSkill, tpcCastTimeSecs) => {
            if (!tpcSkill.upgradeSkillId) return null;
            const upgInst = activeSkillByKey.value.get(`${tpcSkill.upgradeSkillId}|${tpcSkill.memberIndex}`);
            if (!upgInst) return null;
            const tpcRowIdx = findCastRowIdx(tpcSkill.instanceId, tpcCastTimeSecs);
            const upgCastRows = getCastRows(upgInst.instanceId);
            for (const tpgRowIdx of upgCastRows) {
                const tpgTime = rowTimes.value[tpgRowIdx];
                if (tpgTime < tpcCastTimeSecs) continue;
                if (tpgTime > tpcCastTimeSecs + tpcSkill.duration) continue;
                // 同秒時 TPG 必須在 TPC 的後面幾列
                if (tpgTime === tpcCastTimeSecs && (tpcRowIdx === null || tpgRowIdx <= tpcRowIdx)) continue;
                return tpgTime;
            }
            return null;
        };

        // 檢查指定技能在特定施放時間點的護盾是否已被完全吸收
        const isShieldDepleted = (skillInst, castTimeSecs) => {
            const castTimes = castTimesCache.value.get(skillInst.instanceId) || [];
            const ci = castTimes.indexOf(castTimeSecs);
            if (ci < 0) return false;
            return shieldCoverageByRow.value.depletionAt.get(`${skillInst.instanceId}-${ci}`) != null;
        };

        // 根據護盾是否耗盡自動計算 TPC 的有效 CD
        // TPC 護盾耗盡 → 60s；TPG 護盾耗盡 → 90s；否則 → 120s（skill.cooldown）
        const getTpcEffectiveCooldown = (tpcSkill, tpcCastTimeSecs) => {
            if (isShieldDepleted(tpcSkill, tpcCastTimeSecs)) {
                return tpcSkill.stateCooldowns?.[1] ?? 60;
            }
            if (tpcSkill.upgradeSkillId) {
                const upgInst = activeSkillByKey.value.get(`${tpcSkill.upgradeSkillId}|${tpcSkill.memberIndex}`);
                if (upgInst) {
                    const tpgTime = findTpgTimeSecs(tpcSkill, tpcCastTimeSecs);
                    if (tpgTime != null && isShieldDepleted(upgInst, tpgTime)) {
                        return tpcSkill.cooldown - 30;
                    }
                }
            }
            return tpcSkill.cooldown;
        };

        // 根據 TPC 的施放時間與 TPG 是否存在，計算 TPC 的有效持續時間（TPG 施放時截斷）
        const getTpcEffectiveDuration = (tpcSkill, tpcCastTimeSecs) => {
            if (!tpcSkill.upgradeSkillId) return tpcSkill.duration;
            const tpgTime = findTpgTimeSecs(tpcSkill, tpcCastTimeSecs);
            return tpgTime != null ? (tpgTime - tpcCastTimeSecs) : tpcSkill.duration;
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
            const allTimes = castTimesCache.value.get(skillInstanceId) || [];
            const castTimes = allTimes.filter(ct => ct < rowTime);
            if (!castTimes.length) return skill.charges;
            const restoreTimes = computeChargeRestoreTimes(castTimes, skill.cooldown);
            const inRecharge = castTimes.filter((_ct, i) => rowTime < restoreTimes[i]).length;
            return Math.max(0, skill.charges - inRecharge);
        };

        // 判斷技能的「前提條件」是否滿足，涵蓋三種情境：
        //   1. togglesWithId：成對開關技能，依施放次數奇偶交替（isFirstToggle 決定先後順序）
        //   2. conditionDuration：需要在某個條件技能的效果時間窗內才可施放
        //   3. conditionSkillId（無 duration）：需要條件技能目前處於效果中
        const isSkillConditionMet = (skill, internalIdx) => {
            const rowTime = rowTimes.value[internalIdx];
            if (skill.combatOnly && rowTime < 0) return false;
            if (skill.togglesWithId) {
                const pairedSkill = activeSkillByKey.value.get(`${skill.togglesWithId}|${skill.memberIndex}`);
                const myCastTimes = castTimesCache.value.get(skill.instanceId) || [];
                const myCount = myCastTimes.filter(ct => ct < rowTime).length;
                const pairedCount = pairedSkill
                    ? (castTimesCache.value.get(pairedSkill.instanceId) || []).filter(ct => ct < rowTime).length
                    : 0;
                return skill.isFirstToggle ? myCount === pairedCount : myCount < pairedCount;
            }
            if (!skill.conditionSkillId) return true;
            const condSkill = activeSkillByKey.value.get(`${skill.conditionSkillId}|${skill.memberIndex}`);
            if (!condSkill) return false;
            const condCastTimes = castTimesCache.value.get(condSkill.instanceId) || [];
            const condDuration = skill.conditionDuration ?? condSkill.duration;

            let condWindowStart;
            if (skill.conditionDuration != null) {
                condWindowStart = condCastTimes.find(ct => rowTime >= ct && rowTime <= ct + condDuration);
                if (condWindowStart === undefined) return false;
            } else {
                if (!isSkillActive(condSkill.instanceId, internalIdx, condSkill)) return false;
                condWindowStart = condCastTimes.find(ct => rowTime > ct && rowTime <= ct + condDuration);
            }

            if (skill.conditionOnce && condWindowStart !== undefined) {
                const condEnd = condWindowStart + condDuration;
                const myCastTimes = castTimesCache.value.get(skill.instanceId) || [];
                const existingCi = myCastTimes.findIndex(ct => ct !== rowTime && ct >= condWindowStart && ct <= condEnd);
                if (existingCi >= 0) {
                    const existingTime = myCastTimes[existingCi];
                    const existingActiveEnd = existingTime + skill.duration;
                    if (rowTime < existingTime || rowTime > existingActiveEnd) return false;
                    if (isPureShieldSkill(skill)) {
                        const depletionIdx = shieldCoverageByRow.value.depletionAt.get(`${skill.instanceId}-${existingCi}`);
                        if (depletionIdx != null && internalIdx > depletionIdx) return false;
                    }
                }
            }
            return true;
        };

        const isSkillBlocked = (skill, internalIdx) => {
            if (!skill.blockedBySkillId) return false;
            return skill.blockedBySkillId.some(blockId => {
                const s = activeSkillByKey.value.get(`${blockId}|${skill.memberIndex}`);
                return s && isSkillActive(s.instanceId, internalIdx, s);
            });
        };

        const isSkillActive = (skillInstanceId, internalIdx, skill) => {
            if (skill.passive) return true;
            const castTimes = castTimesCache.value.get(skillInstanceId);
            if (!castTimes || !castTimes.length) return false;
            const rowTime = rowTimes.value[internalIdx];
            const pureShield = isPureShieldSkill(skill);
            return castTimes.some((ct, ci) => {
                const dur = skill.upgradeSkillId ? getTpcEffectiveDuration(skill, ct) : skill.duration;
                // upgradeSkillId 技能（TPC）被 TPG 施放時立即消耗，用嚴格小於避免邊界重疊
                const inWindow = skill.upgradeSkillId
                    ? (rowTime >= ct && rowTime < ct + dur)
                    : (rowTime >= ct && rowTime <= ct + dur);
                if (!inWindow) return false;
                if (pureShield) {
                    const depletionIdx = shieldCoverageByRow.value.depletionAt.get(`${skillInstanceId}-${ci}`);
                    if (depletionIdx != null && internalIdx > depletionIdx) return false;
                }
                return true;
            });
        };

        // 判斷技能在指定列是否處於冷卻中，需處理多種複雜情境：
        //   - togglesWithId：成對技能的冷卻狀態需參照配對技能的施放時間
        //   - sharedCooldownId：共享冷卻時間的技能（如任何一個在冷卻中則判定為冷卻）
        //   - conditionOnce：在條件技能的時間窗內只允許施放一次
        //   - charges > 1：多充能技能，充能歸零才算冷卻
        const isSkillOnCooldown = (skillInstanceId, internalIdx, skill) => {
            const myCastTimes = castTimesCache.value.get(skillInstanceId) || [];
            const rowTime = rowTimes.value[internalIdx];

            if (skill.togglesWithId) {
                const pairedSkill = activeSkillByKey.value.get(`${skill.togglesWithId}|${skill.memberIndex}`);
                const ownOnCooldown = myCastTimes.some(ct => {
                    const diff = rowTime - ct;
                    return diff > skill.duration && diff < skill.cooldown;
                });
                if (ownOnCooldown) return true;
                const myCount = myCastTimes.filter(ct => ct < rowTime).length;
                const pairedCastTimes = pairedSkill
                    ? (castTimesCache.value.get(pairedSkill.instanceId) || []).filter(t => t < rowTime)
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
                const pairedSkill = activeSkillByKey.value.get(`${skill.sharedCooldownId}|${skill.memberIndex}`);
                if (pairedSkill) {
                    const pairedCastTimes = castTimesCache.value.get(pairedSkill.instanceId) || [];
                    const sharedOnCooldown = pairedCastTimes.some(ct => {
                        const diff = rowTime - ct;
                        return diff >= 0 && diff < pairedSkill.cooldown;
                    });
                    if (sharedOnCooldown) return true;
                }
            }

            if (!myCastTimes.length) return false;

            if (skill.charges > 1) {
                if (isSkillActive(skillInstanceId, internalIdx, skill)) return false;
                return chargesAvailableAt(skillInstanceId, rowTime, skill) === 0;
            }

            if (skill.multiState && skill.upgradeSkillId) {
                return myCastTimes.some((ct, ci) => {
                    const diff = rowTime - ct;
                    if (diff < 0) return false;
                    const effectiveDuration = getTpcEffectiveDuration(skill, ct);
                    const effectiveCd = getTpcEffectiveCooldown(skill, ct);
                    if (diff >= effectiveDuration && diff < effectiveCd) return true;
                    // 護盾耗盡後，在 CD 結束前也顯示為冷卻中
                    const depletionIdx = shieldCoverageByRow.value.depletionAt.get(`${skillInstanceId}-${ci}`);
                    return depletionIdx != null && internalIdx > depletionIdx && diff < effectiveCd;
                });
            }

            return myCastTimes.some((ct, ci) => {
                const diff = rowTime - ct;
                if (diff > skill.duration && diff < skill.cooldown) return true;
                if (isPureShieldSkill(skill)) {
                    const depletionIdx = shieldCoverageByRow.value.depletionAt.get(`${skillInstanceId}-${ci}`);
                    return depletionIdx != null && internalIdx > depletionIdx && diff >= 0 && diff < skill.cooldown;
                }
                return false;
            });
        };

        const isSkillCastOrigin = (skillInstanceId, internalIdx) => {
            return getCastRows(skillInstanceId).includes(internalIdx);
        };

        // 找出新技能效果窗口內，已排定的互斥技能施放記錄（雙向：本技能被封鎖者 + 本技能封鎖者）
        const findForwardBlockConflicts = (skill, internalIdx) => {
            const rowTime = rowTimes.value[internalIdx];
            const skillEnd = rowTime + skill.duration;
            const flat = allRowsFlat.value;
            const conflicts = [];
            const checkedIds = new Set();

            const checkBlocker = (blockerId) => {
                if (checkedIds.has(blockerId)) return;
                checkedIds.add(blockerId);
                const blockerSkill = activeSkillByKey.value.get(`${blockerId}|${skill.memberIndex}`);
                if (!blockerSkill) return;
                const blockerKey = mitKeyForSkill(blockerSkill.instanceId);
                for (const ci of (mitMap.value[blockerKey] || [])) {
                    const ct = timeToSeconds(flat[ci]?.hitTime);
                    if (ct > rowTime && ct < skillEnd) {
                        conflicts.push({ key: blockerKey, rowIdx: ci, time: flat[ci]?.hitTime, skillName: blockerSkill.name });
                    }
                }
            };

            for (const blockerId of (skill.blockedBySkillId || [])) checkBlocker(blockerId);
            for (const s of activeSkills.value) {
                if (s.memberIndex !== skill.memberIndex) continue;
                if (s.blockedBySkillId?.includes(skill.id)) checkBlocker(s.id);
            }
            return conflicts;
        };

        // 找出在條件技能特定施放窗口內，已排定的所有依賴施放記錄
        // 用於取消條件技能時自動連帶取消相依技能（無需確認）
        const findConditionedCasts = (condSkill, canceledRowTime) => {
            const flat = allRowsFlat.value;
            const removals = [];
            for (const s of activeSkills.value) {
                if (s.memberIndex !== condSkill.memberIndex) continue;
                if (s.conditionSkillId !== condSkill.id) continue;
                const condWindow = s.conditionDuration ?? condSkill.duration;
                const windowEnd = canceledRowTime + condWindow;
                const sKey = mitKeyForSkill(s.instanceId);
                for (const ci of (mitMap.value[sKey] || [])) {
                    const ct = timeToSeconds(flat[ci]?.hitTime);
                    if (ct >= canceledRowTime && ct <= windowEnd) {
                        removals.push({ key: sKey, rowIdx: ci });
                    }
                }
            }
            return removals;
        };

        // 將互斥衝突移除套用到指定 map（直接修改傳入物件）
        const applyBlockConflictRemovals = (conflicts, targetMap) => {
            for (const { key, rowIdx } of conflicts) {
                const arr = [...(targetMap[key] || [])];
                const i = arr.indexOf(rowIdx);
                if (i >= 0) arr.splice(i, 1);
                if (arr.length) targetMap[key] = arr; else delete targetMap[key];
            }
        };

        // 找出 castRows 中會與 rowTime 產生冷卻衝突的後方施放點，詢問使用者是否取消衝突
        // 若使用者取消操作回傳 false，否則移除衝突施放點並回傳 true
        const removeForwardConflicts = (skill, castRows, rowTime, flat) => {
            const forwardConflicts = castRows.filter(ci => {
                const d = timeToSeconds(flat[ci]?.hitTime) - rowTime;
                return d > 0 && d < skill.cooldown;
            });
            if (forwardConflicts.length === 0) return true;
            const conflictTimes = forwardConflicts.map(ci => flat[ci]?.hitTime).join('、');
            if (!confirm(`「${skill.name}」與較晚的施放點（${conflictTimes}）衝突，已自動取消衝突紀錄。`)) return false;
            forwardConflicts.forEach(ci => { const i = castRows.indexOf(ci); if (i >= 0) castRows.splice(i, 1); });
            return true;
        };

        // 切換技能在指定列的施放記錄（核心互動函式）
        // 取消施放：直接移除；新增施放：依序檢查前提、封鎖、乙太消耗、冷卻
        // 多充能技能：模擬插入後驗算後方施放是否會因充能不足產生衝突並詢問使用者
        // 單充能技能：若新施放點的冷卻覆蓋到後方已記錄的施放點，同樣詢問是否取消衝突
        // multiState 技能（TPC/TPG）：三態循環，並處理互相截斷與連帶取消邏輯
        const toggleSkillCast = (skillInstanceId, internalIdx, skill) => {
            if (isReadOnly.value) return;
            const key = mitKeyForSkill(skillInstanceId);
            const castRows = [...(mitMap.value[key] || [])];
            const idx = castRows.indexOf(internalIdx);
            const flat = allRowsFlat.value;

            // ── multiState 技能（TPC / TPG）分支 ─────────────────
            // CD 縮短已改為自動依護盾耗盡判斷，不再需要手動切換破盾狀態
            if (skill.multiState) {
                const newMap = { ...mitMap.value };

                if (skill.upgradeSkillId) {
                    // ── TPC 邏輯 ──────────────────────────────────
                    if (idx < 0) {
                        if (!isSkillConditionMet(skill, internalIdx)) return;
                        if (isSkillBlocked(skill, internalIdx)) return;
                        const tpcFwdConflicts = findForwardBlockConflicts(skill, internalIdx);
                        if (tpcFwdConflicts.length > 0) {
                            const desc = tpcFwdConflicts.map(c => `${c.skillName}（${c.time}）`).join('、');
                            if (!confirm(`「${skill.name}」與互斥技能「${desc}」衝突，確認是否覆蓋並取消衝突紀錄。`)) return;
                            applyBlockConflictRemovals(tpcFwdConflicts, newMap);
                        }
                        if (isSkillOnCooldown(skillInstanceId, internalIdx, skill)) return;
                        if (isSkillActive(skillInstanceId, internalIdx, skill)) return;
                        const rowTime = timeToSeconds(flat[internalIdx]?.hitTime);
                        if (!removeForwardConflicts(skill, castRows, rowTime, flat)) return;
                        castRows.push(internalIdx);
                        castRows.sort((a, b) => a - b);
                        newMap[key] = castRows;
                    } else {
                        // 已施放 → 取消，連帶取消窗口內的 TPG 與條件式技能
                        const tpcTimeSecs = timeToSeconds(flat[internalIdx]?.hitTime);
                        const upgInst = activeSkillByKey.value.get(`${skill.upgradeSkillId}|${skill.memberIndex}`);
                        const upgKey = upgInst ? mitKeyForSkill(upgInst.instanceId) : null;
                        const tpgTimeSecs = findTpgTimeSecs(skill, tpcTimeSecs);
                        castRows.splice(idx, 1);
                        if (castRows.length) { newMap[key] = castRows; } else { delete newMap[key]; }
                        if (upgKey && tpgTimeSecs != null) {
                            const tpgIdx = findCastRowIdx(upgInst.instanceId, tpgTimeSecs);
                            if (tpgIdx !== null) {
                                const upgCastRows = [...(mitMap.value[upgKey] || [])];
                                const ti = upgCastRows.indexOf(tpgIdx);
                                if (ti >= 0) upgCastRows.splice(ti, 1);
                                if (upgCastRows.length) { newMap[upgKey] = upgCastRows; } else { delete newMap[upgKey]; }
                            }
                        }
                        applyBlockConflictRemovals(findConditionedCasts(skill, tpcTimeSecs), newMap);
                    }
                } else {
                    // ── TPG 邏輯（conditionSkillId = TPC，multiState，無 upgradeSkillId）──
                    if (idx < 0) {
                        if (!isSkillConditionMet(skill, internalIdx)) return;
                        if (isSkillOnCooldown(skillInstanceId, internalIdx, skill)) return;
                        castRows.push(internalIdx);
                        castRows.sort((a, b) => a - b);
                        newMap[key] = castRows;
                    } else {
                        castRows.splice(idx, 1);
                        if (castRows.length) { newMap[key] = castRows; } else { delete newMap[key]; }
                    }
                }

                mitMap.value = newMap;
                return;
            }
            // ── 原有邏輯 ─────────────────────────────────────────

            let fwdBlockConflicts = [];
            let conditionedCascade = [];
            if (idx >= 0) {
                castRows.splice(idx, 1);
                // 連帶取消此窗口內的條件式技能施放（預期行為，無需確認）
                const canceledRowTime = timeToSeconds(flat[internalIdx]?.hitTime);
                conditionedCascade = findConditionedCasts(skill, canceledRowTime);
            } else {
                if (!isSkillConditionMet(skill, internalIdx)) return;
                if (isSkillBlocked(skill, internalIdx)) return;
                fwdBlockConflicts = findForwardBlockConflicts(skill, internalIdx);
                if (fwdBlockConflicts.length > 0) {
                    const desc = fwdBlockConflicts.map(c => `${c.skillName}（${c.time}）`).join('、');
                    if (!confirm(`「${skill.name}」與互斥技能「${desc}」衝突，確認是否覆蓋並取消衝突紀錄。`)) return;
                }
                if (isSkillAetherDepleted(skill, internalIdx)) return;
                if (isSkillAddersgallDepleted(skill, internalIdx)) return;

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
                        if (!removeForwardConflicts(skill, castRows, rowTime, flat)) return;
                    }
                }

                castRows.push(internalIdx);
                castRows.sort((a, b) => a - b);
            }

            const newMap = { ...mitMap.value };
            applyBlockConflictRemovals(fwdBlockConflicts, newMap);
            applyBlockConflictRemovals(conditionedCascade, newMap);
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
            const dutyPrefix = selectedDutyKey.value + '-';
            party.value.forEach((jobKey, pIdx) => {
                if (jobKey !== 'SCH') return;
                const jobEntry = jobDb.value[jobKey];
                if (!jobEntry || !jobEntry.skills) return;
                const flat = allRowsFlat.value;
                // 預先建好 Set，避免在每個 row 裡重複做字串拼接 + Map 查找 + Array.includes
                const aetherSkills = jobEntry.skills
                    .filter(s => s.aetherProvide || s.aetherCost)
                    .map(s => ({
                        skill: s,
                        castSet: new Set(mitMap.value[`${dutyPrefix}p${pIdx}-${s.id}`] || []),
                    }));
                let stacks = 0;
                const byRow = [];
                for (let ri = 0; ri < flat.length; ri++) {
                    // 乙太超流與轉化無法在戰鬥開始前使用，負數時間的列固定為 0，且不更新存量狀態
                    if (timeToSeconds(flat[ri].hitTime) < 0) {
                        byRow.push(0);
                        continue;
                    }
                    for (const { skill, castSet } of aetherSkills) {
                        if (!castSet.has(ri)) continue;
                        if (skill.aetherProvide) stacks = Math.min(3, stacks + skill.aetherProvide);
                        if (skill.aetherCost)    stacks = Math.max(0, stacks - skill.aetherCost);
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
            if (rowTimes.value[internalIdx] < 0) return true; // 戰鬥開始前沒有乙太
            const pIdx = skill.memberIndex - 1;
            return (aetherStacksByMember.value[pIdx]?.[internalIdx - 1] ?? 0) === 0;
        };

        // 逐列追蹤賢者（SGE）蛇膽（Addersgall）的存量變化
        // 初始存量 3，每 20 秒自動回復 1（上限 3）
        // 使用「根素」+1，使用消耗蛇膽的技能 -1
        const addersgallStacksByMember = computed(() => {
            const result = {};
            const dutyPrefix = selectedDutyKey.value + '-';
            party.value.forEach((jobKey, pIdx) => {
                if (jobKey !== 'SGE') return;
                const jobEntry = jobDb.value[jobKey];
                if (!jobEntry || !jobEntry.skills) return;
                const flat = allRowsFlat.value;
                // 預先建好 Set，避免在每個 row 裡重複做字串拼接 + Map 查找 + Array.includes
                const addersgallSkills = jobEntry.skills
                    .filter(s => s.addersgallProvide || s.addersgallCost)
                    .map(s => ({
                        skill: s,
                        castSet: new Set(mitMap.value[`${dutyPrefix}p${pIdx}-${s.id}`] || []),
                    }));
                let stacks = 3;
                let lastTickCount = 0;
                const byRow = [];
                for (let ri = 0; ri < flat.length; ri++) {
                    const rowTime = timeToSeconds(flat[ri].hitTime);
                    const tickCount = Math.max(0, Math.floor(rowTime / 20));
                    const newTicks = tickCount - lastTickCount;
                    if (newTicks > 0) {
                        stacks = Math.min(3, stacks + newTicks);
                        lastTickCount = tickCount;
                    }
                    for (const { skill, castSet } of addersgallSkills) {
                        if (!castSet.has(ri)) continue;
                        if (skill.addersgallProvide) stacks = Math.min(3, stacks + skill.addersgallProvide);
                        if (skill.addersgallCost)    stacks = Math.max(0, stacks - skill.addersgallCost);
                    }
                    byRow.push(stacks);
                }
                result[pIdx] = byRow;
            });
            return result;
        });

        const getAddersgallStacksAt = (pIdx, internalIdx) =>
            addersgallStacksByMember.value[pIdx]?.[internalIdx] ?? 3;

        const isSkillAddersgallDepleted = (skill, internalIdx) => {
            if (!skill.addersgallCost) return false;
            const pIdx = skill.memberIndex - 1;
            return (addersgallStacksByMember.value[pIdx]?.[internalIdx - 1] ?? 3) === 0;
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

        watch(selectedDutyKey, (key) => {
            if (key) loadRaidParamsForDuty(key);
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

                const savedDark = localStorage.getItem('ffxiv_dark_mode');
                if (savedDark === '1') {
                    darkMode.value = true;
                    document.body.classList.add('dark');
                }

                const savedRaidParams = localStorage.getItem('ffxiv_raid_params');
                if (savedRaidParams) {
                    allRaidParams.value = JSON.parse(savedRaidParams);
                }

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
                        skillStateMap.value = parsed.skillStateMap || {};
                        if (parsed.selectedDutyKey) loadRaidParamsForDuty(parsed.selectedDutyKey);
                    }
                }
                syncStickyRow();
            } catch (err) {
                console.error("資料載入失敗，請確認檔案路徑是否正確 (src/)", err);
                alert("無法讀取 JSON 資料，請檢查控制台錯誤訊息。");
            }
            try {
                const { data: { session } } = await getSession();
                currentUser.value = session?.user ?? null;
            } catch (e) {
                console.warn('Auth session check failed:', e);
            } finally {
                authLoading.value = false;
            }
        });

        // ── Party ─────────────────────────────────────────────
        const addToParty = (jobId) => {
            if (isReadOnly.value) return;
            if (party.value.length < 8) {
                party.value.push(jobId);
            }
        };

        const removeFromParty = (index) => {
            if (isReadOnly.value) return;
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
                const pSlot = pIdx % 8;
                const memberBg     = `var(--m${pSlot}-bg)`;
                const memberBorder = `var(--m${pSlot}-border)`;
                const memberCast   = `var(--m${pSlot}-cast)`;
                const memberCovBg  = `var(--m${pSlot}-cov-bg)`;
                const memberCovBdr = `var(--m${pSlot}-cov-bdr)`;
                const color = {
                    border:   memberBorder,
                    headerBg: `var(--m${pSlot}-hdr)`,
                    badge:    `var(--m${pSlot}-badge)`,
                };
                const hasPersonalSkills = jobEntry.skills.some(s => s.personal);
                const showPersonal = expandedPersonalMembers.value.includes(pIdx);
                const filteredSkills = jobEntry.skills.filter(s => !s.personal || showPersonal);
                const mappedSkills = filteredSkills.map((s, sIdx) => ({
                    ...s,
                    instanceId: `p${pIdx}-${s.id}`,
                    memberIndex: pIdx + 1,
                    jobIcon: jobEntry.icon,
                    memberBg,
                    memberBorder,
                    memberCast,
                    memberCovBg,
                    memberCovBdr,
                    isFirstInGroup: sIdx === 0,
                }));
                if (jobKey === 'SCH' && showPersonal) {
                    mappedSkills.push({
                        id: '_aether',
                        instanceId: `p${pIdx}-_aether`,
                        name: '乙太存量',
                        _isAetherIndicator: true,
                        _pIdx: pIdx,
                        memberBg,
                        memberBorder,
                        isFirstInGroup: false,
                        effects: [],
                    });
                }
                if (jobKey === 'SGE' && showPersonal) {
                    mappedSkills.push({
                        id: '_addersgall',
                        instanceId: `p${pIdx}-_addersgall`,
                        name: '蛇膽存量',
                        _isAddersgallIndicator: true,
                        _pIdx: pIdx,
                        memberBg,
                        memberBorder,
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

        const activeSkillByKey = computed(() => {
            const map = new Map();
            for (const s of activeSkills.value) {
                map.set(`${s.id}|${s.memberIndex}`, s);
            }
            return map;
        });

        const skillNameById = computed(() => {
            const map = {};
            for (const job of Object.values(jobDb.value)) {
                for (const s of (job.skills || [])) map[s.id] = s.name;
            }
            return map;
        });

        // ── Damage calculation ────────────────────────────────
        // 預先計算每列的剩餘傷害，並快取為陣列；僅在 mitMap／activeSkills／timeline 變動時重算
        // 同名技能只計算一次（appliedNames 去重）；效果有 duration 限制時需檢查是否仍在效果窗內
        // 支援 bonusVal（如配對技能同時生效時的額外減傷加成）
        const damageByRow = computed(() => {
            if (!selectedDutyKey.value) return [];
            const flat = allRowsFlat.value;
            const result = new Array(flat.length).fill(0);
            const skills = activeSkills.value;

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
                if (row._isCustom) continue;
                const damages = getEffectiveVariant(row, internalIdx).damage;
                if (!damages || !damages.length) continue;
                const rowTime = rowTimes.value[internalIdx];
                let totalRemaining = 0;
                for (const hit of damages) {
                    const mitigates = (t) =>
                        t === 'mit_all' ||
                        (t === 'mit_physical' && hit.type === '物理') ||
                        (t === 'mit_magic'    && hit.type === '魔法');
                    let dmg = hit.amount * (passiveMult[hit.type] ?? passiveMult._other);
                    // 以 passiveAppliedNames 為初始值，確保 passive/active 同名去重的行為不變
                    const appliedNames = new Set(passiveAppliedNames);
                    for (const skill of nonPassiveSkills) {
                        const castTimes = castTimesCache.value.get(skill.instanceId);
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
                                        const s = activeSkillByKey.value.get(`${reqId}|${skill.memberIndex}`);
                                        return s && isSkillActive(s.instanceId, internalIdx, s);
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
        });

        const isPureShieldSkill = (skill) => {
            if (!skill?.effects?.length) return false;
            const hasShield = skill.effects.some(e => SHIELD_EFFECT_TYPES.has(e.type));
            const hasMit    = skill.effects.some(e => MIT_EFFECT_TYPES.has(e.type));
            return hasShield && !hasMit;
        };

        const shieldCoverageByRow = computed(() => {
            if (!selectedDutyKey.value) return { absorption: [], depletionAt: new Map() };
            const flat = allRowsFlat.value;
            const times = rowTimes.value;
            const postMitDmg = damageByRow.value;
            const absorption = new Array(flat.length).fill(0);
            const depletionAt = new Map();
            const shields = [];

            // 秘策（sch_rec）是一次性消耗：同一窗口內，四招（鼓舞、意氣、不屈、深謀）中
            // 任何一招的第一次施放就消耗掉效果，後續施放不再套爆擊。
            // 這裡先跨技能掃描，找出每個秘策窗口內最早的合格施放時間。
            // key: `${memberIndex}-${recWindowStartTime}` → earliest eligible cast time
            const recWindowFirstCast = new Map();
            for (const skill of activeSkills.value) {
                if (skill.recitationCritMult == null) continue;
                const recSkill = activeSkills.value.find(s => s.id === 'sch_rec' && s.memberIndex === skill.memberIndex);
                if (!recSkill) continue;
                const recCastTimes = castTimesCache.value.get(recSkill.instanceId) || [];
                const recDuration = recSkill.duration ?? 1;
                for (const ct of (castTimesCache.value.get(skill.instanceId) || [])) {
                    const rt = recCastTimes.find(r => ct >= r && ct <= r + recDuration);
                    if (rt === undefined) continue;
                    const key = `${skill.memberIndex}-${rt}`;
                    if (!recWindowFirstCast.has(key) || ct < recWindowFirstCast.get(key)) {
                        recWindowFirstCast.set(key, ct);
                    }
                }
            }

            for (const skill of activeSkills.value) {
                if (!skill.effects?.some(e => SHIELD_EFFECT_TYPES.has(e.type))) continue;
                const castTimes = castTimesCache.value.get(skill.instanceId) || [];
                if (!castTimes.length) continue;
                const critMult = skill.recitationCritMult ?? null;
                let recCastTimes = [];
                let recDuration = 1;
                if (critMult !== null) {
                    const recSkill = activeSkills.value.find(s => s.id === 'sch_rec' && s.memberIndex === skill.memberIndex);
                    if (recSkill) {
                        recCastTimes = castTimesCache.value.get(recSkill.instanceId) || [];
                        recDuration = recSkill.duration ?? 1;
                    }
                }
                for (let ci = 0; ci < castTimes.length; ci++) {
                    const ct = castTimes[ci];
                    const dur = skill.upgradeSkillId ? getTpcEffectiveDuration(skill, ct) : skill.duration;
                    if (dur <= 0) continue; // TPC 被同秒 TPG 立即消耗，跳過
                    const endTime = ct + dur;
                    const healOutMult = getHealOutMult(skill.memberIndex, ct);
                    let shieldVal = calcShieldValue(skill, healOutMult);
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
                    shields.push({ key: `${skill.instanceId}-${ci}`, castTime: ct, endTime, remaining: shieldVal, depletionRowIdx: null, exclusiveEnd });
                }
            }
            for (let i = 0; i < flat.length; i++) {
                if (flat[i]._isCustom) continue;
                if (hideTargeted.value && isTargetedAttack(flat[i], i)) continue;
                const rowTime = times[i];
                const rowDmg = postMitDmg[i];
                if (!rowDmg) continue;
                let remainingDmg = rowDmg;
                for (const sh of shields) {
                    if (sh.depletionRowIdx !== null || remainingDmg <= 0) continue;
                    if (rowTime < sh.castTime || (sh.exclusiveEnd ? rowTime >= sh.endTime : rowTime > sh.endTime)) continue;
                    const absorbed = Math.min(sh.remaining, remainingDmg);
                    sh.remaining -= absorbed;
                    remainingDmg -= absorbed;
                    absorption[i] += absorbed;
                    if (sh.remaining <= 0) sh.depletionRowIdx = i;
                }
            }
            for (const sh of shields) depletionAt.set(sh.key, sh.depletionRowIdx);
            return { absorption, depletionAt };
        });

        const calculateDamage = (_row, internalIdx) => {
            const base = damageByRow.value[internalIdx] ?? 0;
            const absorbed = shieldCoverageByRow.value.absorption[internalIdx] ?? 0;
            return Math.max(0, base - absorbed);
        };

        // ── Variant switching ─────────────────────────────────
        const switchVariant = (internalIdx, variantIdx) => {
            selectedVariants.value[`${selectedDutyKey.value}-${internalIdx}`] = variantIdx;
        };

        const getSelectedVariantIdx = (internalIdx) =>
            selectedVariants.value[`${selectedDutyKey.value}-${internalIdx}`] ?? 0;


        // ── Clear helpers ─────────────────────────────────────
        // 判斷指定技能實例是否有任何施放記錄（用於顯示清除按鈕）
        const skillHasAnyCast = (instanceId) =>
            (mitMap.value[mitKeyForSkill(instanceId)]?.length ?? 0) > 0;

        const memberHasAnyCast = (pIdx) => {
            const prefix = `${selectedDutyKey.value}-p${pIdx}-`;
            return Object.keys(mitMap.value).some(key =>
                key.startsWith(prefix) && mitMap.value[key].length > 0
            );
        };

        const clearSkill = (instanceId, skillName) => {
            if (isReadOnly.value) return;
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
            const newStateMap = { ...skillStateMap.value };
            if (key.endsWith('-sch_af')) {
                newMap[key] = [];
            } else {
                delete newMap[key];
                delete newStateMap[key];
            }
            if (hasPair) {
                const pIdxMatch = instanceId.match(/^p(\d+)-/);
                if (pIdxMatch !== null) {
                    const pIdx = pIdxMatch[1];
                    const pairKey = mitKeyForSkill(`p${pIdx}-${skill.togglesWithId}`);
                    delete newMap[pairKey];
                    delete newStateMap[pairKey];
                }
            }
            // 清除 multiState upgradeSkillId 的關聯技能（如 TPC 清除時連 TPG 一起清）
            if (skill && skill.upgradeSkillId) {
                const upgKey = mitKeyForSkill(`${instanceId.match(/^p\d+/)[0]}-${skill.upgradeSkillId}`);
                delete newMap[upgKey];
                delete newStateMap[upgKey];
            }
            mitMap.value = newMap;
            skillStateMap.value = newStateMap;
        };

        const clearMember = (pIdx, jobName) => {
            if (isReadOnly.value) return;
            if (!confirm(`確定要清除 ${jobName} 的所有施放紀錄？`)) return;
            const prefix = `${selectedDutyKey.value}-p${pIdx}-`;
            const newMap = { ...mitMap.value };
            const newStateMap = { ...skillStateMap.value };
            for (const key of Object.keys(newMap)) {
                if (key.startsWith(prefix)) delete newMap[key];
            }
            for (const key of Object.keys(newStateMap)) {
                if (key.startsWith(prefix)) delete newStateMap[key];
            }
            mitMap.value = newMap;
            skillStateMap.value = newStateMap;
        };

        const clearAll = () => {
            if (isReadOnly.value) return;
            if (!confirm('確定要清除所有施放紀錄？此操作無法復原。')) return;
            mitMap.value = {};
            skillStateMap.value = {};
        };

        // ── Share via Cloudflare Worker + KV ─────────────────
        const _applySharedData = (data) => {
            selectedDutyKey.value = data.duty || '';
            party.value = data.party || [];
            mitMap.value = migrateLegacyMitMap(data.mits || {});
            selectedVariants.value = data.selectedVariants || {};
            customRowsByDuty.value = data.customRowsByDuty || {};
            skillStateMap.value = data.skillStateMap || {};
            if (data.hideNonDmg !== undefined) hideNonDmg.value = data.hideNonDmg;
            if (data.hideTargeted !== undefined) hideTargeted.value = data.hideTargeted;
        };

        // 用 token 載入文件（供 loadFromShareParam 與 openBookmark 共用）
        const loadByToken = async (token, { updateUrl = false } = {}) => {
            try {
                const { data, error } = await getDocumentByToken(token);
                if (error || !data) return false;
                tokenMode.value       = data.token_type;
                activeToken.value     = token;
                tokenDocName.value    = data.name || '';
                tokenLoadedAt.value   = data.updated_at || '';
                tokenBaseData.value   = JSON.parse(JSON.stringify(data.data || {}));
                tokenDocOwnerId.value = data.owner_id || '';
                isViewingSharedPlan.value = true;
                _applySharedData(data.data);
                if (_realtimeChannel) { _realtimeChannel.unsubscribe(); _realtimeChannel = null; }
                tokenDocId.value = data.id || '';
                if (tokenDocId.value) _realtimeChannel = subscribeDocChannel(tokenDocId.value, _onRealtimeUpdate);
                // 更新 URL（從書籤開啟時使用）
                if (updateUrl) {
                    const params = new URLSearchParams(window.location.search);
                    params.delete('s');
                    if (data.token_type === 'edit') { params.set('edit', token); params.delete('view'); }
                    else { params.set('view', token); params.delete('edit'); }
                    history.pushState(null, '', window.location.pathname + '?' + params.toString());
                }
                // 若已登入則檢查是否已加入書籤
                if (currentUser.value && tokenDocId.value) {
                    const { data: bm } = await checkBookmark(currentUser.value.id, tokenDocId.value);
                    isBookmarked.value = !!bm;
                } else {
                    isBookmarked.value = false;
                }
                return true;
            } catch (e) {
                console.error('載入分享連結失敗', e);
                return false;
            }
        };

        const loadFromShareParam = async () => {
            const params = new URLSearchParams(window.location.search);
            const shareId   = params.get('s');
            const editToken = params.get('edit');
            const viewToken = params.get('view');

            // Supabase token-based share
            if (editToken || viewToken) {
                return loadByToken(editToken || viewToken);
            }

            // Legacy Cloudflare Worker share
            if (!shareId) return false;
            try {
                const res = await fetch(`${WORKER_URL}/load/${shareId}`);
                if (!res.ok) return false;
                const data = await res.json();
                isViewingSharedPlan.value = true;
                _applySharedData(data);
                return true;
            } catch (e) {
                isViewingSharedPlan.value = false;
                console.error('載入分享連結失敗', e);
                return false;
            }
        };

        // 加入書籤（非擁有者，在分享頁面點擊）
        const addBookmarkAction = async () => {
            if (!currentUser.value || !tokenDocId.value || bookmarkLoading.value) return;
            bookmarkLoading.value = true;
            try {
                const { error } = await addBookmark(currentUser.value.id, tokenDocId.value, activeToken.value, tokenMode.value);
                if (!error) {
                    isBookmarked.value = true;
                    await fetchDocuments();
                } else {
                    alert('加入書籤失敗，請稍後再試。');
                }
            } finally {
                bookmarkLoading.value = false;
            }
        };

        // 移除書籤（工具列按鈕）
        const removeBookmarkAction = async () => {
            if (!currentUser.value || !tokenDocId.value || bookmarkLoading.value) return;
            if (!confirm('確定要移出書籤？')) return;
            bookmarkLoading.value = true;
            try {
                const { error } = await removeBookmark(currentUser.value.id, tokenDocId.value);
                if (!error) {
                    isBookmarked.value = false;
                    await fetchDocuments();
                } else {
                    alert('移除書籤失敗，請稍後再試。');
                }
            } finally {
                bookmarkLoading.value = false;
            }
        };

        // 移除書籤（從側邊欄清單操作）
        const removeBookmarkFromSidebar = async (bm) => {
            if (!confirm(`確定要移出書籤「${bm.name}」？`)) return;
            const { error } = await removeBookmark(currentUser.value.id, bm.document_id);
            if (!error) {
                if (isBookmarked.value && tokenDocId.value === bm.document_id) isBookmarked.value = false;
                await fetchDocuments();
            } else {
                alert('移除書籤失敗，請稍後再試。');
            }
        };

        // 從側邊欄開啟書籤（用 token 重新載入，不換頁）
        const openBookmark = async (bm) => {
            sidebarOpen.value = false;
            await loadByToken(bm.token, { updateUrl: true });
        };

        const saveSharedPlanToLocal = () => {
            isViewingSharedPlan.value = false;
            localStorage.setItem('ffxiv_planner_data', JSON.stringify({
                selectedDutyKey: selectedDutyKey.value,
                party: party.value,
                mitMap: mitMap.value,
                selectedVariants: selectedVariants.value,
                customRowsByDuty: customRowsByDuty.value,
                skillStateMap: skillStateMap.value,
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

        // 將 rawConflicts 陣列加上可讀的顯示資訊，供 modal 使用
        const _enrichConflicts = (rawConflicts, dbData, localData) => {
            const toTimes = (indices) =>
                [...(indices || [])].sort((a, b) => a - b)
                    .map(i => allRowsFlat.value[i]?.hitTime || `#${i}`);

            const parseMitKey = (key) => {
                const known = dutyIndex.value.duties.find(d => key.startsWith(d.key + '-'));
                if (known) {
                    const m = key.slice(known.key.length + 1).match(/^p(\d+)-(.+)$/);
                    if (m) return { pIdx: parseInt(m[1]), skillInstId: m[2] };
                }
                const m = key.match(/^.+-p(\d+)-(.+)$/);
                return m ? { pIdx: parseInt(m[1]), skillInstId: m[2] } : null;
            };

            return rawConflicts.map(c => {
                if (c.type === 'skill') {
                    const parsed = parseMitKey(c.key);
                    const pIdx = parsed?.pIdx ?? 0;
                    const skillId = (parsed?.skillInstId ?? c.key).replace(/-v\d+$/, '');
                    const skillName = skillNameById.value[skillId] || skillId;
                    const jobKey = localData.party?.[pIdx] || dbData.party?.[pIdx];
                    const jobName = jobKey ? (jobDb.value[jobKey]?.name || jobKey) : '';
                    return {
                        ...c,
                        label: `P${pIdx + 1}${jobName ? ' ' + jobName : ''}「${skillName}」`,
                        dbDisplay:    toTimes(dbData.mits?.[c.key]),
                        localDisplay: toTimes(localData.mits?.[c.key]),
                        choice: 'db',
                    };
                }
                if (c.type === 'party') {
                    const n = k => jobDb.value[k]?.name || k;
                    return {
                        ...c,
                        label: '職業配置',
                        dbDisplay:    (dbData.party    || []).map((k, i) => `P${i + 1} ${n(k)}`),
                        localDisplay: (localData.party || []).map((k, i) => `P${i + 1} ${n(k)}`),
                        choice: 'db',
                    };
                }
                if (c.type === 'variant') {
                    const row = allRowsFlat.value[parseInt(c.key)];
                    const vars = row?.variants || [];
                    const n = idx => vars[idx]?.skill || `選項 ${idx}`;
                    return {
                        ...c,
                        label: `招式變體：${row?.skill || `列 #${c.key}`}`,
                        dbDisplay:    [n(dbData.selectedVariants?.[c.key])],
                        localDisplay: [n(localData.selectedVariants?.[c.key])],
                        choice: 'db',
                    };
                }
                if (c.type === 'customRow') {
                    const dr = (dbData.customRowsByDuty?.[c.duty]    || []).find(r => r.id === c.id);
                    const lr = (localData.customRowsByDuty?.[c.duty] || []).find(r => r.id === c.id);
                    return {
                        ...c,
                        label: `自訂時間點（${getDutyDisplayName(c.duty)}）`,
                        dbDisplay:    dr ? [`${dr.hitTime}　${dr.skill || '（無名稱）'}`] : ['（已刪除）'],
                        localDisplay: lr ? [`${lr.hitTime}　${lr.skill || '（無名稱）'}`] : ['（已刪除）'],
                        choice: 'db',
                    };
                }
                if (c.type === 'hideNonDmg')   return { ...c, label: '顯示設定：隱藏無傷害招式', dbDisplay: [dbData.hideNonDmg    ? '開啟' : '關閉'], localDisplay: [localData.hideNonDmg    ? '開啟' : '關閉'], choice: 'db' };
                if (c.type === 'hideTargeted') return { ...c, label: '顯示設定：隱藏單體攻擊',   dbDisplay: [dbData.hideTargeted  ? '開啟' : '關閉'], localDisplay: [localData.hideTargeted  ? '開啟' : '關閉'], choice: 'db' };
                return { ...c, label: c.key || c.type, dbDisplay: [], localDisplay: [], choice: 'db' };
            });
        };

        const _commitSave = async (dataToSave) => {
            const { error } = await updateByEditToken(activeToken.value, dataToSave);
            if (error) throw error;
            _applySharedData(dataToSave);
            const { data: saved } = await getDocumentByToken(activeToken.value);
            if (saved) {
                tokenLoadedAt.value = saved.updated_at;
                tokenBaseData.value = JSON.parse(JSON.stringify(dataToSave));
            }
            realtimeNotif.value = null;
            // 廣播給其他編輯者／唯讀者
            if (_realtimeChannel && saved) {
                _realtimeChannel.send({
                    type: 'broadcast',
                    event: 'doc_updated',
                    payload: { data: dataToSave, updatedAt: saved.updated_at },
                });
            }
            if (_toastTimer) clearTimeout(_toastTimer);
            shareToastVisible.value = true;
            _toastTimer = setTimeout(() => { shareToastVisible.value = false; }, 2000);
        };

        const saveByEditToken = async () => {
            if (tokenMode.value !== 'edit' || tokenSaving.value) return;
            tokenSaving.value = true;
            try {
                const { data: latest, error: fetchErr } = await getDocumentByToken(activeToken.value);
                if (fetchErr || !latest) throw new Error('無法取得文件資訊');
                const local = buildPayload();
                if (latest.updated_at !== tokenLoadedAt.value) {
                    const { merged: autoMerged, conflicts: rawConflicts } = mergePayloads(
                        tokenBaseData.value || {}, latest.data || {}, local
                    );
                    if (rawConflicts.length > 0) {
                        conflictDialog.value = {
                            open: true,
                            enriched: _enrichConflicts(rawConflicts, latest.data || {}, local),
                            autoMerged,
                            dbData:    latest.data || {},
                            localData: local,
                        };
                        return; // 等 user 在 modal 決定後再繼續
                    }
                    await _commitSave(autoMerged);
                } else {
                    await _commitSave(local);
                }
            } catch (e) {
                console.error(e);
                alert('儲存失敗，請稍後再試。');
            } finally {
                tokenSaving.value = false;
            }
        };

        const resolveConflictDialog = async () => {
            const { enriched, autoMerged, dbData, localData } = conflictDialog.value;
            const final = JSON.parse(JSON.stringify(autoMerged));

            for (const c of enriched) {
                if (c.choice !== 'local') continue;
                if (c.type === 'skill') {
                    const lv = localData.mits?.[c.key] || [];
                    if (lv.length) final.mits[c.key] = lv; else delete final.mits[c.key];
                } else if (c.type === 'party') {
                    final.party = localData.party || [];
                } else if (c.type === 'variant') {
                    const lv = localData.selectedVariants?.[c.key];
                    if (lv !== undefined) final.selectedVariants[c.key] = lv;
                    else delete final.selectedVariants[c.key];
                } else if (c.type === 'customRow') {
                    const lr = (localData.customRowsByDuty?.[c.duty] || []).find(r => r.id === c.id);
                    const rows = final.customRowsByDuty[c.duty] || [];
                    const ei = rows.findIndex(r => r.id === c.id);
                    if (lr) { if (ei >= 0) rows[ei] = lr; else rows.push(lr); }
                    else if (ei >= 0) rows.splice(ei, 1);
                    if (rows.length) final.customRowsByDuty[c.duty] = rows;
                    else delete final.customRowsByDuty[c.duty];
                } else if (c.type === 'hideNonDmg')   { final.hideNonDmg   = localData.hideNonDmg; }
                  else if (c.type === 'hideTargeted') { final.hideTargeted = localData.hideTargeted; }
            }

            conflictDialog.value = { open: false, enriched: [], autoMerged: null, dbData: null, localData: null };
            tokenSaving.value = true;
            try { await _commitSave(final); }
            catch (e) { console.error(e); alert('儲存失敗，請稍後再試。'); }
            finally { tokenSaving.value = false; }
        };

        const cancelConflictDialog = () => {
            conflictDialog.value = { open: false, enriched: [], autoMerged: null, dbData: null, localData: null };
        };

        const _onRealtimeUpdate = ({ data: remoteData, updatedAt }) => {
            if (updatedAt === tokenLoadedAt.value) return; // 自己廣播的 echo，忽略
            if (tokenMode.value === 'read') {
                _applySharedData(remoteData);
                tokenLoadedAt.value = updatedAt;
                tokenBaseData.value = JSON.parse(JSON.stringify(remoteData || {}));
                realtimeNotif.value = { type: 'auto' };
                clearTimeout(_realtimeNotifTimer);
                _realtimeNotifTimer = setTimeout(() => { realtimeNotif.value = null; }, 3000);
                return;
            }
            // 編輯模式：提示使用者儲存時會自動 merge
            realtimeNotif.value = { type: 'pending' };
        };

        const setAllConflictChoices = (choice) => {
            conflictDialog.value.enriched.forEach(c => { c.choice = choice; });
        };

        const pullLatest = async () => {
            if (tokenMode.value !== 'edit' || tokenSaving.value) return;
            tokenSaving.value = true;
            try {
                const { data: latest, error } = await getDocumentByToken(activeToken.value);
                if (error || !latest) throw new Error('無法取得文件資訊');
                if (latest.updated_at === tokenLoadedAt.value) {
                    realtimeNotif.value = null;
                    return;
                }
                const local = buildPayload();
                const { merged, conflicts: rawConflicts } = mergePayloads(
                    tokenBaseData.value || {}, latest.data || {}, local
                );
                if (rawConflicts.length === 0) {
                    _applySharedData(merged);
                    tokenLoadedAt.value = latest.updated_at;
                    tokenBaseData.value = JSON.parse(JSON.stringify(merged));
                    realtimeNotif.value = null;
                } else {
                    conflictDialog.value = {
                        open: true,
                        enriched: _enrichConflicts(rawConflicts, latest.data || {}, local),
                        autoMerged: merged,
                        dbData: latest.data || {},
                        localData: local,
                    };
                }
            } catch (e) {
                console.error(e);
                alert('載入最新版本失敗，請稍後再試。');
            } finally {
                tokenSaving.value = false;
            }
        };

        const _copyToClipboard = async (url) => {
            try {
                await navigator.clipboard.writeText(url);
            } catch {
                prompt('複製以下連結：', url);
            }
            if (_toastTimer) clearTimeout(_toastTimer);
            shareToastVisible.value = true;
            _toastTimer = setTimeout(() => { shareToastVisible.value = false; }, 2000);
        };

        const copyEditLink = (doc) => _copyToClipboard(buildEditUrl(doc.edit_token));
        const copyReadLink = (doc) => _copyToClipboard(buildReadUrl(doc.read_token));

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
                skillStateMap: skillStateMap.value,
            }));
        }, { deep: true });

        watch([hideNonDmg, hideTargeted, compactMode], syncUrlParams);

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

        // ── Discord Auth ──────────────────────────────────────
        sbAuthChange((_event, session) => {
            currentUser.value = session?.user ?? null;
        });

        const loginWithDiscord = () => signInWithDiscord();
        const logoutUser = async () => {
            await signOut();
            currentUser.value = null;
        };
        const discordAvatarUrl = computed(() =>
            currentUser.value?.user_metadata?.avatar_url ?? null
        );
        const discordUsername = computed(() =>
            currentUser.value?.user_metadata?.full_name ||
            currentUser.value?.user_metadata?.user_name ||
            '使用者'
        );

        // ── 側邊欄 / 我的範本 ─────────────────────────────────
        const sidebarOpen = ref(false);
        const myDocuments = ref([]);
        const docsLoading = ref(false);
        const expandedDutySections = ref({});

        const fetchDocuments = async () => {
            if (!currentUser.value) return;
            docsLoading.value = true;
            const [ownedRes, bookmarkedRes] = await Promise.all([
                fetchMyDocuments(),
                fetchBookmarkedDocuments(currentUser.value.id),
            ]);
            if (!ownedRes.error && ownedRes.data) myDocuments.value = ownedRes.data;
            if (!bookmarkedRes.error && bookmarkedRes.data) bookmarkedDocuments.value = bookmarkedRes.data;
            docsLoading.value = false;
        };

        const documentsByDuty = computed(() => {
            const groups = {};
            for (const doc of myDocuments.value) {
                if (!groups[doc.duty_key]) groups[doc.duty_key] = [];
                groups[doc.duty_key].push(doc);
            }
            return groups;
        });

        const bookmarksByDuty = computed(() => {
            const groups = {};
            for (const bm of bookmarkedDocuments.value) {
                if (!groups[bm.duty_key]) groups[bm.duty_key] = [];
                groups[bm.duty_key].push(bm);
            }
            return groups;
        });

        const getDutyDisplayName = (dutyKey) =>
            dutyIndex.value.duties.find(d => d.key === dutyKey)?.name ?? dutyKey;

        const saveCurrentTemplate = async () => {
            if (!currentUser.value || !selectedDutyKey.value) return;
            const defaultName = getDutyDisplayName(selectedDutyKey.value) + ' 範本';
            const name = prompt('請輸入範本名稱：', defaultName);
            if (!name || !name.trim()) return;
            const { error } = await createDocument(currentUser.value.id, selectedDutyKey.value, name.trim(), buildPayload());
            if (!error) {
                await fetchDocuments();
                expandedDutySections.value[selectedDutyKey.value] = true;
            } else {
                alert('儲存失敗，請稍後再試。');
            }
        };

        const loadTemplate = (doc) => {
            if (!confirm(`將載入「${doc.name}」範本資料，目前未儲存的變更將會遺失。`)) return;
            _applySharedData(doc.data);
            tokenMode.value       = 'edit';
            activeToken.value     = doc.edit_token || '';
            tokenDocName.value    = doc.name;
            tokenDocId.value      = doc.id || '';
            tokenDocOwnerId.value = currentUser.value?.id || '';
            tokenLoadedAt.value   = doc.updated_at || '';
            tokenBaseData.value   = JSON.parse(JSON.stringify(doc.data || {}));
            isViewingSharedPlan.value = true;
            isBookmarked.value    = false;
            realtimeNotif.value   = null;
            if (_realtimeChannel) { _realtimeChannel.unsubscribe(); _realtimeChannel = null; }
            if (tokenDocId.value) _realtimeChannel = subscribeDocChannel(tokenDocId.value, _onRealtimeUpdate);
            const params = new URLSearchParams(window.location.search);
            params.delete('s');
            params.delete('view');
            if (doc.edit_token) { params.set('edit', doc.edit_token); } else { params.delete('edit'); }
            const qs = params.toString();
            history.pushState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
            sidebarOpen.value = false;
        };

        const buildPayload = () => ({
            duty: selectedDutyKey.value,
            party: party.value,
            mits: mitMap.value,
            selectedVariants: selectedVariants.value,
            customRowsByDuty: customRowsByDuty.value,
            skillStateMap: skillStateMap.value,
            hideNonDmg: hideNonDmg.value,
            hideTargeted: hideTargeted.value,
        });

        const updateTemplate = async (doc) => {
            if (!confirm(`用目前狀態覆蓋「${doc.name}」？`)) return;
            const { error } = await updateDocument(doc.id, buildPayload());
            if (!error) {
                await fetchDocuments();
            } else {
                alert('更新失敗，請稍後再試。');
            }
        };

        const deleteTemplate = async (doc) => {
            if (!confirm(`確定要刪除「${doc.name}」？`)) return;
            const { error } = await deleteDocument(doc.id);
            if (!error) {
                await fetchDocuments();
            } else {
                alert('刪除失敗，請稍後再試。');
            }
        };

        const renameTemplate = async (doc) => {
            const newName = prompt('請輸入新名稱：', doc.name);
            if (!newName || !newName.trim() || newName.trim() === doc.name) return;
            const { error } = await renameDocument(doc.id, newName.trim());
            if (!error) {
                await fetchDocuments();
            } else {
                alert('重新命名失敗，請稍後再試。');
            }
        };

        const shareLinksDocId = ref(null);
        const toggleShareLinks = (doc) => {
            shareLinksDocId.value = shareLinksDocId.value === doc.id ? null : doc.id;
        };

        const toggleDutySection = (dutyKey) => {
            expandedDutySections.value[dutyKey] = !expandedDutySections.value[dutyKey];
        };

        watch(currentUser, async (user) => {
            if (user) {
                await fetchDocuments();
                // 若此時正在瀏覽分享頁面，更新書籤狀態
                if (tokenDocId.value) {
                    const { data: bm } = await checkBookmark(user.id, tokenDocId.value);
                    isBookmarked.value = !!bm;
                }
            } else {
                myDocuments.value = [];
                bookmarkedDocuments.value = [];
                isBookmarked.value = false;
                sidebarOpen.value = false;
            }
        });

        return {
            categoryDb, jobDb, dutyDb, dutyIndex,
            selectedDutyKey, party, mitMap,
            hideNonDmg, hideTargeted, compactMode, currentCat,
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
            getAddersgallStacksAt, isSkillAddersgallDepleted,
            skillHasAnyCast, clearSkill, memberHasAnyCast, clearMember, clearAll,
            // Custom rows
            customRowsByDuty, customRowDraftTimes,
            insertCustomRowBetween, removeCustomRow, updateCustomRow,
            onCustomRowTimeInput, onCustomRowTimeBlur,
            isRowVisible,
            // Floating insert button
            hoverInsert, onRowMouseMove, onRowMouseLeave, onInsertBtnEnter, onInsertBtnLeave,
            skillTooltip, showSkillTooltip, hideSkillTooltip, keepSkillTooltip, skillNameById,
            darkMode, toggleDarkMode, customRowStyle,
            currentUser, authLoading, loginWithDiscord, logoutUser, discordAvatarUrl, discordUsername,
            sidebarOpen, myDocuments, docsLoading, expandedDutySections, documentsByDuty,
            getDutyDisplayName, saveCurrentTemplate, updateTemplate, loadTemplate, deleteTemplate, renameTemplate, toggleDutySection,
            copyEditLink, copyReadLink, shareLinksDocId, toggleShareLinks,
            tokenMode, tokenDocName, tokenSaving, isReadOnly, saveByEditToken, pullLatest,
            conflictDialog, resolveConflictDialog, cancelConflictDialog, setAllConflictChoices,
            realtimeNotif,
            isDocOwner, isBookmarked, bookmarkLoading, bookmarkedDocuments, bookmarksByDuty,
            addBookmarkAction, removeBookmarkAction, removeBookmarkFromSidebar, openBookmark,
            raidParams, raidParamsDialog, raidParamsDraft,
            openRaidParamsDialog, closeRaidParamsDialog, saveRaidParams, resetRaidParamsDraftToDefault,
            calcShieldDisplay,
        };
    }
}).mount('#app');
