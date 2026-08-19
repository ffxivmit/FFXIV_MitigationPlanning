# 領域詞彙（Domain Glossary）

FFXIV 團隊減傷規劃工具。以下詞彙在架構討論、commit、程式碼命名時統一沿用。

## 核心概念

- **時間軸（timeline）** — 一個副本（duty）固定的敵方攻擊（hit）序列，每個 hit 有固定時間點、傷害量、屬性（物理/魔法）。存於 `src/duty/**/*.json`。
- **技能實例（skill instance）** — 某個隊伍成員在特定時間點施放的某個技能，帶有 `instanceId`（`p{隊員index}-{技能id}`）。已套用等級限制（`levelRestrictions`）後的最終版本，才算「技能實例」。
- **減傷帳本（mitigation ledger）** — 給定一組已解析的技能實例、時間軸、團隊參數，計算每個時間點的實際傷害、護盾吸收量、技能啟用/冷卻狀態，邏輯收在 `src/mitigationLedger.js`。護盾覆蓋範圍的內部資料（`ctx.shieldCoverage.depletionAt`）不對外開放直接讀取——「這一列護盾是否仍覆蓋」統一透過匯出函式 `isShieldCoverageActiveAt` 查詢，中間學派衍生護盾（吉星相位/陽星合相）的完整判斷邏輯收在匯出函式 `isNeutralSectShieldActiveAt`。同一擊同時被多個護盾覆蓋時，扣除順序依遊戲內固定的護盾優先序表（`SHIELD_PRIORITY_GROUPS`）排序，同優先度並列則依施放時間排序，而非任意的技能陣列建立順序。`skill.personal` 與 `effect.selfOnly` 是兩層獨立的「只對自己生效」旗標，不要混用：`skill.personal` 是整招層級，會連動 `main.js` 收合檢視的預設顯示邏輯（personal 技能預設收合時隱藏）；`effect.selfOnly` 只限定單一效果（目前僅 `heal_out_magic` 有讀取），用在「技能本身有其他全隊效果、但補量部分明確只認施放者自己」的情境（如中間學派、節制），避免整招標成 personal 而動到不該動的 UI 預設行為。

- **計畫快照（plan snapshot）** — 一份減傷計畫在「本機儲存 / 分享連結（legacy Cloudflare Worker `?s=`、Supabase edit/view token）/ 匯出匯入 JSON」之間傳遞時共用的統一資料形狀：`duty`、`party`、`mits`、`notes`、`selectedVariants`、`customRowsByDuty`、`skillStateMap` 七個欄位。不含 `hideNonDmg`/`hideTargeted`——那兩個是純 client 端顯示開關，靠 URL 參數記憶，不屬於計畫的一部分。序列化／還原邏輯在 `src/planSnapshot.js`：`serializePlanSnapshot`/`applyPlanSnapshot` 為純函式，`applyPlanSnapshot` 內建自動跑 legacy mitMap 格式轉換，並同時接受本機 localStorage 舊欄位命名（`selectedDutyKey`/`mitMap`）與可攜格式（`duty`/`mits`），確保既有使用者資料能正常還原。**不處理**存到 Supabase「範本」的 `buildPayload`（main.js）——那條路徑目前刻意維持獨立，未收斂進本模組。
- **施放紀錄重新索引（cast record reindex）** — `mitMap`/`skillStateMap`/`notesMap` 這三個以「技能實例 + 位置」為 key 的紀錄，在**隊伍成員**增刪/拖曳重排、或**自訂列**被刪除時，key 內嵌的位置片段（member 軸的 `-p{index}-`、row 軸的列索引尾段）都要跟著整批重寫，否則紀錄會錯位到別的成員/別的列。這段重映射邏輯收在 `src/castRecordReindex.js`（純函式，`reindexCastRecordsByMember`/`reindexCastRecordsByRemovedRow`），成員增刪/重排與自訂列刪除各自呼叫，不再各自重寫一份。
- **三向合併（three-way merge）** — 共同編輯（Supabase edit token）儲存時遇到別人也存過的情況，把 `base`（上次讀取的計畫快照）／`dbData`（伺服器目前版本）／`local`（本機未儲存版本）三份快照比對：不衝突的欄位自動合併，同一欄位雙方都改且結果不同才標記為衝突、交給使用者在對話框裡選。這段純函式邏輯收在 `src/planMerge.js`：`mergePayloads(base, dbData, local)` 算出自動合併結果與衝突清單，`applyConflictChoices(autoMerged, enriched, localData)` 把使用者在對話框對每個衝突欄位選的 `local`/`db` 套用上去、回傳最終版本（不 mutate 輸入）。**不處理**衝突的顯示格式化——把 `{ type, key }` 轉成中文標籤（技能名稱、職業名稱等）給對話框顯示的邏輯（`_enrichConflicts`）留在 main.js，跟減傷帳本「不處理顯示格式」是同一個原則。

## 容易混淆的技能／狀態命名

- **輸血**（`sge_haima`）／**泛輸血**（`sge_panha`）— 賢者（SGE）的**技能名稱**。
- **血印**／**泛血印** — 輸血／泛輸血各自附加的**狀態（buff）名稱**，不是技能本身。機制：初始護盾 + 5 階血印/泛血印 buff，共可承受 6 次「護盾歸零」事件；每次歸零若還有 buff 次數就原地補滿護盾、消耗 1 次 buff，單次傷害只會消耗當前這一層，不會在同一次傷害判定裡打穿多層。
- **坦培拉塗層**（`pct_tpc`）／**油性坦培拉塗層**（`pct_tpg`）— **繪靈法師（PCT）**的技能升級機制（`upgradeSkillId`/`multiState`/`conditionSkillId`），塗層被油性塗層立即消耗取代，不是疊加。
- **秘策**（`sch_rec`）— 學者（SCH）技能，效果窗口內首次施放的治療/護盾技能吃爆擊加成，是跨技能、跨時間窗的一次性判定。
- **活化**（`sge_Zoe`）— 賢者（SGE）技能，效果窗口內第一次合格的治療施放吃補量加成，同樣是一次性消耗。
- **中間學派**（`ast_netl_S`，NSS）— 占星術士（AST）技能，效果期間施放特定技能會附加護盾；同一成員身上多個 NSS 護盾不疊加，只取初始值最高者。

## 部署與快取版本

專案沒有 build tool，`sw.js` 是純手寫的 Service Worker，沒有自動化的版號管理，**修改人（含 AI）必須自己意識到要不要動版號**，否則使用者端會吃到舊快取。

- **`sw.js` 是 cache-first**：同源 GET 請求（`main.js`、`css/*.css`、`src/**/*.json`、技能圖示等）優先吃瀏覽器快取。**任何一次部署，只要動到這些同源靜態資源的內容，都要把 `sw.js` 開頭的 `CACHE_VERSION` 往上加一版**，下次啟用時才會清掉舊快取。
- **`css/style-tw.css` 是手動產生的靜態檔**，取代原本會拖慢載入的 `cdn.tailwindcss.com` 瀏覽器即時編譯，用 [Tailwind 官方 standalone CLI](https://github.com/tailwindlabs/tailwindcss/releases)（不需要 Node/npm）掃描 `index.html` 產生：
  ```
  tailwindcss -i css/tailwind-input.css -o css/style-tw.css --minify
  ```
  **`index.html` 新增/修改 Tailwind class 之後都要重新執行這行指令**，否則新 class 不會出現在畫面上；重新產生後別忘了同時把 `CACHE_VERSION` 往上加一版。
  - **目前是 Tailwind v4**：寫新 class 不要用 v3 語法（網路上很多舊教學還是 v3 寫法）。兩個已知差異：透明度用 `bg-red-500/60` 斜線語法，不是 `bg-opacity-*`（v4 移除了）；`css/tailwind-input.css` 裡的 `@layer base { button, [role="button"] { cursor: pointer } }` 是刻意補上去還原 v3 preflight 行為的，不是多餘的，不要誤刪。
- **目錄結構**：`index.html`/`sw.js`/`wrangler.toml`/`main.js` 固定在根目錄（進入點、Service Worker 作用範圍、Cloudflare Worker 慣例）；樣式在 `css/`，Supabase 參考 SQL 在 `supabase/`（純參考檔，程式碼不讀取），這份文件在 `docs/`。
