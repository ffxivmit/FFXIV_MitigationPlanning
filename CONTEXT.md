# 領域詞彙（Domain Glossary）

FFXIV 團隊減傷規劃工具。以下詞彙在架構討論、commit、程式碼命名時統一沿用。

## 核心概念

- **時間軸（timeline）** — 一個副本（duty）固定的敵方攻擊（hit）序列，每個 hit 有固定時間點、傷害量、屬性（物理/魔法）。存於 `src/duty/**/*.json`。
- **技能實例（skill instance）** — 某個隊伍成員在特定時間點施放的某個技能，帶有 `instanceId`（`p{隊員index}-{技能id}`）。已套用等級限制（`levelRestrictions`）後的最終版本，才算「技能實例」。
- **減傷帳本（mitigation ledger）** — 給定一組已解析的技能實例、時間軸、團隊參數，計算每個時間點的實際傷害、護盾吸收量、技能啟用/冷卻狀態的模組。原本以 `damageByRow`/`shieldCoverageByRow`/`isSkillActive` 等函式形式散落在 `main.js` 的 `setup()` 內，正在抽成獨立模組 `src/mitigationLedger.js`。

## 容易混淆的技能／狀態命名

- **輸血**（`sge_haima`）／**泛輸血**（`sge_panha`）— 賢者（SGE）的**技能名稱**。
- **血印**／**泛血印** — 輸血／泛輸血各自附加的**狀態（buff）名稱**，不是技能本身。機制：初始護盾 + 5 階血印/泛血印 buff，共可承受 6 次「護盾歸零」事件；每次歸零若還有 buff 次數就原地補滿護盾、消耗 1 次 buff，單次傷害只會消耗當前這一層，不會在同一次傷害判定裡打穿多層。
- **坦培拉塗層**（`pct_tpc`）／**油性坦培拉塗層**（`pct_tpg`）— **繪靈法師（PCT）**的技能升級機制（`upgradeSkillId`/`multiState`/`conditionSkillId`），塗層被油性塗層立即消耗取代，不是疊加。
- **秘策**（`sch_rec`）— 學者（SCH）技能，效果窗口內首次施放的治療/護盾技能吃爆擊加成，是跨技能、跨時間窗的一次性判定。
- **活化**（`sge_Zoe`）— 賢者（SGE）技能，效果窗口內第一次合格的治療施放吃補量加成，同樣是一次性消耗。
- **中間學派**（`ast_netl_S`，NSS）— 占星術士（AST）技能，效果期間施放特定技能會附加護盾；同一成員身上多個 NSS 護盾不疊加，只取初始值最高者。
